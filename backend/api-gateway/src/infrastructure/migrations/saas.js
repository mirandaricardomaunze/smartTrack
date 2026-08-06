/**
 * @file saas.js
 * @description Esquema da camada SaaS — planos, subscrições, uso e faturação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * PORQUÊ UM MÓDULO À PARTE: `migrate.js` (núcleo) é DESTRUTIVO — faz DROP das
 * tabelas operacionais e por isso só corre em bases vazias (ver
 * `scripts/bootstrap-migrate.js`). Este DDL é 100% ADITIVO e idempotente, logo
 * pode correr em bases já com dados. É invocado dos dois lados:
 *   - pelo núcleo, dentro da sua transação (instalação de raiz);
 *   - por `migrate-saas.js`, que entra em `migrate-all.js` (bases existentes).
 *
 * Aqui a PLATAFORMA cobra as EMPRESAS — o inverso de `invoices`, onde a empresa
 * cobra os seus clientes pelo frete.
 */
'use strict';

/**
 * Aplica (ou verifica) o esquema SaaS. Não abre transação: o chamador decide.
 * @param {import('pg').PoolClient} client
 */
async function applySaasSchema(client) {
  // ── plans: catálogo global (sem empresa — é a oferta da plataforma) ────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS plans (
      code                 TEXT        PRIMARY KEY,
      name                 TEXT        NOT NULL,
      description          TEXT,
      price_cents          INTEGER     NOT NULL DEFAULT 0,    -- mensal, IVA incluído
      currency             TEXT        NOT NULL DEFAULT 'MZN',
      trial_days           INTEGER     NOT NULL DEFAULT 14,
      max_orders_per_month INTEGER,                           -- NULL = ilimitado
      max_users            INTEGER,
      max_warehouses       INTEGER,
      features             JSONB       NOT NULL DEFAULT '{}',
      self_serve           BOOLEAN     NOT NULL DEFAULT TRUE, -- FALSE = negociado (fora do upgrade self-service)
      active               BOOLEAN     NOT NULL DEFAULT TRUE,
      sort_order           INTEGER     NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Catálogo por default (idempotente — não sobrepõe preços/limites editados).
  await client.query(`
    INSERT INTO plans (code, name, description, price_cents, trial_days, max_orders_per_month, max_users, max_warehouses, features, self_serve, sort_order) VALUES
      ('free',       'Grátis',     'Para arrancar: operação pequena, sem custo.',               0,  0,   50,    2,    1, '{"intl_tracking": false, "support": "email"}',     TRUE,  1),
      ('starter',    'Starter',    'Operação em crescimento, com rastreio internacional.', 250000, 14,  500,    5,    3, '{"intl_tracking": true,  "support": "email"}',     TRUE,  2),
      ('pro',        'Pro',        'Volume alto, vários armazéns e equipa completa.',      950000, 14, 5000,   25,   10, '{"intl_tracking": true,  "support": "priority"}',  TRUE,  3),
      ('enterprise', 'Enterprise', 'Contrato negociado — limites e faturação à medida.',        0,  0, NULL, NULL, NULL, '{"intl_tracking": true,  "support": "dedicated"}', FALSE, 4)
    ON CONFLICT (code) DO NOTHING;
  `);

  // ── subscriptions: uma por empresa, atravessa as mudanças de plano ─────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                   TEXT        PRIMARY KEY,
      company_id           TEXT        NOT NULL,
      plan_code            TEXT        NOT NULL,
      status               TEXT        NOT NULL DEFAULT 'trialing',
      trial_ends_at        TIMESTAMPTZ,
      current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_period_end   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      past_due_since       TIMESTAMPTZ,
      canceled_at          TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_subscriptions_company ON subscriptions (company_id);`);

  // ── usage_counters: medição mensal (fonte de verdade da quota) ────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      company_id TEXT        NOT NULL,
      period     TEXT        NOT NULL,       -- 'YYYY-MM' (UTC)
      metric     TEXT        NOT NULL,       -- 'orders'
      count      INTEGER     NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, period, metric)
    );
  `);

  // ── Faturas da subscrição: numeração SB{ano}/{seq} ─────────────────────────
  // A sequência é global (o emissor é a plataforma), ao contrário de
  // `invoice_counters`, que é por empresa.
  await client.query(`
    CREATE TABLE IF NOT EXISTS subscription_invoice_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL DEFAULT 0
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id             TEXT        PRIMARY KEY,
      number         TEXT        NOT NULL UNIQUE,
      company_id     TEXT        NOT NULL,
      company_name   TEXT        NOT NULL,
      plan_code      TEXT        NOT NULL,
      plan_name      TEXT        NOT NULL,
      period_start   TIMESTAMPTZ NOT NULL,
      period_end     TIMESTAMPTZ NOT NULL,
      subtotal_cents INTEGER     NOT NULL DEFAULT 0,
      tax_rate_pct   NUMERIC     NOT NULL DEFAULT 16,
      tax_cents      INTEGER     NOT NULL DEFAULT 0,
      total_cents    INTEGER     NOT NULL DEFAULT 0,
      status         TEXT        NOT NULL DEFAULT 'issued',
      payment_method TEXT,
      payment_ref    TEXT,
      issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at        TIMESTAMPTZ,
      voided_at      TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Uma fatura ativa por empresa e período — impede duplicados na renovação
  // (que é preguiçosa: acontece na primeira leitura após o fim do período).
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_sub_invoices_period ON subscription_invoices (company_id, period_start) WHERE status <> 'void';`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sub_invoices_company ON subscription_invoices (company_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sub_invoices_status ON subscription_invoices (status);`);

  // Empresas anteriores aos planos ficam em `enterprise` (ilimitado, preço 0 →
  // faturação fora da plataforma): nenhuma operação existente passa a ser
  // bloqueada por falta de subscrição.
  const { rows } = await client.query("SELECT to_regclass('public.companies') AS t");
  if (rows[0].t !== null) {
    await client.query(`
      INSERT INTO subscriptions (id, company_id, plan_code, status, current_period_start, current_period_end)
      SELECT 'sub-' || c.id, c.id, 'enterprise', 'active', NOW(), NOW() + INTERVAL '1 month'
      FROM companies c
      WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.company_id = c.id);
    `);
  }
}

module.exports = { applySaasSchema };
