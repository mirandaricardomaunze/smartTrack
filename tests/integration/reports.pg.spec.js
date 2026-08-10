/**
 * @file reports.pg.spec.js
 * @description Testes de integração dos relatórios/analytics contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.8, § 3.4
 *
 * Prova, contra a base real (`track`), o caminho persistência → cálculo: um
 * conjunto controlado de pedidos (via factories) é gravado e relido, e as funções
 * puras `compute*` produzem exatamente os KPIs, a série de volume, a distribuição
 * por estado e o desempenho por motorista esperados. O caso end-to-end confirma
 * ainda que `getSummary` reflete o motorista semeado mesmo com dados globais na base.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory }  from '../harness/factories/order.factory';
import { DriverFactory } from '../harness/factories/driver.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/reports.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const DRV = 'driver-itest-rep-0001';
const A = 'order-itest-rep-0001'; // entregue em 24h, COD numerário 5000
const B = 'order-itest-rep-0002'; // entregue em 72h, COD mobile 3000
const C = 'order-itest-rep-0003'; // insucesso, do motorista
const D = 'order-itest-rep-0004'; // em trânsito (ativo), sem motorista
const E = 'order-itest-rep-0005'; // cancelado, sem motorista
const IDS = [A, B, C, D, E];

const NOW = Date.now();
const H = 3_600_000;
const DAY = 86_400_000;
/** Chave 'YYYY-MM-DD' (UTC) de `daysAgo` dias atrás — alinha com computeVolume. */
const dayKey = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

/** Grava um pedido a partir da factory, com campos de persistência controlados. */
async function seed(id, over, extra) {
  const base = OrderFactory.build({ id, tracking_code: `TRK-REP-${id.slice(-4)}`, ...over });
  await repo.OrderRepository.create({ ...base, ...extra });
}

async function cleanup() {
  await pool.query(`DELETE FROM notifications WHERE data->>'orderId' = ANY($1::text[])`, [IDS]);
  for (const id of IDS) await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  await pool.query('DELETE FROM drivers WHERE id = $1', [DRV]);
}

describe.skipIf(!disponivel)('api-gateway · relatórios / analytics · PostgreSQL', () => {
  /** @type {object[]} os 5 pedidos semeados, relidos da base, na ordem A..E */
  let mine;
  /** @type {object} o motorista semeado, relido da base */
  let driver;

  beforeAll(async () => {
    await cleanup();

    const drv = DriverFactory.build({ id: DRV, name: 'Motorista Relatório', email: 'rep-itest@test.com' });
    await pool.query(
      `INSERT INTO drivers (id, name, email, phone, vehicle, current_status, performance_metrics, gps, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [drv.id, drv.name, drv.email, drv.phone, JSON.stringify(drv.vehicle), drv.current_status, JSON.stringify(drv.performance_metrics), null],
    );

    // A — criado há 2 dias, entregue há 1 dia (24h), numerário 5000
    await seed(A, { current_status: 'delivered', driver_id: DRV }, {
      value: 5000, created_at: iso(2 * DAY), updated_at: iso(24 * H),
      cod: { amount: 5000, method: 'CASH' }, cod_amount: 5000, cod_status: 'collected',
      history: [{ status: 'delivered', description: 'entregue', location: 'Maputo', timestamp: iso(24 * H) }],
    });
    // B — criado há 4 dias, entregue há 1 dia (72h), mobile 3000
    await seed(B, { current_status: 'delivered', driver_id: DRV }, {
      value: 3000, created_at: iso(4 * DAY), updated_at: iso(24 * H),
      cod: { amount: 3000, method: 'MPESA' }, cod_amount: 3000, cod_status: 'collected',
      history: [{ status: 'delivered', description: 'entregue', location: 'Maputo', timestamp: iso(24 * H) }],
    });
    // C — insucesso, do motorista, criado há 3 dias
    await seed(C, { current_status: 'failed', driver_id: DRV }, {
      value: 1000, created_at: iso(3 * DAY), updated_at: iso(3 * DAY),
      history: [{ status: 'failed', description: 'insucesso', location: 'Maputo', timestamp: iso(2 * DAY) }],
    });
    // D — em trânsito (ativo), sem motorista, criado hoje.
    //
    // `iso(0)` e não `iso(1 * H)`: a série de volume agrupa por dia UTC, e
    // "há uma hora" cai no dia ANTERIOR sempre que a suíte corre na primeira
    // hora depois da meia-noite UTC. O teste passava 23 horas por dia e falhava
    // na outra — o pior tipo de teste, porque quem o vê vermelho procura o
    // defeito no código de produção. Semear no próprio instante de `NOW` faz a
    // asserção `dayKey(0)` valer por construção, a qualquer hora.
    await seed(D, { current_status: 'in_transit' }, {
      value: 2000, created_at: iso(0), updated_at: iso(0), history: [],
    });
    // E — cancelado, sem motorista, criado há 5 dias
    await seed(E, { current_status: 'cancelled' }, {
      value: 4000, created_at: iso(5 * DAY), updated_at: iso(5 * DAY), history: [],
    });

    mine = [];
    for (const id of IDS) mine.push(await repo.OrderRepository.findById(id));
    driver = await repo.DriverRepository.findById(DRV);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should read the seeded orders back from the database', () => {
    expect(mine.every(Boolean)).toBe(true);
    expect(driver?.name).toBe('Motorista Relatório');
  });

  it('should compute the overview KPIs from persisted orders', () => {
    const ov = svc.computeOverview(mine);
    expect(ov.total).toBe(5);
    expect(ov.delivered).toBe(2);
    expect(ov.failed).toBe(1);
    expect(ov.cancelled).toBe(1);
    expect(ov.active).toBe(1);
    expect(ov.success_rate_pct).toBe(66.7);          // 2 / (2+1)
    expect(ov.avg_delivery_hours).toBe(48);          // (24 + 72) / 2
    expect(ov.within_48h_pct).toBe(50);              // A ≤48h, B >48h
    expect(ov.total_value_cents).toBe(15000);        // 5000+3000+1000+2000+4000
    expect(ov.cod_collected_cash_cents).toBe(5000);  // só A (CASH)
    expect(ov.cod_collected_mobile_cents).toBe(3000); // só B (MPESA)
  });

  it('should compute the daily volume series over the last N days', () => {
    const series = svc.computeVolume(mine, 14);
    expect(series).toHaveLength(14);
    expect(series[series.length - 1].date).toBe(dayKey(0)); // termina hoje (UTC)

    const byDate = new Map(series.map((r) => [r.date, r]));
    expect(byDate.get(dayKey(2)).created).toBe(1);   // A
    expect(byDate.get(dayKey(4)).created).toBe(1);   // B
    expect(byDate.get(dayKey(0)).created).toBe(1);   // D (hoje)
    expect(byDate.get(dayKey(1)).delivered).toBe(2); // A + B entregues há 1 dia
  });

  it('should compute the status distribution in canonical order', () => {
    const dist = svc.computeStatusDistribution(mine);
    expect(dist).toEqual([
      { status: 'in_transit', count: 1 },
      { status: 'delivered',  count: 2 },
      { status: 'failed',     count: 1 },
      { status: 'cancelled',  count: 1 },
    ]);
  });

  it('should rank driver performance from persisted orders', () => {
    const [row] = svc.computeByDriver(mine, [driver]);
    expect(row.driver_id).toBe(DRV);
    expect(row.name).toBe('Motorista Relatório'); // resolvido pelo join com drivers
    expect(row.delivered).toBe(2);
    expect(row.failed).toBe(1);
    expect(row.cod_cash_cents).toBe(5000);        // só numerário
    expect(row.success_rate_pct).toBe(66.7);
  });

  it('should surface the seeded driver through getSummary end-to-end', async () => {
    const summary = await svc.getSummary({ days: 14 });
    expect(summary).toHaveProperty('overview');
    expect(summary).toHaveProperty('volume');
    expect(Array.isArray(summary.byDriver)).toBe(true);
    expect(typeof summary.generated_at).toBe('string');

    const row = summary.byDriver.find((d) => d.driver_id === DRV);
    expect(row).toBeDefined();
    expect(row.delivered).toBe(2);
    expect(row.failed).toBe(1);
    expect(row.cod_cash_cents).toBe(5000);
  });
});
