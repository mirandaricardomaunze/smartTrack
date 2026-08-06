/**
 * @file migrate-orders-index.js
 * @description Migração ADITIVA dos índices da listagem de pedidos.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1
 *
 * Uso:
 *   node src/infrastructure/migrate-orders-index.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyOrdersIndexSchema } = require('./migrations/orders-index');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:orders-index] A verificar índices da listagem...');
    await client.query('BEGIN');
    await applyOrdersIndexSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:orders-index] ✅ Índices criados/verificados.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:orders-index] ❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch(() => { pool.end(); process.exit(1); });
}

module.exports = { migrate };
