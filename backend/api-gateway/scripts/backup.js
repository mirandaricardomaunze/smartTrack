/**
 * @file backup.js
 * @description Cópia de segurança da base de dados, com manifesto e retenção.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * PORQUE ISTO É CRÍTICO NESTE SISTEMA: a base de dados é o **arquivo fiscal**
 * dos clientes — faturas assinadas, cadeias de hash, registo de auditoria.
 * Perdê-la não é perder dados de trabalho, é perder documentos com valor legal.
 *
 * O que faz:
 *   1. `pg_dump` em formato custom (comprimido, restaurável seletivamente);
 *   2. escreve um **manifesto** ao lado, com SHA-256 do ficheiro e a contagem de
 *      linhas das tabelas críticas — é o que permite provar mais tarde que o
 *      restauro trouxe tudo (ver `backup-verify.js`);
 *   3. aplica a retenção (ver `backup.policy.js`);
 *   4. se `BACKUP_UPLOAD_CMD` estiver definido, corre-o para levar a cópia para
 *      fora da máquina. Fica assim sem escolher fornecedor por si: qualquer
 *      comando serve (rclone, aws s3 cp, scp, rsync).
 *
 * Uso:
 *   node scripts/backup.js
 *   BACKUP_DIR=/mnt/backups node scripts/backup.js
 *   node scripts/backup.js --dry-run     (mostra o plano de retenção e sai)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const {
  backupFileName, planRetention, CRITICAL_TABLES, DEFAULT_POLICY,
} = require('../src/infrastructure/backup.policy');

const DATABASE = process.env.PGDATABASE || 'track';
/** Por omissão fica ao lado do projeto — mas fora dele, para não ir num commit. */
const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '..', '..', '..', 'backups');
const POLICY = {
  daily: Number(process.env.BACKUP_KEEP_DAILY) || DEFAULT_POLICY.daily,
  weekly: Number(process.env.BACKUP_KEEP_WEEKLY) || DEFAULT_POLICY.weekly,
  monthly: Number(process.env.BACKUP_KEEP_MONTHLY) || DEFAULT_POLICY.monthly,
};

const dryRun = process.argv.includes('--dry-run');

/** Ambiente para as ferramentas do Postgres, sem imprimir a senha. */
function pgEnv() {
  return {
    ...process.env,
    PGHOST: process.env.PGHOST || 'localhost',
    PGPORT: process.env.PGPORT || '5432',
    PGUSER: process.env.PGUSER || 'postgres',
    PGPASSWORD: process.env.PGPASSWORD || '',
    PGDATABASE: DATABASE,
  };
}

/** Contagem de linhas das tabelas críticas, para o manifesto. */
function countRows() {
  const counts = {};
  for (const table of CRITICAL_TABLES) {
    const result = spawnSync('psql', ['-tAc', `SELECT COUNT(*) FROM ${table}`], { env: pgEnv(), encoding: 'utf8' });
    // Tabela ainda inexistente (instalação parcial) não é motivo para falhar.
    counts[table] = result.status === 0 ? Number(String(result.stdout).trim()) : null;
  }
  return counts;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const existing = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump'));

  if (dryRun) {
    const plan = planRetention(existing, POLICY);
    console.info(`[backup] Destino: ${BACKUP_DIR}`);
    console.info(`[backup] Política: ${POLICY.daily} diárias, ${POLICY.weekly} semanais, ${POLICY.monthly} mensais`);
    console.info(`[backup] Cópias existentes: ${existing.length}`);
    for (const name of plan.keep) console.info(`  manter  ${name}  (${plan.reasons[name].join(', ')})`);
    for (const name of plan.remove) console.info(`  apagar  ${name}`);
    for (const name of plan.unknown) console.info(`  ignorar ${name}  (nome não reconhecido)`);
    return;
  }

  const fileName = backupFileName(DATABASE);
  const filePath = path.join(BACKUP_DIR, fileName);

  console.info(`[backup] A copiar "${DATABASE}" para ${filePath}`);
  const dump = spawnSync('pg_dump', ['--format=custom', '--compress=6', `--file=${filePath}`], {
    env: pgEnv(), stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (dump.status !== 0) {
    console.error('[backup] ❌ pg_dump falhou. Nenhuma cópia foi escrita.');
    process.exit(dump.status || 1);
  }

  const stats = fs.statSync(filePath);
  const manifest = {
    database: DATABASE,
    file: fileName,
    created_at: new Date().toISOString(),
    bytes: stats.size,
    sha256: sha256(filePath),
    row_counts: countRows(),
    pg_dump_version: String(spawnSync('pg_dump', ['--version'], { encoding: 'utf8' }).stdout || '').trim(),
  };
  fs.writeFileSync(`${filePath}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.info(`[backup] ✅ Cópia escrita: ${humanSize(stats.size)} · SHA-256 ${manifest.sha256.slice(0, 16)}…`);

  // ── Cópia fora da máquina ──────────────────────────────────────────────────
  // Uma cópia no mesmo disco não sobrevive ao que mais provavelmente a destrói.
  const uploadCmd = process.env.BACKUP_UPLOAD_CMD;
  if (uploadCmd) {
    console.info('[backup] A enviar para fora da máquina...');
    const upload = spawnSync(uploadCmd.replace('{file}', filePath), { shell: true, stdio: 'inherit' });
    if (upload.status !== 0) console.error('[backup] ⚠️  O envio falhou — a cópia local existe, mas não há cópia externa.');
    else console.info('[backup] ✅ Enviada.');
  } else {
    console.warn('[backup] ⚠️  BACKUP_UPLOAD_CMD não definido: a cópia fica APENAS nesta máquina.');
  }

  // ── Retenção ───────────────────────────────────────────────────────────────
  const plan = planRetention(fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump')), POLICY);
  for (const name of plan.remove) {
    fs.rmSync(path.join(BACKUP_DIR, name), { force: true });
    fs.rmSync(path.join(BACKUP_DIR, `${name}.json`), { force: true });
    console.info(`[backup] Removida por retenção: ${name}`);
  }
  console.info(`[backup] Cópias mantidas: ${plan.keep.length}`);
  console.info('[backup] Lembre-se: uma cópia só conta depois de um restauro ensaiado (npm run backup:verify).');
}

if (require.main === module) main();

module.exports = { main, BACKUP_DIR, POLICY };
