/**
 * @file migrate-routes-tenant.js
 * @description Migração ADITIVA do isolamento por empresa nas rotas (§ 2.4).
 *
 * Idempotente. Entra em `scripts/migrate-all.js` DEPOIS de `rotas` e de
 * `drivers` existirem — precisa das duas para o backfill.
 *
 * Uso:
 *   node src/infrastructure/migrate-routes-tenant.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyRoutesTenantSchema } = require('./migrations/routes-tenant');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:routes-tenant] A isolar as rotas por empresa...');
    await client.query('BEGIN');
    await applyRoutesTenantSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:routes-tenant] Coluna criada/verificada e preenchida.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:routes-tenant] Erro na migração:', err.message);
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
