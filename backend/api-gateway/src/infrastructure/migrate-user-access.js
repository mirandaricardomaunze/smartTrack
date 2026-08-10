/**
 * @file migrate-user-access.js
 * @description Migração ADITIVA do estado de acesso das contas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js`.
 *
 * Uso:
 *   node src/infrastructure/migrate-user-access.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyUserAccessSchema } = require('./migrations/user-access');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:user-access] A verificar o estado de acesso das contas...');
    await client.query('BEGIN');
    await applyUserAccessSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:user-access] ✅ Estado de acesso criado/verificado.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:user-access] ❌ Erro na migração:', err.message);
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
