/**
 * @file migrate-contracts.js
 * @description Migração ADITIVA dos contratos de cliente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js` DEPOIS do
 * núcleo, porque acrescenta uma coluna a `invoices`.
 *
 * Uso:
 *   node src/infrastructure/migrate-contracts.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyContractsSchema } = require('./migrations/contracts');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:contracts] A verificar os contratos de cliente...');
    await client.query('BEGIN');
    await applyContractsSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:contracts] Contratos criados/verificados.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:contracts] Erro na migração:', err.message);
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
