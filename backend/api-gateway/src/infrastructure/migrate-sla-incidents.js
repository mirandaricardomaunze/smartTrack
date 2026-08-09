/**
 * @file migrate-sla-incidents.js
 * @description Migração ADITIVA dos prazos de SLA e das ocorrências (§ 3.42).
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js` depois do
 * núcleo: acrescenta colunas a `pricing_zones`.
 *
 * Uso:
 *   node src/infrastructure/migrate-sla-incidents.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applySlaIncidentsSchema } = require('./migrations/sla-incidents');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:sla-incidents] A verificar prazos de SLA e ocorrências...');
    await client.query('BEGIN');
    await applySlaIncidentsSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:sla-incidents] Tabelas e colunas criadas/verificadas.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:sla-incidents] Erro na migração:', err.message);
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
