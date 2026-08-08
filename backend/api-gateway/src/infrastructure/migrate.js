/**
 * @file migrate.js
 * @description Migração inicial — cria tabelas no banco PostgreSQL "track".
 *
 * Executa DDL idempotente (com DROP TABLE para limpeza completa em desenvolvimento) — seguro rodar múltiplas vezes.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Pedido, Motorista, EventoRastreio)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.3 (timestamps sempre em UTC — timestamptz)
 *
 * Entidades criadas (em inglês):
 *   - orders
 *   - drivers
 *   - warehouses           (gestão dinâmica de armazéns)
 *   - warehouse_movements  (auditoria de entrada/envio — spec § 4)
 *
 * Uso:
 *   node src/infrastructure/migrate.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applySaasSchema } = require('./migrations/saas');
const { applyFiscalSchema } = require('./migrations/fiscal');
const { applyBrandingSchema } = require('./migrations/branding');
const { applyAuditSchema } = require('./migrations/audit');
const { applyPasswordResetSchema } = require('./migrations/password-reset');
const { applyOrdersIndexSchema } = require('./migrations/orders-index');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate] Iniciando migração no banco "track"...');
    await client.query('BEGIN');

    // Em dev, limpamos as tabelas antigas para evitar mistura de colunas pt/en
    await client.query('DROP TABLE IF EXISTS warehouse_movements CASCADE;');
    await client.query('DROP TABLE IF EXISTS warehouses CASCADE;');
    await client.query('DROP TABLE IF EXISTS driver_settlements CASCADE;');
    // Vai junto com `orders`: as imagens do comprovativo referem-se a pedidos por
    // id e não têm FK (a tabela de pedidos é recriada aqui). Deixá-las de pé era
    // guardar provas de entregas que já não existem. Recriada por migrate-pod-images.
    await client.query('DROP TABLE IF EXISTS order_pod_images CASCADE;');
    await client.query('DROP TABLE IF EXISTS orders CASCADE;');
    await client.query('DROP TABLE IF EXISTS drivers CASCADE;');

    // ── orders ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE orders (
        id                    TEXT        PRIMARY KEY,
        client_id             TEXT        NOT NULL,
        client_phone          TEXT,
        client_email          TEXT,
        tracking_code         TEXT        NOT NULL UNIQUE,
        current_status        TEXT        NOT NULL DEFAULT 'created',
        origin                JSONB       NOT NULL DEFAULT '{}',
        destination           JSONB       NOT NULL DEFAULT '{}',
        carrier_intl_id       TEXT,
        driver_id             TEXT,
        route_id              TEXT,
        warehouse_id          TEXT,
        pod                   JSONB,
        delivery_otp          JSONB,
        cod_amount            INTEGER     NOT NULL DEFAULT 0,
        cod_status            TEXT        NOT NULL DEFAULT 'none',
        cod                   JSONB,
        cod_settlement_id     TEXT,
        value                 INTEGER     NOT NULL DEFAULT 0,
        history               JSONB       NOT NULL DEFAULT '[]',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── warehouses (gestão dinâmica de armazéns) ───────────────────────────────
    // status: 'active' | 'inactive'  ·  capacity: 0 = ilimitada
    await client.query(`
      CREATE TABLE warehouses (
        id                    TEXT        PRIMARY KEY,
        code                  TEXT        NOT NULL UNIQUE,
        name                  TEXT        NOT NULL,
        address               JSONB       NOT NULL DEFAULT '{}',
        capacity              INTEGER     NOT NULL DEFAULT 0,
        status                TEXT        NOT NULL DEFAULT 'active',
        gps                   JSONB,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── warehouse_movements (auditoria imutável — spec § 4) ────────────────────
    // type: 'intake' (entrada) | 'dispatch' (envio)
    await client.query(`
      CREATE TABLE warehouse_movements (
        id                    TEXT        PRIMARY KEY,
        warehouse_id          TEXT        NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
        order_id              TEXT        NOT NULL,
        tracking_code         TEXT,
        type                  TEXT        NOT NULL,
        notes                 TEXT,
        user_id               TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── drivers ──────────────────────────────────────────────────────────────
    // current_status: 'available' | 'on_route' | 'offline'
    await client.query(`
      CREATE TABLE drivers (
        id                    TEXT        PRIMARY KEY,
        name                  TEXT        NOT NULL,
        email                 TEXT        NOT NULL UNIQUE,
        phone                 TEXT,
        vehicle               JSONB       NOT NULL DEFAULT '{}',
        current_status        TEXT        NOT NULL DEFAULT 'available',
        performance_metrics   JSONB       NOT NULL DEFAULT '{}',
        gps                   JSONB,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── driver_settlements (acerto de caixa do motorista — COD, spec § 3.5) ────
    // status: 'open' | 'reconciled'. Valores em centavos (MZN).
    await client.query(`
      CREATE TABLE driver_settlements (
        id                    TEXT        PRIMARY KEY,
        driver_id             TEXT        NOT NULL,
        status                TEXT        NOT NULL DEFAULT 'open',
        order_count           INTEGER     NOT NULL DEFAULT 0,
        expected_cash_cents   INTEGER     NOT NULL DEFAULT 0,
        expected_mobile_cents INTEGER     NOT NULL DEFAULT 0,
        expected_total_cents  INTEGER     NOT NULL DEFAULT 0,
        received_cash_cents   INTEGER,
        difference_cents      INTEGER,
        order_ids             JSONB       NOT NULL DEFAULT '[]',
        notes                 TEXT,
        opened_by             TEXT,
        reconciled_by         TEXT,
        opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reconciled_at         TIMESTAMPTZ
      );
    `);

    // ── users (contas do painel) ───────────────────────────────────────────────
    // NÃO é dropada: as contas registadas persistem entre migrações de dev.
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT        PRIMARY KEY,
        name          TEXT        NOT NULL,
        email         TEXT        NOT NULL UNIQUE,
        password_hash TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'ADMIN',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── clients (registo de clientes/remetentes — spec § 3.12) ────────────────
    // NÃO é dropada: o registo de clientes persiste entre migrações de dev.
    // type: 'individual' | 'business'  ·  status: 'active' | 'inactive'
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id          TEXT        PRIMARY KEY,
        name        TEXT        NOT NULL,
        type        TEXT        NOT NULL DEFAULT 'individual',
        email       TEXT,
        phone       TEXT,
        tax_id      TEXT,
        address     JSONB,
        notes       TEXT,
        status      TEXT        NOT NULL DEFAULT 'active',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_clients_status ON clients (status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_clients_name ON clients (lower(name));`);
    // Ligação pedido → cliente (nullable: pedidos antigos continuam válidos).
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_ref_id TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_client_ref ON orders (client_ref_id);`);

    // ── pricing_zones (tarifação por peso/zona — spec § 3.13) ─────────────────
    // NÃO é dropada: as tabelas de tarifa persistem entre migrações de dev.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pricing_zones (
        id           TEXT        PRIMARY KEY,
        code         TEXT        NOT NULL UNIQUE,
        name         TEXT        NOT NULL,
        base_cents   INTEGER     NOT NULL DEFAULT 0,
        per_kg_cents INTEGER     NOT NULL DEFAULT 0,
        included_kg  NUMERIC     NOT NULL DEFAULT 1,
        active       BOOLEAN     NOT NULL DEFAULT TRUE,
        sort_order   INTEGER     NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Zonas por default de Moçambique (idempotente — não sobrepõe edições).
    await client.query(`
      INSERT INTO pricing_zones (id, code, name, base_cents, per_kg_cents, included_kg, sort_order) VALUES
        ('zone-maputo-city',   'MAPUTO_CITY',   'Maputo Cidade',                  15000,  2500, 1, 1),
        ('zone-grande-maputo', 'GRANDE_MAPUTO', 'Grande Maputo (Matola/Marracuene)', 25000, 3500, 1, 2),
        ('zone-sul',           'SUL',           'Região Sul',                     40000,  6000, 1, 3),
        ('zone-centro',        'CENTRO',        'Região Centro',                  65000,  9000, 1, 4),
        ('zone-norte',         'NORTE',         'Região Norte',                   90000, 12000, 1, 5),
        ('zone-intl',          'INTERNACIONAL', 'Internacional',                 250000, 40000, 1, 6)
      ON CONFLICT (code) DO NOTHING;
    `);
    // Campos de tarifação no pedido (nullable: pedidos antigos continuam válidos).
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_grams INTEGER;`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing JSONB;`);

    // ── invoices / invoice_counters (faturação — spec § 3.14) ─────────────────
    // NÃO são dropadas: as faturas e os contadores persistem. Numeração FT{ano}/{seq}.
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_counters (
        year      INTEGER PRIMARY KEY,
        last_seq  INTEGER NOT NULL DEFAULT 0
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id             TEXT        PRIMARY KEY,
        number         TEXT        NOT NULL UNIQUE,
        order_id       TEXT,
        tracking_code  TEXT,
        client_ref_id  TEXT,
        client_name    TEXT        NOT NULL,
        client_tax_id  TEXT,
        client_email   TEXT,
        items          JSONB       NOT NULL DEFAULT '[]',
        subtotal_cents INTEGER     NOT NULL DEFAULT 0,
        tax_rate_pct   NUMERIC     NOT NULL DEFAULT 16,
        tax_cents      INTEGER     NOT NULL DEFAULT 0,
        total_cents    INTEGER     NOT NULL DEFAULT 0,
        status         TEXT        NOT NULL DEFAULT 'issued',
        payment_method TEXT,
        notes          TEXT,
        issued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at        TIMESTAMPTZ,
        voided_at      TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // No máximo uma fatura não-anulada por pedido.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_invoices_active_order ON invoices (order_id) WHERE order_id IS NOT NULL AND status <> 'void';`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_issued_at ON invoices (issued_at DESC);`);

    // ── support_threads / support_messages (chat de suporte — spec § 3.9) ──────
    // NÃO são dropadas: as conversas persistem entre migrações de dev (como users).
    // sender: 'client' | 'agent' | 'system' | 'bot' (bot reservado — atendimento futuro).
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_threads (
        id                TEXT        PRIMARY KEY,
        client_name       TEXT        NOT NULL,
        client_email      TEXT,
        subject           TEXT        NOT NULL,
        order_id          TEXT,
        tracking_code     TEXT,
        status            TEXT        NOT NULL DEFAULT 'open',
        assigned_agent_id TEXT,
        client_token_hash TEXT        NOT NULL,
        last_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id            TEXT        PRIMARY KEY,
        thread_id     TEXT        NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        sender        TEXT        NOT NULL,
        sender_id     TEXT,
        sender_name   TEXT        NOT NULL,
        body          TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads (status);
      CREATE INDEX IF NOT EXISTS idx_support_threads_last_msg ON support_threads (last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages (thread_id, created_at);
    `);

    // ── Índices de performance ────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX idx_orders_tracking_code ON orders (tracking_code);
      CREATE INDEX idx_orders_current_status ON orders (current_status);
      CREATE INDEX idx_orders_driver_id    ON orders (driver_id);
      CREATE INDEX idx_orders_warehouse_id ON orders (warehouse_id);
      CREATE INDEX idx_orders_cod_status   ON orders (cod_status);
      CREATE INDEX idx_orders_cod_settlement ON orders (cod_settlement_id);
      CREATE INDEX idx_drivers_current_status ON drivers (current_status);
      CREATE INDEX idx_warehouses_status ON warehouses (status);
      CREATE INDEX idx_wh_movements_warehouse_id ON warehouse_movements (warehouse_id);
      CREATE INDEX idx_settlements_driver ON driver_settlements (driver_id);
      CREATE INDEX idx_settlements_status ON driver_settlements (status);
    `);

    // ── Multiempresa (spec § 2.4) ─────────────────────────────────────────────
    // Entidade `companies` + `company_id` em todas as tabelas de tenant. ADD COLUMN
    // com DEFAULT preenche as linhas existentes (backfill) para a Empresa Padrão.
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id         TEXT        PRIMARY KEY,
        name       TEXT        NOT NULL,
        slug       TEXT        UNIQUE,
        status     TEXT        NOT NULL DEFAULT 'active',
        plan       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`INSERT INTO companies (id, name, slug) VALUES ('company-default','Empresa Padrão','empresa-padrao') ON CONFLICT (id) DO NOTHING;`);

    // `user_locations` era criada apenas em runtime (`UserLocationRepository.ensureTable`),
    // mas o backfill de `company_id` logo abaixo precisa dela — numa base vazia a
    // migração rebentava com "relação user_locations não existe". DDL igual à do
    // repositório: DOUBLE PRECISION para o driver devolver number, não string.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_locations (
        user_id    TEXT PRIMARY KEY,
        email      TEXT,
        role       TEXT,
        lat        DOUBLE PRECISION NOT NULL,
        lng        DOUBLE PRECISION NOT NULL,
        accuracy   DOUBLE PRECISION,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const t of ['orders', 'drivers', 'warehouses', 'warehouse_movements', 'driver_settlements', 'clients', 'pricing_zones', 'invoices', 'support_threads', 'support_messages', 'users', 'user_locations']) {
      await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'company-default';`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${t}_company ON ${t} (company_id);`);
    }
    // SUPERADMIN não pertence a nenhuma empresa — users.company_id é anulável.
    await client.query(`ALTER TABLE users ALTER COLUMN company_id DROP NOT NULL;`);
    // Numeração de faturas independente por empresa: counter por (company_id, year).
    await client.query(`ALTER TABLE invoice_counters ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'company-default';`);
    await client.query(`ALTER TABLE invoice_counters DROP CONSTRAINT IF EXISTS invoice_counters_pkey;`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_counters_pkey') THEN
        ALTER TABLE invoice_counters ADD PRIMARY KEY (company_id, year);
      END IF;
    END $$;`);
    // Número de fatura único POR EMPRESA (a numeração reinicia por empresa).
    await client.query(`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_number_key;`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_invoices_company_number ON invoices (company_id, number);`);
    // Código único por empresa (havia unicidade global).
    await client.query(`ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_code_key;`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_warehouses_company_code ON warehouses (company_id, code);`);
    await client.query(`ALTER TABLE pricing_zones DROP CONSTRAINT IF EXISTS pricing_zones_code_key;`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_pricing_zones_company_code ON pricing_zones (company_id, code);`);

    // ── Planos, subscrições e limites (SaaS — spec § 2.5) ──────────────────────
    // DDL aditivo partilhado com `migrate-saas.js`, que corre em bases já com
    // dados (este ficheiro é destrutivo e só corre em bases vazias).
    await applySaasSchema(client);

    // ── Conformidade fiscal (spec § 3.19) ─────────────────────────────────────
    // Idem: partilhado com `migrate-fiscal.js`.
    await applyFiscalSchema(client);

    // ── Perfil/marca da empresa (spec § 3.20) ─────────────────────────────────
    // Idem: partilhado com `migrate-branding.js`.
    await applyBrandingSchema(client);

    // ── Registo de auditoria (spec § 3.21) ────────────────────────────────────
    // Idem: partilhado com `migrate-audit.js`.
    await applyAuditSchema(client);

    // ── Recuperação de senha (spec § 3.22) ────────────────────────────────────
    // Idem: partilhado com `migrate-password-reset.js`.
    await applyPasswordResetSchema(client);

    // ── Índices da listagem paginada de pedidos (spec § 3.1) ──────────────────
    await applyOrdersIndexSchema(client);

    // ── Recursos Humanos (núcleo profissional) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_departments (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT 'company-default',
        name TEXT NOT NULL, code TEXT NOT NULL, manager_name TEXT,
        description TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, code)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_employees (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT 'company-default', employee_number TEXT NOT NULL,
        full_name TEXT NOT NULL, email TEXT, phone TEXT, tax_id TEXT, birth_date DATE,
        gender TEXT, address JSONB, emergency_contact JSONB, department_id TEXT,
        job_title TEXT NOT NULL, employment_type TEXT NOT NULL DEFAULT 'permanent',
        hire_date DATE NOT NULL, salary_cents INTEGER NOT NULL DEFAULT 0, bank_details JSONB,
        status TEXT NOT NULL DEFAULT 'active', notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (company_id, employee_number)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS hr_leave_requests (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT 'company-default', employee_id TEXT NOT NULL,
        type TEXT NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL, days INTEGER NOT NULL,
        reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decision_notes TEXT,
        decided_by TEXT, decided_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hr_employees_company_status ON hr_employees(company_id, status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hr_leave_company_status ON hr_leave_requests(company_id, status);`);
    await client.query(`CREATE TABLE IF NOT EXISTS hr_attendance (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL DEFAULT 'company-default', employee_id TEXT NOT NULL,
      work_date DATE NOT NULL, clock_in TIMESTAMPTZ, clock_out TIMESTAMPTZ,
      break_minutes INTEGER NOT NULL DEFAULT 60, worked_minutes INTEGER NOT NULL DEFAULT 0,
      late_minutes INTEGER NOT NULL DEFAULT 0, overtime_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'present', notes TEXT, adjusted_by TEXT, adjusted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(company_id, employee_id, work_date)
    );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_hr_attendance_company_date ON hr_attendance(company_id, work_date);`);
    await client.query(`CREATE TABLE IF NOT EXISTS hr_payroll_runs (id TEXT PRIMARY KEY,company_id TEXT NOT NULL DEFAULT 'company-default',period TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',employee_count INTEGER NOT NULL DEFAULT 0,gross_cents BIGINT NOT NULL DEFAULT 0,deductions_cents BIGINT NOT NULL DEFAULT 0,net_cents BIGINT NOT NULL DEFAULT 0,approved_by TEXT,approved_at TIMESTAMPTZ,paid_by TEXT,paid_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(company_id,period));`);
    await client.query(`CREATE TABLE IF NOT EXISTS hr_payroll_items (id TEXT PRIMARY KEY,company_id TEXT NOT NULL DEFAULT 'company-default',payroll_id TEXT NOT NULL,employee_id TEXT NOT NULL,base_salary_cents INTEGER NOT NULL DEFAULT 0,allowances_cents INTEGER NOT NULL DEFAULT 0,bonus_cents INTEGER NOT NULL DEFAULT 0,overtime_cents INTEGER NOT NULL DEFAULT 0,tax_cents INTEGER NOT NULL DEFAULT 0,social_security_cents INTEGER NOT NULL DEFAULT 0,other_deductions_cents INTEGER NOT NULL DEFAULT 0,gross_cents INTEGER NOT NULL DEFAULT 0,deductions_cents INTEGER NOT NULL DEFAULT 0,net_cents INTEGER NOT NULL DEFAULT 0,notes TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(company_id,payroll_id,employee_id));`);

    await client.query('COMMIT');
    console.info('[migrate] ✅ Tabelas criadas/verificadas com sucesso (em Inglês).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] ❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ── Seed de dados iniciais ────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();
  try {
    console.info('[seed] Inserindo dados iniciais de demonstração (em Inglês)...');
    const now  = new Date().toISOString();
    const h1   = new Date(Date.now() - 3_600_000).toISOString();
    const h2   = new Date(Date.now() - 7_200_000).toISOString();
    const d1   = new Date(Date.now() - 86_400_000).toISOString();
    const d2   = new Date(Date.now() - 172_800_000).toISOString();
    const d7   = new Date(Date.now() - 604_800_000).toISOString();

    await client.query('BEGIN');

    // Armazéns — cadastro inicial (gestão dinâmica)
    const warehouses = [
      {
        id: 'wh-test-uuid-0001', code: 'WH-MPT', name: 'Armazém Central - Maputo',
        address: { city: 'Maputo', state: 'MPM', country: 'MZ' },
        capacity: 500, status: 'active', gps: { lat: -25.9692, lng: 32.5732 },
      },
      {
        id: 'wh-test-uuid-0002', code: 'WH-MTL', name: 'Centro de Triagem - Matola',
        address: { city: 'Matola', state: 'MPM', country: 'MZ' },
        capacity: 300, status: 'active', gps: { lat: -25.9622, lng: 32.4589 },
      },
      {
        id: 'wh-test-uuid-0003', code: 'WH-BEIRA', name: 'Armazém Regional - Beira',
        address: { city: 'Beira', state: 'SOF', country: 'MZ' },
        capacity: 200, status: 'active', gps: { lat: -19.8436, lng: 34.8389 },
      },
    ];
    for (const w of warehouses) {
      await client.query(`
        INSERT INTO warehouses (id, code, name, address, capacity, status, gps, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      `, [w.id, w.code, w.name, JSON.stringify(w.address), w.capacity, w.status, JSON.stringify(w.gps), d7]);
    }

    // Pedido 1 — nacional em trânsito
    await client.query(`
      INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination, driver_id, value, history, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      'order-test-uuid-0001',
      'Carlos Silva',
      'TRK00000001BR',
      'in_transit',
      JSON.stringify({ city: 'São Paulo', state: 'SP', country: 'BR' }),
      JSON.stringify({ city: 'São Paulo', state: 'SP', country: 'BR' }),
      'driver-test-uuid-0001',
      2990,
      JSON.stringify([
        { status: 'in_transit', description: 'Package in transit between hubs', location: 'São Paulo - SP', timestamp: now },
        { status: 'collected',  description: 'Package collected by logistics team', location: 'São Paulo - SP', timestamp: h1  },
        { status: 'created',    description: 'Order registered in the system', location: 'São Paulo - SP', timestamp: h2  },
      ]),
      h2,
      now,
    ]);

    // Pedido 2 — internacional no armazém (ligado ao Armazém Central - Maputo)
    await client.query(`
      INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination, carrier_intl_id, driver_id, warehouse_id, value, history, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      'order-test-uuid-0002',
      'Ana Oliveira',
      'LX987654321CN',
      'at_warehouse',
      JSON.stringify({ city: 'Shenzhen', state: 'GD', country: 'CN' }),
      JSON.stringify({ city: 'Rio de Janeiro', state: 'RJ', country: 'BR' }),
      '17TRACK',
      'driver-test-uuid-0002',
      'wh-test-uuid-0001',
      8990,
      JSON.stringify([
        { status: 'at_warehouse', description: 'Received at national sorting center', location: 'Armazém Central - Maputo', timestamp: now },
        { status: 'in_transit',   description: 'Released by Customs in Brazil', location: 'Guarulhos Airport - SP', timestamp: d1  },
        { status: 'in_transit',   description: 'Package in transit to Brazil', location: 'Hong Kong', timestamp: d2  },
        { status: 'created',      description: 'Order dispatched by sender', location: 'Shenzhen - China', timestamp: d7  },
      ]),
      d7,
      now,
    ]);

    // Movimento de entrada correspondente (auditoria)
    await client.query(`
      INSERT INTO warehouse_movements (id, warehouse_id, order_id, tracking_code, type, notes, user_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      'wh-mov-test-uuid-0001',
      'wh-test-uuid-0001',
      'order-test-uuid-0002',
      'LX987654321CN',
      'intake',
      'Encomenda recebida e conferida no armazém.',
      null,
      now,
    ]);

    // Motoristas
    const drivers = [
      {
        id: 'driver-test-uuid-0001', name: 'Marcos Souza', email: 'marcos.souza@test.com',
        phone: '+5511999990001',
        vehicle: { type: 'MOTO', plate: 'TST-1234', capacity_kg: 20 },
        current_status: 'on_route',
        metrics: { punctuality: 96, success_rate: 98, customer_rating: 4.9, total_deliveries: 142 },
        gps: { lat: -23.5505, lng: -46.6333, heading: 45, speed: 35, updatedAt: now },
      },
      {
        id: 'driver-test-uuid-0002', name: 'Pedro Santos', email: 'pedro.santos@test.com',
        phone: '+5511999990002',
        vehicle: { type: 'VAN', plate: 'TST-5678', capacity_kg: 500 },
        current_status: 'available',
        metrics: { punctuality: 92, success_rate: 95, customer_rating: 4.7, total_deliveries: 88 },
        gps: { lat: -23.5629, lng: -46.6544, heading: 120, speed: 0, updatedAt: now },
      },
      {
        id: 'driver-test-uuid-0003', name: 'Lucas Lima', email: 'lucas.lima@test.com',
        phone: '+5511999990003',
        vehicle: { type: 'CARRO', plate: 'TST-9012', capacity_kg: 150 },
        current_status: 'available',
        metrics: { punctuality: 98, success_rate: 100, customer_rating: 5.0, total_deliveries: 210 },
        gps: { lat: -23.5489, lng: -46.6388, heading: 270, speed: 28, updatedAt: now },
      },
    ];

    for (const d of drivers) {
      await client.query(`
        INSERT INTO drivers (id, name, email, phone, vehicle, current_status, performance_metrics, gps, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [d.id, d.name, d.email, d.phone, JSON.stringify(d.vehicle), d.current_status, JSON.stringify(d.metrics), JSON.stringify(d.gps), now]);
    }

    await client.query('COMMIT');
    console.info('[seed] ✅ Dados iniciais inseridos com sucesso (em Inglês).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] ❌ Erro no seed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await migrate();
    await seed();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Falha fatal:', err);
  process.exit(1);
});
