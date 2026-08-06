/**
 * @file migrate.js
 * @description Migração inicial do notifications-service.
 *
 * DDL idempotente, sem DROP.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 (Notificações Push)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.3 (timestamps UTC — timestamptz)
 *
 * Tabelas:
 *   - notifications  — histórico de envios
 *   - device_tokens  — tokens FCM por utilizador
 *   - preferences    — preferências por utilizador
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
    console.info('[migrate] Iniciando migração do notifications-service...');
    await client.query('BEGIN');

    // ── notifications ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id              TEXT        PRIMARY KEY,
        user_id         TEXT        NOT NULL,
        role            TEXT        NOT NULL,
        category        TEXT        NOT NULL,
        title           TEXT        NOT NULL,
        body            TEXT        NOT NULL,
        data            JSONB       NOT NULL DEFAULT '{}',
        status          TEXT        NOT NULL DEFAULT 'pending',
        delivered_count INTEGER     NOT NULL DEFAULT 0,
        failure_reason  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT notifications_status_check
          CHECK (status IN ('pending','sent','failed','suppressed')),
        CONSTRAINT notifications_category_check
          CHECK (category IN (
            'ORDER_STATUS','DESTINATION_REQUEST','PAYMENT',
            'ROUTE_ASSIGNED','DELIVERY_ISSUE'
          ))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_id
        ON notifications (user_id, created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status);
    `);

    // ── device_tokens ─────────────────────────────────────────────────────────
    // O token é a chave primária: um token pertence a um só dispositivo, e a app
    // reenvia-o a cada arranque — o ON CONFLICT do repositório depende disto.
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        token      TEXT        PRIMARY KEY,
        user_id    TEXT        NOT NULL,
        platform   TEXT        NOT NULL DEFAULT 'unknown',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT device_tokens_platform_check
          CHECK (platform IN ('android','ios','web','unknown'))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens (user_id);
    `);

    // ── preferences ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS preferences (
        user_id    TEXT        PRIMARY KEY,
        categories JSONB       NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── outbound_messages (auditoria de SMS/email — spec § 3.3) ────────────────
    // channel: 'sms' | 'email'  ·  status: 'sent' | 'failed' | 'simulated'
    await client.query(`
      CREATE TABLE IF NOT EXISTS outbound_messages (
        id                  TEXT        PRIMARY KEY,
        channel             TEXT        NOT NULL,
        recipient           TEXT        NOT NULL,
        subject             TEXT,
        body                TEXT        NOT NULL,
        status              TEXT        NOT NULL,
        provider            TEXT        NOT NULL,
        provider_message_id TEXT,
        order_id            TEXT,
        tracking_code       TEXT,
        error               TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT outbound_messages_channel_check CHECK (channel IN ('sms','email')),
        CONSTRAINT outbound_messages_status_check  CHECK (status IN ('sent','failed','simulated'))
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_outbound_messages_created ON outbound_messages (created_at DESC);
    `);

    // Multiempresa (spec § 2.4): tenant nas tabelas com vista agregada de admin.
    for (const t of ['notifications', 'outbound_messages']) {
      await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'company-default';`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${t}_company ON ${t} (company_id);`);
    }

    await client.query('COMMIT');
    console.info('[migrate] Tabelas "notifications", "device_tokens", "preferences" e "outbound_messages" prontas.');
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
