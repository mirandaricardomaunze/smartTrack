/**
 * @file migrate-pricing-dimensions.js
 * @description Migração ADITIVA da tarifação por volume e distância.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * Idempotente e não destrutiva. Entra em `scripts/migrate-all.js`.
 * Os valores por omissão são zero: nenhum preço muda por causa da migração.
 *
 * Uso:
 *   node src/infrastructure/migrate-pricing-dimensions.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyPricingDimensionsSchema } = require('./migrations/pricing-dimensions');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:pricing-dimensions] A verificar volume e distância na tarifação...');
    await client.query('BEGIN');
    await applyPricingDimensionsSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:pricing-dimensions] Colunas criadas/verificadas.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:pricing-dimensions] Erro na migração:', err.message);
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
