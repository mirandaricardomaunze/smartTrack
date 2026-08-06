/**
 * @file migrate-password-reset.js
 * @description Migração ADITIVA da recuperação de senha.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js`.
 *
 * Uso:
 *   node src/infrastructure/migrate-password-reset.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyPasswordResetSchema } = require('./migrations/password-reset');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:password-reset] A verificar a recuperação de senha...');
    await client.query('BEGIN');
    await applyPasswordResetSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:password-reset] ✅ Recuperação de senha criada/verificada.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:password-reset] ❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(() => { pool.end(); process.exit(1); });
}

module.exports = { migrate };
