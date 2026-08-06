/**
 * @file migrate.js
 * @description Migração inicial do routes-service — cria a tabela `routes`.
 *
 * Executa DDL idempotente — seguro rodar múltiplas vezes.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Rota)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.3 (timestamps sempre em UTC — timestamptz)
 *
 * Ao contrário do api-gateway, esta migração NÃO faz DROP TABLE: a tabela de
 * rotas é criada com IF NOT EXISTS para não destruir rotas em andamento se o
 * comando for corrido por engano.
 *
 * Uso:
 *   node src/infrastructure/migrate.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate] Iniciando migração do routes-service...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS routes (
        id           TEXT        PRIMARY KEY,
        driver_id    TEXT        NOT NULL,
        stops        JSONB       NOT NULL DEFAULT '[]',
        status       TEXT        NOT NULL DEFAULT 'PLANEJADA',
        distance_km  NUMERIC(10,3),
        optimized_at TIMESTAMPTZ NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT routes_status_check
          CHECK (status IN ('PLANEJADA', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA'))
      );
    `);

    // Consulta mais frequente: rotas de um motorista, mais recentes primeiro.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_routes_driver_id ON routes (driver_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_routes_status ON routes (status);
    `);

    await client.query('COMMIT');
    console.info('[migrate] Tabela "routes" pronta.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Falha na migração — rollback aplicado:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
