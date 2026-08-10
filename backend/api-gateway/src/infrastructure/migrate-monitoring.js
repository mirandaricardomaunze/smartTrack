/**
 * @file migrate-monitoring.js
 * @description Migração ADITIVA do registo central de erros.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js`.
 *
 * Uso:
 *   node src/infrastructure/migrate-monitoring.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyMonitoringSchema } = require('./migrations/monitoring');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:monitoring] A verificar o registo central de erros...');
    await client.query('BEGIN');
    await applyMonitoringSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:monitoring] Registo de erros criado/verificado.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:monitoring] Erro na migração:', err.message);
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
