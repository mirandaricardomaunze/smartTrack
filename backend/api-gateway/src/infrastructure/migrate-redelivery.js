/**
 * @file migrate-redelivery.js
 * @description Migração ADITIVA do reagendamento e da devolução (spec § 3.37).
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js` depois do
 * núcleo: acrescenta colunas a `orders`.
 *
 * Uso:
 *   node src/infrastructure/migrate-redelivery.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyRedeliverySchema } = require('./migrations/redelivery');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:redelivery] A verificar reagendamento e devolução...');
    await client.query('BEGIN');
    await applyRedeliverySchema(client);
    await client.query('COMMIT');
    console.info('[migrate:redelivery] Colunas criadas/verificadas.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:redelivery] Erro na migração:', err.message);
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
