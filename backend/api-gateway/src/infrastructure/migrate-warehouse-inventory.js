/**
 * @file migrate-warehouse-inventory.js
 * @description Migração ADITIVA das transferências entre filiais e contagens.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js` DEPOIS do
 * núcleo: as tabelas referenciam `warehouses`.
 *
 * Uso:
 *   node src/infrastructure/migrate-warehouse-inventory.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyWarehouseInventorySchema } = require('./migrations/warehouse-inventory');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:warehouse-inventory] A verificar transferências e contagens...');
    await client.query('BEGIN');
    await applyWarehouseInventorySchema(client);
    await client.query('COMMIT');
    console.info('[migrate:warehouse-inventory] Tabelas criadas/verificadas.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:warehouse-inventory] Erro na migração:', err.message);
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
