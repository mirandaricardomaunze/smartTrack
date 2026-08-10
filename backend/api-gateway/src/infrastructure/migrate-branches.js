/**
 * @file migrate-branches.js
 * @description Migração ADITIVA do âmbito de filial (§ 3.45).
 *
 * Idempotente e não destrutiva. Corre depois do núcleo e da frota: acrescenta
 * colunas a `orders`, `drivers` e `fleet_vehicles`.
 *
 * Uso:
 *   node src/infrastructure/migrate-branches.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyBranchesSchema } = require('./migrations/branches');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:branches] A verificar o âmbito de filial...');
    await client.query('BEGIN');
    await applyBranchesSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:branches] Tabelas e colunas criadas/verificadas.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:branches] Erro na migração:', err.message);
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
