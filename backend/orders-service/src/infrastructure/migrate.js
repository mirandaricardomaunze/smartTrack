/**
 * @file migrate.js
 * @description Migração do orders-service.
 *
 * DDL idempotente, sem DROP.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Pedido)
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md
 *
 * Tabelas:
 *   - orders           — pedidos e o seu status atual
 *   - order_events     — timeline (append-only)
 *   - processed_events — chaves já sincronizadas (idempotência, regra 5)
 *   - conflict_log     — auditoria de conflitos (regra 4: descartes silenciosos proibidos)
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
    console.info('[migrate] Iniciando migração do orders-service...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id             TEXT        PRIMARY KEY,
        tracking_code  TEXT        NOT NULL UNIQUE,
        client_id      TEXT        NOT NULL,
        current_status TEXT        NOT NULL DEFAULT 'created',
        driver_id      TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT orders_status_check
          CHECK (current_status IN (
            'created','collected','in_transit','at_warehouse',
            'awaiting_destination','out_for_delivery','delivered','failed','cancelled'
          ))
      );
    `);

    // Timeline append-only — nunca se apaga um evento, só se acrescenta.
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_events (
        id               TEXT        PRIMARY KEY,
        order_id         TEXT        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status           TEXT        NOT NULL,
        description      TEXT,
        event_origin     TEXT        NOT NULL DEFAULT 'DRIVER',
        device_timestamp TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_order_events_order
        ON order_events (order_id, created_at DESC);
    `);

    // Idempotência do sync: a chave determinística de cada evento já aplicado.
    // O UNIQUE é a defesa estrutural — reenviar o mesmo lote não reaplica nada.
    await client.query(`
      CREATE TABLE IF NOT EXISTS processed_events (
        dedupe_key   TEXT        PRIMARY KEY,
        order_id     TEXT        NOT NULL,
        correlation_id TEXT,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Auditoria de conflitos (skill regra 4).
    await client.query(`
      CREATE TABLE IF NOT EXISTS conflict_log (
        id             TEXT        PRIMARY KEY,
        order_id       TEXT        NOT NULL,
        event_type     TEXT        NOT NULL,
        local_value    JSONB       NOT NULL,
        server_value   JSONB       NOT NULL,
        resolution     TEXT        NOT NULL,
        reason         TEXT        NOT NULL,
        resolved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT conflict_log_resolution_check
          CHECK (resolution IN ('LOCAL_WINS','SERVER_WINS','KEEP_BOTH','NO_CONFLICT'))
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conflict_log_order
        ON conflict_log (order_id, resolved_at DESC);
    `);

    await client.query('COMMIT');
    console.info('[migrate] Tabelas "orders", "order_events", "processed_events" e "conflict_log" prontas.');
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
