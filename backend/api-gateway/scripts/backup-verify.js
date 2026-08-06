/**
 * @file backup-verify.js
 * @description Ensaio de restauro — prova que a cópia serve para alguma coisa.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * Uma cópia nunca restaurada é uma suposição. Este script transforma-a em facto:
 *
 *   1. confirma o SHA-256 contra o manifesto (o ficheiro não se degradou);
 *   2. restaura para uma base **descartável** (nunca para a de produção);
 *   3. compara a contagem de linhas das tabelas críticas com o manifesto;
 *   4. **revalida as cadeias de hash** dos documentos fiscais (§ 3.19) e do
 *      registo de auditoria (§ 3.21) na base restaurada — porque um restauro que
 *      traz as linhas mas parte a cadeia não é defensável numa inspeção;
 *   5. apaga a base de ensaio.
 *
 * Uso:
 *   node scripts/backup-verify.js                 (a cópia mais recente)
 *   node scripts/backup-verify.js <ficheiro.dump>
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { CRITICAL_TABLES, compareRowCounts, parseBackupDate } = require('../src/infrastructure/backup.policy');

const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '..', '..', '..', 'backups');
const SCRATCH_DB = process.env.BACKUP_VERIFY_DB || 'sistematrack_restore_check';

function pgEnv(database) {
  return {
    ...process.env,
    PGHOST: process.env.PGHOST || 'localhost',
    PGPORT: process.env.PGPORT || '5432',
    PGUSER: process.env.PGUSER || 'postgres',
    PGPASSWORD: process.env.PGPASSWORD || '',
    PGDATABASE: database,
  };
}

function psql(database, sql) {
  const result = spawnSync('psql', ['-tAc', sql], { env: pgEnv(database), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr || '').trim() || 'psql falhou');
  return String(result.stdout).trim();
}

/** A cópia mais recente pelo nome (a data está no ficheiro). */
function latestBackup() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.dump'))
    .map((f) => ({ f, at: parseBackupDate(f) }))
    .filter((e) => e.at)
    .sort((a, b) => b.at - a.at);
  return files[0]?.f;
}

function fail(message) {
  console.error(`[backup:verify] ❌ ${message}`);
  process.exitCode = 1;
}

function main() {
  const target = process.argv[2] || latestBackup();
  if (!target) { fail(`Nenhuma cópia encontrada em ${BACKUP_DIR}.`); return; }

  const filePath = path.isAbsolute(target) ? target : path.join(BACKUP_DIR, target);
  if (!fs.existsSync(filePath)) { fail(`Ficheiro não existe: ${filePath}`); return; }

  console.info(`[backup:verify] Cópia: ${path.basename(filePath)}`);

  // ── 1. Integridade do ficheiro ─────────────────────────────────────────────
  let manifest;
  const manifestPath = `${filePath}.json`;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (actual !== manifest.sha256) {
      fail('SHA-256 diferente do manifesto: o ficheiro está corrompido ou foi alterado.');
      return;
    }
    console.info('[backup:verify] ✅ Ficheiro íntegro (SHA-256 confere).');
  } else {
    console.warn('[backup:verify] ⚠️  Sem manifesto: não é possível confirmar o conteúdo esperado.');
  }

  // ── 2. Restauro para base descartável ──────────────────────────────────────
  console.info(`[backup:verify] A restaurar para "${SCRATCH_DB}" (base de ensaio, nunca a de produção)...`);
  psql('postgres', `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  psql('postgres', `CREATE DATABASE ${SCRATCH_DB}`);

  const restore = spawnSync('pg_restore', ['--no-owner', '--no-privileges', `--dbname=${SCRATCH_DB}`, filePath], {
    env: pgEnv(SCRATCH_DB), encoding: 'utf8',
  });
  // pg_restore devolve 1 com avisos benignos (extensões, donos); o que conta é o
  // conteúdo, verificado a seguir.
  if (restore.status !== 0) {
    console.warn('[backup:verify] pg_restore terminou com avisos:');
    console.warn(String(restore.stderr || '').split('\n').slice(0, 5).join('\n'));
  }

  try {
    // ── 3. Contagens ─────────────────────────────────────────────────────────
    const actualCounts = {};
    for (const table of CRITICAL_TABLES) {
      try { actualCounts[table] = Number(psql(SCRATCH_DB, `SELECT COUNT(*) FROM ${table}`)); }
      catch { actualCounts[table] = null; }
    }

    if (manifest?.row_counts) {
      const expected = Object.fromEntries(
        Object.entries(manifest.row_counts).filter(([, v]) => v !== null),
      );
      const comparison = compareRowCounts(expected, actualCounts);
      if (!comparison.ok) {
        for (const d of comparison.differences) {
          fail(`Tabela ${d.table}: esperadas ${d.expected} linhas, restauradas ${d.actual}.`);
        }
      } else {
        const total = Object.values(expected).reduce((s, n) => s + n, 0);
        console.info(`[backup:verify] ✅ Contagens conferem (${Object.keys(expected).length} tabelas, ${total} linhas).`);
      }
    }

    // ── 4. Cadeias de hash na base restaurada ────────────────────────────────
    // É isto que distingue "os dados voltaram" de "o arquivo fiscal continua
    // defensável". Corre nos módulos do próprio sistema, apontados à base de ensaio.
    const checks = spawnSync(process.execPath, ['-e', `
      process.env.PGDATABASE = ${JSON.stringify(SCRATCH_DB)};
      const invoices = require(${JSON.stringify(path.resolve(__dirname, '..', 'src/application/invoices.service'))});
      const audit = require(${JSON.stringify(path.resolve(__dirname, '..', 'src/application/audit.service'))});
      const pool = require(${JSON.stringify(path.resolve(__dirname, '..', 'src/infrastructure/db'))});
      (async () => {
        const fiscal = await invoices.verifyIntegrity();
        const trail = await audit.verifyIntegrity();
        console.log(JSON.stringify({ fiscal: fiscal.ok, fiscalChains: fiscal.chains.length, audit: trail.ok, auditChains: trail.chains.length }));
        await pool.end();
      })().catch((e) => { console.error(e.message); process.exit(1); });
    `], { env: pgEnv(SCRATCH_DB), encoding: 'utf8' });

    const line = String(checks.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (checks.status !== 0 || !line) {
      fail(`Não foi possível revalidar as cadeias: ${String(checks.stderr || '').trim().split('\n')[0]}`);
    } else {
      const result = JSON.parse(line);
      if (result.fiscal) console.info(`[backup:verify] ✅ Cadeia fiscal íntegra (${result.fiscalChains} série(s)).`);
      else fail('Cadeia fiscal partida na base restaurada.');
      if (result.audit) console.info(`[backup:verify] ✅ Cadeia de auditoria íntegra (${result.auditChains} empresa(s)).`);
      else fail('Cadeia de auditoria partida na base restaurada.');
    }
  } finally {
    // ── 5. Limpeza ───────────────────────────────────────────────────────────
    psql('postgres', `DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    console.info('[backup:verify] Base de ensaio removida.');
  }

  if (process.exitCode) console.error('[backup:verify] ❌ ENSAIO FALHOU — esta cópia não é de confiança.');
  else console.info('[backup:verify] ✅ Ensaio concluído: esta cópia restaura e o arquivo mantém-se íntegro.');
}

if (require.main === module) main();

module.exports = { main, latestBackup, SCRATCH_DB };
