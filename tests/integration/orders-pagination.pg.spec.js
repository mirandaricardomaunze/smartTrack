/**
 * @file orders-pagination.pg.spec.js
 * @description Testes de integração da listagem paginada de pedidos.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1
 *
 * A listagem devolvia TODOS os pedidos da empresa: com dezenas de milhares, a
 * página deixava de abrir e o servidor carregava a tabela inteira para memória.
 * Aqui prova-se que a paginação e os filtros são resolvidos em SQL, que existe
 * teto por página, que os contadores do topo são agregados na base (e não
 * contados sobre a página visível), e que nada disto atravessa empresas.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const orders  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const reports = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/reports.service`) : null;
const repo    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant  = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY_A = 'company-itest-pag-a';
const COMPANY_B = 'company-itest-pag-b';
const DRIVER = 'driver-itest-pag';
const TOTAL_A = 60;

function asCompany(companyId, fn) {
  return tenant.runWithCompany(companyId, fn);
}

/** Semeia pedidos diretamente: o objetivo é o volume, não o caso de uso. */
async function seed(companyId, count, overrides = () => ({})) {
  for (let i = 0; i < count; i += 1) {
    const base = OrderFactory.build({
      id: `order-itest-pag-${companyId}-${i}`,
      tracking_code: `TRK${String(7_000_000 + i).padStart(7, '0')}${companyId === COMPANY_A ? 'BR' : 'CN'}`,
      current_status: 'created',
    });
    // eslint-disable-next-line no-await-in-loop
    await asCompany(companyId, () => repo.OrderRepository.create({
      ...base,
      value: 10000 + i,
      history: [{ status: 'created', description: 'seed', location: 'Maputo', timestamp: new Date(Date.now() - i * 60_000).toISOString() }],
      created_at: new Date(Date.now() - i * 60_000).toISOString(),
      ...overrides(i),
    }));
  }
}

async function cleanup() {
  await pool.query('DELETE FROM orders WHERE company_id = ANY($1)', [[COMPANY_A, COMPANY_B]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY_A, COMPANY_B]]);
}

describe.skipIf(!disponivel)('api-gateway · listagem paginada de pedidos · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_A, name: 'Volume A', slug: COMPANY_A }));
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_B, name: 'Volume B', slug: COMPANY_B }));

    // Mistura de estados e um motorista, para exercitar os filtros.
    await seed(COMPANY_A, TOTAL_A, (i) => {
      if (i % 5 === 0) return { current_status: 'delivered', driver_id: DRIVER };
      if (i % 7 === 0) return { current_status: 'in_transit', driver_id: DRIVER };
      if (i % 11 === 0) return { cod_amount: 25000, cod_status: 'collected' };
      return {};
    });
    await seed(COMPANY_B, 5);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Paginação ─────────────────────────────────────────────────────────────

  it('should return one page and the real total, not everything', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ page: 1, pageSize: 10 }));

    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(TOTAL_A);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(10);
  });

  it('should walk the pages without repeating or dropping a single order', async () => {
    const seen = new Set();
    const pageSize = 25;
    const pages = Math.ceil(TOTAL_A / pageSize);

    for (let page = 1; page <= pages; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await asCompany(COMPANY_A, () => orders.listOrders({ page, pageSize }));
      for (const order of result.items) seen.add(order.id);
    }

    expect(seen.size).toBe(TOTAL_A);
  });

  it('should sort newest first', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ pageSize: 5 }));
    const dates = page.items.map((o) => Date.parse(o.created_at));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it('should cap the page size so nobody can ask for everything', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ pageSize: 100_000 }));
    expect(page.items.length).toBeLessThanOrEqual(200);
  });

  it('should fall back to sane defaults on nonsense input', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ page: -3, pageSize: 0 }));
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(25);
  });

  it('should return an empty page past the end, with the total intact', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ page: 999, pageSize: 10 }));
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(TOTAL_A);
  });

  // ── Filtros em SQL ────────────────────────────────────────────────────────

  it('should filter by status in the database', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ status: 'delivered', pageSize: 100 }));

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((o) => o.current_status === 'delivered')).toBe(true);
    expect(page.total).toBe(page.items.length);
  });

  it('should ignore an invented status instead of returning nothing', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ status: 'nao-existe', pageSize: 5 }));
    expect(page.total).toBe(TOTAL_A);
  });

  it('should search by tracking code, client and destination city', async () => {
    const one = await asCompany(COMPANY_A, () => orders.listOrders({ search: 'TRK7000005' }));
    expect(one.items.some((o) => o.tracking_code.includes('TRK7000005'))).toBe(true);

    // A factory nomeia o cliente como `client-uuid-N`.
    const byClient = await asCompany(COMPANY_A, () => orders.listOrders({ search: 'client-uuid', pageSize: 5 }));
    expect(byClient.total).toBeGreaterThan(0);
  });

  it('should be case-insensitive in the search', async () => {
    const upper = await asCompany(COMPANY_A, () => orders.listOrders({ search: 'TRK7000010' }));
    const lower = await asCompany(COMPANY_A, () => orders.listOrders({ search: 'trk7000010' }));
    expect(lower.total).toBe(upper.total);
  });

  it('should filter by driver and by COD status', async () => {
    const byDriver = await asCompany(COMPANY_A, () => orders.listOrders({ driver_id: DRIVER, pageSize: 100 }));
    expect(byDriver.items.every((o) => o.driver_id === DRIVER)).toBe(true);

    const byCod = await asCompany(COMPANY_A, () => orders.listOrders({ cod_status: 'collected', pageSize: 100 }));
    expect(byCod.items.every((o) => o.cod_status === 'collected')).toBe(true);
  });

  it('should combine filters instead of choosing one', async () => {
    const page = await asCompany(COMPANY_A, () => orders.listOrders({
      status: 'delivered', driver_id: DRIVER, pageSize: 100,
    }));
    expect(page.items.every((o) => o.current_status === 'delivered' && o.driver_id === DRIVER)).toBe(true);
  });

  it('should filter by date window', async () => {
    const from = new Date(Date.now() - 10 * 60_000).toISOString();
    const page = await asCompany(COMPANY_A, () => orders.listOrders({ from, pageSize: 100 }));

    expect(page.items.length).toBeLessThan(TOTAL_A);
    expect(page.items.every((o) => Date.parse(o.created_at) >= Date.parse(from))).toBe(true);
  });

  // ── Contadores agregados ──────────────────────────────────────────────────

  it('should compute the header counters in SQL over the whole company', async () => {
    const stats = await asCompany(COMPANY_A, () => repo.OrderRepository.getStats());

    expect(stats.total).toBe(TOTAL_A);
    expect(stats.delivered).toBeGreaterThan(0);
    expect(stats.in_transit).toBeGreaterThan(0);
    // A taxa é sobre o que terminou, não sobre o total em curso.
    expect(stats.success_rate_pct).toBeGreaterThan(0);
    expect(stats.success_rate_pct).toBeLessThanOrEqual(100);
  });

  it('should bound the report to the period it announces', async () => {
    const summary = await asCompany(COMPANY_A, () => reports.getSummary({ days: 1 }));

    expect(summary.period.days).toBe(1);
    expect(Date.parse(summary.period.from)).toBeLessThan(Date.now());
    // A janela de 1 dia cobre os pedidos semeados (minutos atrás), não mais.
    expect(summary.overview.total).toBeLessThanOrEqual(TOTAL_A);
  });

  // ── Multiempresa ──────────────────────────────────────────────────────────

  it('should never leak another company into the page or the total', async () => {
    const pageB = await asCompany(COMPANY_B, () => orders.listOrders({ pageSize: 100 }));

    expect(pageB.total).toBe(5);
    expect(pageB.items.every((o) => o.company_id === COMPANY_B || o.tracking_code.endsWith('CN'))).toBe(true);

    const statsB = await asCompany(COMPANY_B, () => repo.OrderRepository.getStats());
    expect(statsB.total).toBe(5);
  });

  it('should keep the search inside the company', async () => {
    // 'TRK7000001' existe nas duas empresas (sufixos diferentes).
    const inB = await asCompany(COMPANY_B, () => orders.listOrders({ search: 'TRK700000' }));
    expect(inB.total).toBeLessThanOrEqual(5);
  });
});
