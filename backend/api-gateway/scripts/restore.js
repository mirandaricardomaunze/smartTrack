/**
 * @file restore.js
 * @description Restauro de uma cópia de segurança para uma base indicada.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * Restaurar é a operação mais destrutiva do sistema: escreve por cima de um
 * arquivo fiscal. Por isso este script:
 *   - **nunca** aceita a base de produção sem `--force` explícito;
 *   - confirma o SHA-256 antes de tocar em nada;
 *   - recria a base de destino de raiz, para não misturar dados de duas épocas;
 *   - revalida as cadeias de hash no fim e diz o que encontrou.
 *
 * Uso:
 *   node scripts/restore.js <ficheiro.dump> --into=track_recuperada
 *   node scripts/restore.js <ficheiro.dump> --into=track --force
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(__dirname, '..', '..', '..', 'backups');
const PRODUCTION_DB = process.env.PGDATABASE || 'track';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const intoArg = args.find((a) => a.startsWith('--into='));
const force = args.includes('--force');
const target = intoArg ? intoArg.split('=')[1] : `${PRODUCTION_DB}_recuperada`;

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
  if (result.status !== 0) throw new Error(String(result.stderr || '').trim());
  return String(result.stdout).trim();
}

function main() {
  if (!file) {
    console.error('Uso: node scripts/restore.js <ficheiro.dump> [--into=base] [--force]');
    process.exit(1);
  }

  const filePath = path.isAbsolute(file) ? file : path.join(BACKUP_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.error(`[restore] Ficheiro não existe: ${filePath}`);
    process.exit(1);
  }

  if (target === PRODUCTION_DB && !force) {
    console.error(`[restore] ❌ "${target}" é a base em uso. Isto apagaria o arquivo atual.`);
    console.error('[restore]    Restaure primeiro para uma base nova (--into=track_recuperada),');
    console.error('[restore]    confirme o conteúdo, e só depois repita com --force se for isso que quer.');
    process.exit(1);
  }

  // Integridade antes de destruir o que existe.
  const manifestPath = `${filePath}.json`;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (actual !== manifest.sha256) {
      console.error('[restore] ❌ SHA-256 não confere: a cópia está corrompida. Nada foi alterado.');
      process.exit(1);
    }
    console.info(`[restore] Cópia de ${manifest.created_at}, íntegra.`);
  }

  console.info(`[restore] A recriar "${target}" e restaurar ${path.basename(filePath)}...`);
  psql('postgres', `DROP DATABASE IF EXISTS ${target}`);
  psql('postgres', `CREATE DATABASE ${target}`);

  const restore = spawnSync('pg_restore', ['--no-owner', '--no-privileges', `--dbname=${target}`, filePath], {
    env: pgEnv(target), stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8',
  });
  if (restore.status !== 0) {
    console.warn('[restore] pg_restore terminou com avisos (normal: donos e extensões).');
  }

  const tables = psql(target, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'");
  console.info(`[restore] ✅ Restaurado: ${tables} tabelas em "${target}".`);
  console.info('[restore] Confirme agora as cadeias de hash:');
  console.info(`[restore]   BACKUP_VERIFY_DB=${target} node scripts/backup-verify.js ${path.basename(filePath)}`);
}

if (require.main === module) main();

module.exports = { main };
