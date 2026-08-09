/**
 * @file profitability.pg.spec.js
 * @description Rentabilidade contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.40
 *
 * O núcleo do cálculo é puro e está coberto em profitability.service.spec.ts. O
 * que só a base mostra é a ligação entre as peças: os abastecimentos de uma
 * viatura chegam à rota do motorista que a conduz, o custo da rota reparte-se
 * pelas encomendas, e uma encomenda sem rota sai marcada como tal em vez de
 * aparecer com margem de 100%.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { DriverFactory } from '../harness/factories/driver.factory';
import { ProfitabilityFactory } from '../harness/factories/profitability.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const profitability = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/profitability.service`) : null;
const tenant        = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const repos         = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool          = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA   = 'company-itest-prof';
const MOTORISTA = 'driver-itest-prof';
const VIATURA   = 'vehicle-itest-prof';
const MATRICULA = 'PROF001';
const ROTA      = 'route-itest-prof';
const COM_ROTA  = ['order-itest-prof-1', 'order-itest-prof-2'];
const SEM_ROTA  = 'order-itest-prof-3';

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM fleet_fuel_entries WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM fleet_vehicles WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM routes WHERE id = $1', [ROTA]);
  await pool.query('DELETE FROM orders WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM drivers WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

/** Encomenda entregue, com o valor que é a receita. */
async function semearEntregue(id, valorCents) {
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination,
      cod_amount, cod_status, value, history, created_at, updated_at, company_id)
    VALUES ($1,'cliente.prof@itest.mz',$2,'delivered','{}'::jsonb,'{"city":"Maputo"}'::jsonb,
      0,'none',$3,'[]'::jsonb,$4,$4,$5)
  `, [id, `TRK98${id.slice(-1)}000001BR`, valorCents, now, EMPRESA]);
}

const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

describe.skipIf(!disponivel)('rentabilidade · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await repos.CompanyRepository.create({
      id: EMPRESA, name: 'Rentabilidade ITEST', slug: EMPRESA,
      status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    await naEmpresa(async () => {
      await repos.DriverRepository.create(DriverFactory.build({
        id: MOTORISTA, name: 'Motorista Rentabilidade', email: 'prof@itest.mz',
        vehicle: { type: 'VAN', plate: MATRICULA, capacity_kg: 1000 },
      }));
    });

    await pool.query(`
      INSERT INTO fleet_vehicles (id, company_id, plate, make, model, fuel_type)
      VALUES ($1,$2,$3,'Toyota','Hiace','diesel')
    `, [VIATURA, EMPRESA, MATRICULA]);

    // Dois depósitos cheios a 400 km: 20.000 / 400 = 50 centavos/km.
    for (const f of ProfitabilityFactory.fuelFills(VIATURA)) {
      await pool.query(`
        INSERT INTO fleet_fuel_entries (id, company_id, vehicle_id, fuel_date, odometer_km, volume_ml, cost_cents, full_tank)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [`fuel-${f.odometer_km}`, EMPRESA, VIATURA, f.fuel_date, f.odometer_km, f.volume_ml, f.cost_cents, f.full_tank]);
    }

    for (const id of COM_ROTA) await semearEntregue(id, 30_000);
    await semearEntregue(SEM_ROTA, 30_000);

    // Rota de 100 km com as duas primeiras encomendas.
    await pool.query(`
      INSERT INTO routes (id, company_id, driver_id, status, stops, distance_km, optimized_at, created_at, updated_at)
      VALUES ($1,$2,$3,'PLANEJADA',$4::jsonb,100,NOW(),NOW(),NOW())
    `, [ROTA, EMPRESA, MOTORISTA, JSON.stringify(COM_ROTA.map((o, i) => ({ order_id: o, address: 'Maputo', sequence: i + 1, status: 'pending' })))]);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should measure the cost per km from the real fill-ups', async () => {
    const custos = await naEmpresa(() => profitability.getVehicleCosts());
    const viatura = custos.get(MATRICULA);

    expect(viatura.source).toBe('measured');
    expect(viatura.fuel_cents_per_km).toBe(50);
  });

  it('should carry the vehicle cost into the route of the driver who drives it', async () => {
    // A ligação é pela matrícula: o motorista tem-na no cadastro, a viatura é a
    // que abastece. Sem esta junção, o custo medido não chegava a lado nenhum.
    const { routes } = await naEmpresa(() => profitability.getRouteProfitability());
    const rota = routes.find((r) => r.route_id === ROTA);

    expect(rota.plate).toBe(MATRICULA);
    expect(rota.cost_breakdown.fuel_known).toBe(true);
    expect(rota.cost_breakdown.fuel_cents).toBe(100 * 50);
  });

  it('should compute the route margin from the orders it carried', async () => {
    const { routes } = await naEmpresa(() => profitability.getRouteProfitability());
    const rota = routes.find((r) => r.route_id === ROTA);

    expect(rota.revenue_cents).toBe(60_000);          // duas encomendas de 300,00
    expect(rota.profit_cents).toBe(60_000 - rota.cost_cents);
  });

  it('should split the route cost across its stops, adding up exactly', async () => {
    // Se as partes não somarem o total, o relatório por cliente e o por rota
    // dariam números diferentes e ninguém saberia qual acreditar.
    const { routes } = await naEmpresa(() => profitability.getRouteProfitability());
    const rota = routes.find((r) => r.route_id === ROTA);

    const { orders } = await naEmpresa(() => profitability.getOrderProfitability());
    const daRota = orders.filter((o) => o.route_id === ROTA);

    expect(daRota).toHaveLength(2);
    expect(daRota.reduce((s, o) => s + o.cost_cents, 0)).toBe(rota.cost_cents);
  });

  it('should mark an order without a route as cost unknown, not as 100% margin', async () => {
    // Foi entregue por um caminho que o sistema não acompanhou; dizê-lo é a
    // resposta certa.
    const { orders } = await naEmpresa(() => profitability.getOrderProfitability());
    const sozinha = orders.find((o) => o.order_id === SEM_ROTA);

    expect(sozinha.route_id).toBeNull();
    expect(sozinha.cost_known).toBe(false);
    expect(sozinha.cost_cents).toBe(0);
  });

  it('should declare what the margin leaves out', async () => {
    const { cost_coverage } = await naEmpresa(() => profitability.getOrderProfitability());

    expect(cost_coverage.caveat).toMatch(/^Margem ANTES de:/);
    expect(cost_coverage.excluded.join(' ')).toMatch(/salários rateados/);
  });

  it('should aggregate by client, flagging the ones with incomplete cost', async () => {
    const { clients } = await naEmpresa(() => profitability.getClientProfitability());
    const cliente = clients[0];

    expect(cliente.orders).toBe(3);
    expect(cliente.revenue_cents).toBe(90_000);
    // Uma das três não tem rota — a margem do cliente é por cima.
    expect(cliente.orders_without_cost).toBe(1);
    expect(cliente.cost_known).toBe(false);
  });

  it('should aggregate by vehicle', async () => {
    const { vehicles } = await naEmpresa(() => profitability.getVehicleProfitability());
    const viatura = vehicles.find((v) => v.plate === MATRICULA);

    expect(viatura.routes).toBe(1);
    expect(viatura.distance_km).toBe(100);
    expect(viatura.fuel_known).toBe(true);
  });

  it('should not see another company data', async () => {
    // Margem por cliente é a informação mais sensível do sistema: uma fuga aqui
    // entrega a estrutura de custos de um cliente a outro (§ 2.4).
    const { clients } = await tenant.runWithCompany('company-itest-prof-outra', () =>
      profitability.getClientProfitability());

    expect(clients).toEqual([]);
  });
});
