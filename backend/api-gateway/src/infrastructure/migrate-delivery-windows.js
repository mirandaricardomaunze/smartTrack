/**
 * @file migrate-delivery-windows.js
 * @description Migração ADITIVA das janelas de entrega (§ 3.48).
 *
 * Idempotente e não destrutiva. Corre depois do núcleo: acrescenta colunas a `orders`.
 *
 * Uso:
 *   node src/infrastructure/migrate-delivery-windows.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyDeliveryWindowsSchema } = require('./migrations/delivery-windows');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:delivery-windows] A verificar as janelas de entrega...');
    await client.query('BEGIN');
    await applyDeliveryWindowsSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:delivery-windows] Tabelas e colunas criadas/verificadas.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:delivery-windows] Erro na migração:', err.message);
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
