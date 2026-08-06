/**
 * @file migrate-saas.js
 * @description Migração ADITIVA da camada SaaS (planos, subscrições, uso, faturação).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Idempotente e não destrutiva — pode correr em bases com dados. É o caminho por
 * onde uma instalação já existente ganha as tabelas do SaaS, uma vez que
 * `migrate.js` (núcleo) só corre em bases vazias. Entra em `scripts/migrate-all.js`.
 *
 * Uso:
 *   node src/infrastructure/migrate-saas.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applySaasSchema } = require('./migrations/saas');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:saas] A verificar planos e subscrições...');
    await client.query('BEGIN');
    await applySaasSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:saas] ✅ Camada SaaS criada/verificada.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:saas] ❌ Erro na migração:', err.message);
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
