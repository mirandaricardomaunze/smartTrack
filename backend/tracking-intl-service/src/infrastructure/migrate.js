/**
 * @file migrate.js
 * @description Migração inicial do tracking-intl-service.
 *
 * DDL idempotente, sem DROP.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (EventoRastreio)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.3 (timestamps UTC)
 *
 * Tabelas:
 *   - tracking_events    — histórico normalizado, um registo por leitura única
 *   - tracked_shipments  — que códigos consultar e quando foram consultados
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
    console.info('[migrate] Iniciando migração do tracking-intl-service...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS tracking_events (
        id                TEXT        PRIMARY KEY,
        tracking_code     TEXT        NOT NULL,
        carrier           TEXT        NOT NULL,
        -- Status canônico, produzido pelo StatusMapper
        status            TEXT        NOT NULL,
        -- Valor cru da transportadora, preservado para auditoria
        raw_status        TEXT        NOT NULL,
        location          TEXT,
        description       TEXT,
        carrier_timestamp TIMESTAMPTZ NOT NULL,
        event_hash        TEXT        NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT tracking_events_status_check
          CHECK (status IN (
            'created','collected','in_transit','at_warehouse',
            'awaiting_destination','out_for_delivery','delivered','failed','cancelled'
          ))
      );
    `);

    // Defesa estrutural contra duplicação: o polling relê o histórico completo
    // a cada ciclo, e dois ciclos podem sobrepor-se.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_events_hash
        ON tracking_events (event_hash);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tracking_events_code
        ON tracking_events (tracking_code, carrier_timestamp DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tracked_shipments (
        tracking_code  TEXT        PRIMARY KEY,
        carrier        TEXT        NOT NULL,
        -- FALSE quando a encomenda chegou a estado final: deixa de ser consultada
        active         BOOLEAN     NOT NULL DEFAULT TRUE,
        last_polled_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // O ciclo de polling ordena por last_polled_at — os nunca consultados primeiro.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tracked_shipments_poll
        ON tracked_shipments (active, last_polled_at NULLS FIRST);
    `);

    // Multiempresa (spec § 2.4): a empresa é fixada na criação do acompanhamento.
    await client.query(`ALTER TABLE tracked_shipments ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'company-default';`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tracked_shipments_company ON tracked_shipments (company_id);`);

    await client.query('COMMIT');
    console.info('[migrate] Tabelas "tracking_events" e "tracked_shipments" prontas.');
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
