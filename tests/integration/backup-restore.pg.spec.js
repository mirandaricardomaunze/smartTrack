/**
 * @file backup-restore.pg.spec.js
 * @description Ensaio real de cópia e restauro contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * Uma cópia nunca restaurada é uma suposição. Este teste faz o ciclo inteiro com
 * `pg_dump`/`pg_restore` de verdade: emite um documento fiscal assinado, copia,
 * restaura para uma base descartável, e confirma que as linhas voltaram **e** que
 * a cadeia de hash do arquivo continua válida — que é o que distingue "os dados
 * voltaram" de "o arquivo fiscal ainda se defende numa inspeção".
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `pg_dump`/`pg_restore` no PATH (senão a suite é saltada)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanyFactory } from '../harness/factories/company.factory';
import { CompanyProfileFactory } from '../harness/factories/company-profile.factory';
import { FiscalDocumentFactory } from '../harness/factories/fiscal.factory';
import { BackupFactory } from '../harness/factories/backup.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable, baseCredentials } = require('./helpers/pg-env.js');

useDatabase('track');
const pgUp = await isPostgresReachable();
const toolsUp = spawnSync('pg_dump', ['--version']).status === 0
  && spawnSync('pg_restore', ['--version']).status === 0;
const disponivel = pgUp && toolsUp;

const policy    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/backup.policy`) : null;
// A mesma regra que o ensaio usa para separar "o restauro partiu" de "já vinha
// partido" — reutilizada, para o teste não ter uma segunda definição da regra.
const { compareChains } = disponivel ? require(`${ROOT}/backend/api-gateway/scripts/backup-verify`) : {};
const invoices  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const companies = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/companies.service`) : null;
const audit     = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/audit.service`) : null;
const repo      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY = 'company-itest-backup';
const RESTORE_DB = 'sistematrack_itest_restore';
const SERIES = 'K';

let backupDir;
let issuedNumber;

function asCompany(fn) {
  return tenant.runWithCompany(COMPANY, fn);
}

/** Ambiente das ferramentas do Postgres, apontado a uma base. */
function pgEnv(database) {
  const cred = baseCredentials();
  return {
    ...process.env,
    PGHOST: cred.host, PGPORT: String(cred.port), PGUSER: cred.user, PGPASSWORD: cred.password,
    PGDATABASE: database,
  };
}

function psql(database, sql) {
  const r = spawnSync('psql', ['-tAc', sql], { env: pgEnv(database), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(String(r.stderr).trim());
  return String(r.stdout).trim();
}

async function cleanup() {
  await pool.query('DELETE FROM audit_events WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM invoices WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM document_series WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM company_profiles WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
  try { psql('postgres', `DROP DATABASE IF EXISTS ${RESTORE_DB}`); } catch { /* já não existe */ }
}

describe.skipIf(!disponivel)('api-gateway · cópia e restauro · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sistematrack-backup-'));

    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY, name: 'Arquivo Lda', slug: COMPANY }));
    await companies.updateProfile(COMPANY, CompanyProfileFactory.build({ legal_name: 'Arquivo Lda' }));

    // Documento fiscal assinado + evento de auditoria: é o que precisa de sobreviver.
    const invoice = await asCompany(() => invoices.issueDocument(FiscalDocumentFactory.build({ series: SERIES })));
    issuedNumber = invoice.number;
    await asCompany(() => audit.record({ action: 'backup.itest', summary: 'evento para o ensaio de restauro' }));
  }, 60_000);

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    if (backupDir) fs.rmSync(backupDir, { recursive: true, force: true });
    await pool.end();
  }, 60_000);

  it('should write a dump and a manifest that describes it', () => {
    const result = spawnSync(process.execPath, ['scripts/backup.js'], {
      cwd: path.join(ROOT, 'backend/api-gateway'),
      env: { ...pgEnv('track'), BACKUP_DIR: backupDir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    const dumps = fs.readdirSync(backupDir).filter((f) => f.endsWith('.dump'));
    expect(dumps).toHaveLength(1);

    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, `${dumps[0]}.json`), 'utf8'));
    expect(manifest.database).toBe('track');
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.bytes).toBeGreaterThan(0);
    // As tabelas que doem estão contadas no manifesto.
    expect(manifest.row_counts.invoices).toBeGreaterThan(0);
    expect(manifest.row_counts.audit_events).toBeGreaterThan(0);
  }, 120_000);

  it('should restore the fiscal document, signature and all', () => {
    const dump = fs.readdirSync(backupDir).find((f) => f.endsWith('.dump'));

    psql('postgres', `DROP DATABASE IF EXISTS ${RESTORE_DB}`);
    psql('postgres', `CREATE DATABASE ${RESTORE_DB}`);
    spawnSync('pg_restore', ['--no-owner', '--no-privileges', `--dbname=${RESTORE_DB}`, path.join(backupDir, dump)], {
      env: pgEnv(RESTORE_DB), encoding: 'utf8',
    });

    const restored = psql(RESTORE_DB, `SELECT number, hash IS NOT NULL FROM invoices WHERE company_id = '${COMPANY}' LIMIT 1`);
    expect(restored).toContain(issuedNumber);
    expect(restored).toContain('t');   // a assinatura veio com o documento
  }, 120_000);

  it('should keep the chains valid in the restored database', () => {
    /**
     * Corre a verificação do próprio sistema contra uma base.
     *
     * Devolve o estado CADEIA A CADEIA, e não um booleano global: uma cadeia
     * partida na origem é copiada fielmente para o restauro, e exigir o global
     * fazia este teste depender da limpeza de todo o histórico da base de
     * desenvolvimento em vez de testar o que lhe compete — se o restauro
     * preserva o que recebeu.
     */
    const probe = (database) => {
      const check = spawnSync(process.execPath, ['-e', `
        process.env.PGDATABASE = ${JSON.stringify(database)};
        const invoices = require(${JSON.stringify(path.join(ROOT, 'backend/api-gateway/src/application/invoices.service'))});
        const audit = require(${JSON.stringify(path.join(ROOT, 'backend/api-gateway/src/application/audit.service'))});
        const pool = require(${JSON.stringify(path.join(ROOT, 'backend/api-gateway/src/infrastructure/db'))});
        (async () => {
          const fiscal = await invoices.verifyIntegrity();
          const trail = await audit.verifyIntegrity();
          console.log(JSON.stringify({
            fiscal: fiscal.chains.map((c) => ({ id: c.doc_type + '/' + c.series, ok: c.ok })),
            audit:  trail.chains.map((c) => ({ id: c.company_id, ok: c.ok })),
          }));
          await pool.end();
        })().catch((e) => { console.error(e.message); process.exit(1); });
      `], { env: pgEnv(database), encoding: 'utf8' });

      const line = String(check.stdout).split('\n').filter((l) => l.trim().startsWith('{')).pop();
      expect(line, String(check.stderr)).toBeTruthy();
      return JSON.parse(line);
    };

    const restored = probe(RESTORE_DB);
    const source   = probe('track');

    // A cadeia que este teste semeou tem de atravessar o restauro intacta.
    expect(restored.fiscal.length).toBeGreaterThan(0);   // havia mesmo cadeia para validar
    expect(restored.fiscal.every((c) => c.ok)).toBe(true);
    expect(restored.audit.find((c) => c.id === COMPANY)?.ok).toBe(true);

    // E nenhuma cadeia pode chegar partida ao restauro tendo estado íntegra na
    // origem — é essa regressão que reprova uma cópia.
    const { regressions } = compareChains(source.audit, restored.audit);
    expect(regressions, `cadeias partidas pelo restauro: ${regressions.join(', ')}`).toEqual([]);
  }, 120_000);

  it('should detect a corrupted dump instead of restoring garbage', () => {
    const dump = fs.readdirSync(backupDir).find((f) => f.endsWith('.dump'));
    const filePath = path.join(backupDir, dump);
    const original = fs.readFileSync(filePath);

    // Estraga um byte no meio: o SHA-256 do manifesto deixa de conferir.
    const tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    fs.writeFileSync(filePath, tampered);

    const verify = spawnSync(process.execPath, ['scripts/backup-verify.js', dump], {
      cwd: path.join(ROOT, 'backend/api-gateway'),
      env: { ...pgEnv('track'), BACKUP_DIR: backupDir },
      encoding: 'utf8',
    });

    expect(verify.status).not.toBe(0);
    expect(String(verify.stderr) + String(verify.stdout)).toMatch(/corrompido|SHA-256/i);

    fs.writeFileSync(filePath, original);
  }, 120_000);

  it('should rehearse the restore end to end and report success', () => {
    const verify = spawnSync(process.execPath, ['scripts/backup-verify.js'], {
      cwd: path.join(ROOT, 'backend/api-gateway'),
      env: { ...pgEnv('track'), BACKUP_DIR: backupDir, BACKUP_VERIFY_DB: 'sistematrack_itest_rehearsal' },
      encoding: 'utf8',
    });

    const output = String(verify.stdout);
    expect(verify.status, output + String(verify.stderr)).toBe(0);
    expect(output).toMatch(/Ficheiro íntegro/);
    expect(output).toMatch(/Contagens conferem/);
    expect(output).toMatch(/Cadeia fiscal íntegra/);
    expect(output).toMatch(/Base de ensaio removida/);
  }, 180_000);

  it('should refuse to restore over the database in use without --force', () => {
    const dump = fs.readdirSync(backupDir).find((f) => f.endsWith('.dump'));
    const restore = spawnSync(process.execPath, ['scripts/restore.js', dump, '--into=track'], {
      cwd: path.join(ROOT, 'backend/api-gateway'),
      env: { ...pgEnv('track'), BACKUP_DIR: backupDir },
      encoding: 'utf8',
    });

    expect(restore.status).not.toBe(0);
    expect(String(restore.stderr)).toMatch(/apagaria o arquivo atual/i);
  }, 60_000);

  it('should plan retention without touching anything on a dry run', () => {
    const before = fs.readdirSync(backupDir);
    const plan = spawnSync(process.execPath, ['scripts/backup.js', '--dry-run'], {
      cwd: path.join(ROOT, 'backend/api-gateway'),
      env: { ...pgEnv('track'), BACKUP_DIR: backupDir },
      encoding: 'utf8',
    });

    expect(plan.status).toBe(0);
    expect(String(plan.stdout)).toMatch(/Política:/);
    expect(fs.readdirSync(backupDir)).toEqual(before);
  }, 60_000);

  it('should apply the retention policy to a directory full of old backups', () => {
    // Cópias antigas fabricadas com nomes reais; o conteúdo é irrelevante para a
    // retenção, que decide apenas pelo instante no nome.
    for (const name of BackupFactory.daily(40)) {
      fs.writeFileSync(path.join(backupDir, name), 'x');
      fs.writeFileSync(path.join(backupDir, `${name}.json`), '{}');
    }

    const result = spawnSync(process.execPath, ['scripts/backup.js'], {
      cwd: path.join(ROOT, 'backend/api-gateway'),
      env: { ...pgEnv('track'), BACKUP_DIR: backupDir, BACKUP_KEEP_DAILY: '3', BACKUP_KEEP_WEEKLY: '2', BACKUP_KEEP_MONTHLY: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    const left = fs.readdirSync(backupDir).filter((f) => f.endsWith('.dump'));
    const expected = policy.planRetention(left, { daily: 3, weekly: 2, monthly: 1 });
    // Sobraram só as que a política manda guardar (e nada mais foi apagado).
    expect(expected.remove).toEqual([]);
    expect(left.length).toBeLessThanOrEqual(7);
  }, 180_000);
});
