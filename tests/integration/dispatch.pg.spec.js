/**
 * @file dispatch.pg.spec.js
 * @description Despacho automático contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.38
 *
 * O planeamento em si é puro e está coberto em dispatch.service.spec.ts. O que
 * aqui se prova é o que só a base mostra: que o plano lê o estado real (e não
 * apanha encomendas já entregues nem motoristas ocupados), e que confirmar
 * produz rotas pelo MESMO caminho do despacho manual — com verificação de carga
 * e com a encomenda atribuída ao motorista (§ 3.34).
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';
import { DriverFactory } from '../harness/factories/driver.factory';
import { MAPUTO_PONTOS } from '../harness/factories/dispatch.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const dispatch = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/dispatch.service`) : null;
const routes   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/../../../routes-service/src/application/routes.service`) : null;
const orders   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const repos    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const MOTORISTA_LIVRE  = 'driver-itest-dsp-livre';
const MOTORISTA_OCUPADO = 'driver-itest-dsp-ocupado';
const CODIGOS = ['TRK950000001BR', 'TRK950000002BR', 'TRK950000003BR'];

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM routes WHERE driver_id = ANY($1::text[])', [[MOTORISTA_LIVRE, MOTORISTA_OCUPADO]]);
  await pool.query('DELETE FROM orders WHERE tracking_code = ANY($1::text[])', [CODIGOS]);
  await pool.query('DELETE FROM drivers WHERE id = ANY($1::text[])', [[MOTORISTA_LIVRE, MOTORISTA_OCUPADO]]);
}

/** Encomenda pronta a sair, com coordenadas em Maputo. */
async function semearPronta(codigo, over = {}) {
  const base = OrderFactory.build({ tracking_code: codigo, current_status: 'at_warehouse' });
  const now = new Date().toISOString();
  return repos.OrderRepository.create({
    ...base,
    id: `order-itest-dsp-${codigo.slice(-4)}`,
    value: 10_000,
    weight_grams: 4_000,
    destination: { city: 'Maputo', state: '', country: 'MZ', coords: MAPUTO_PONTOS.baixa },
    history: [{ status: 'at_warehouse', description: 'seed', location: 'Armazém', timestamp: now }],
    ...over,
  });
}

describe.skipIf(!disponivel)('despacho automático · PostgreSQL', () => {
  beforeAll(limpar);

  beforeEach(async () => {
    if (!disponivel) return;
    await pool.query('DELETE FROM routes WHERE driver_id = ANY($1::text[])', [[MOTORISTA_LIVRE, MOTORISTA_OCUPADO]]);
    await pool.query('DELETE FROM orders WHERE tracking_code = ANY($1::text[])', [CODIGOS]);
    await pool.query('DELETE FROM drivers WHERE id = ANY($1::text[])', [[MOTORISTA_LIVRE, MOTORISTA_OCUPADO]]);

    await repos.DriverRepository.create(DriverFactory.build({
      id: MOTORISTA_LIVRE, name: 'Livre', email: 'livre.dsp@itest.mz',
      current_status: 'available',
      vehicle: { type: 'VAN', plate: 'DSP0001', capacity_kg: 1000 },
    }));
    for (const codigo of CODIGOS) await semearPronta(codigo);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should plan from the real state of the database', async () => {
    const plano = await dispatch.planAutomaticDispatch({ origin: MAPUTO_PONTOS.baixa });

    const minhas = plano.routes.flatMap((r) => r.stops).filter((s) => CODIGOS.includes(s.tracking_code));
    expect(minhas.length).toBe(3);
  });

  it('should not pick up an order that was already delivered', async () => {
    await pool.query('UPDATE orders SET current_status = $1 WHERE tracking_code = $2', ['delivered', CODIGOS[0]]);

    const plano = await dispatch.planAutomaticDispatch({ origin: MAPUTO_PONTOS.baixa });
    const nasRotas = plano.routes.flatMap((r) => r.stops).map((s) => s.tracking_code);

    expect(nasRotas).not.toContain(CODIGOS[0]);
    expect(plano.unassigned.find((u) => u.tracking_code === CODIGOS[0]).reason).toContain('delivered');
  });

  it('should not pick up an order scheduled for a future day', async () => {
    // O § 3.37 pôs a data no pedido exatamente para isto.
    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await pool.query('UPDATE orders SET next_attempt_on = $1 WHERE tracking_code = $2', [amanha, CODIGOS[1]]);

    const plano = await dispatch.planAutomaticDispatch({ origin: MAPUTO_PONTOS.baixa });
    const nasRotas = plano.routes.flatMap((r) => r.stops).map((s) => s.tracking_code);

    expect(nasRotas).not.toContain(CODIGOS[1]);
    expect(plano.unassigned.find((u) => u.tracking_code === CODIGOS[1]).reason).toContain(amanha);
  });

  it('should not give work to a driver already on a route', async () => {
    await repos.DriverRepository.create(DriverFactory.build({
      id: MOTORISTA_OCUPADO, name: 'Ocupado', email: 'ocupado.dsp@itest.mz',
      current_status: 'on_route',
      vehicle: { type: 'VAN', plate: 'DSP0002', capacity_kg: 1000 },
    }));

    const plano = await dispatch.planAutomaticDispatch({ origin: MAPUTO_PONTOS.baixa });
    expect(plano.routes.map((r) => r.driver_id)).not.toContain(MOTORISTA_OCUPADO);
  });

  it('should create the proposed routes and hand the orders to the driver', async () => {
    // Confirmar passa pelo mesmo caminho do despacho manual: a rota é criada e
    // a encomenda fica com `driver_id` — sem isso o motorista continua sem ela
    // na aplicação (§ 3.34).
    const plano = await dispatch.planAutomaticDispatch({ origin: MAPUTO_PONTOS.baixa });
    const proposta = plano.routes.find((r) => r.driver_id === MOTORISTA_LIVRE);
    expect(proposta).toBeTruthy();

    const rota = await routes.createRoute({ driver_id: proposta.driver_id, stops: proposta.stops });
    const atribuicao = await dispatch.assignRouteOrders(rota);

    expect(atribuicao.skipped).toEqual([]);
    expect(rota.stops.length).toBe(proposta.stops.length);

    const encomenda = await orders.getOrderTracking(CODIGOS[0]);
    expect(encomenda.driver_id).toBe(MOTORISTA_LIVRE);
    expect(encomenda.route_id).toBe(rota.id);
  });

  it('should refuse to confirm a plan that exceeds the vehicle', async () => {
    // A confirmação não é uma porta lateral: a verificação de carga do § 3.33
    // continua a valer.
    await repos.DriverRepository.create(DriverFactory.build({
      id: MOTORISTA_OCUPADO, name: 'Moto', email: 'moto.dsp@itest.mz',
      current_status: 'available',
      vehicle: { type: 'MOTO', plate: 'DSP0003', capacity_kg: 25 },
    }));
    await pool.query('UPDATE orders SET weight_grams = 60000 WHERE tracking_code = $1', [CODIGOS[0]]);

    const pesada = await repos.OrderRepository.findByCode(CODIGOS[0]);
    await expect(dispatch.assertRouteFitsDriver(MOTORISTA_OCUPADO, [{ order_id: pesada.id }]))
      .rejects.toThrow(/não cabe|excede/i);
  });

  it('should account for every eligible order — planned plus unassigned', async () => {
    // Um plano que perde encomendas pelo caminho é pior do que nenhum plano.
    const plano = await dispatch.planAutomaticDispatch({ origin: MAPUTO_PONTOS.baixa });

    expect(plano.summary.planned_orders + plano.summary.unassigned)
      .toBeGreaterThanOrEqual(plano.summary.eligible_orders);
  });
});
