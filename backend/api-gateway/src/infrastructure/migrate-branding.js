/**
 * @file migrate-branding.js
 * @description Migração ADITIVA do perfil/marca da empresa.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20
 *
 * Idempotente e não destrutiva — corre em bases com dados. Entra em
 * `scripts/migrate-all.js`.
 *
 * Uso:
 *   node src/infrastructure/migrate-branding.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyBrandingSchema } = require('./migrations/branding');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:branding] A verificar o perfil das empresas...');
    await client.query('BEGIN');
    await applyBrandingSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:branding] ✅ Perfil da empresa criado/verificado.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:branding] ❌ Erro na migração:', err.message);
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
