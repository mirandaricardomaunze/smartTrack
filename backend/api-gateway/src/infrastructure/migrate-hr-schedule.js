/**
 * @file migrate-hr-schedule.js
 * @description Migração ADITIVA do horário do colaborador (turno).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.18
 *
 * Corre depois de `migrate-hr-operations` (que cria `hr_shifts`) e de
 * `migrate-hr` (que cria `hr_employees`). Idempotente.
 *
 * Uso:
 *   node src/infrastructure/migrate-hr-schedule.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyHrScheduleSchema } = require('./migrations/hr-schedule');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:hr-schedule] A ligar colaboradores a turnos...');
    await client.query('BEGIN');
    await applyHrScheduleSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:hr-schedule] ✅ Horário do colaborador criado/verificado.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:hr-schedule] ❌ Erro na migração:', err.message);
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
