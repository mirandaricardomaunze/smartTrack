/**
 * @file warehouses.pg.spec.js
 * @description Testes de integração da gestão de armazéns contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 8.2, § 4
 *
 * Prova, contra a base real (`track`), o ciclo entrada→envio e as invariantes de
 * capacidade/ocupação: a entrada (intake) liga a encomenda ao armazém e regista o
 * movimento; o envio (dispatch) liberta a ocupação; a capacidade e a desativação
 * de armazém ocupado são rejeitadas (409). Todos os dados vêm de factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { WarehouseFactory } from '../harness/factories/warehouse.factory';
import { OrderFactory }     from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/warehouses.service`) : null;
const ordersSvc = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const repos = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const WH1 = 'wh-itest-0001'; // capacidade 5 — fluxo entrada/envio
const WH2 = 'wh-itest-0002'; // capacidade 1 — lotação e desativação
const WH3 = 'wh-itest-0003'; // inativo
const O1  = 'order-itest-wh-0001';
const O2  = 'order-itest-wh-0002';
const O3  = 'order-itest-wh-0003';

/** Cria uma encomenda in_transit persistível (factory + campos de persistência). */
async function seedOrder(id, code) {
  const base = OrderFactory.build({ id, tracking_code: code, current_status: 'in_transit' });
  const now = new Date().toISOString();
  await repos.OrderRepository.create({
    ...base,
    value:   1990,
    history: [{ status: 'in_transit', description: 'seed', location: 'Em trânsito', timestamp: now }],
  });
}

async function cleanup() {
  await pool.query(
    `DELETE FROM notifications WHERE data->>'orderId' = ANY($1::text[])`,
    [[O1, O2, O3]],
  );
  for (const wid of [WH1, WH2, WH3]) {
    await pool.query('DELETE FROM warehouse_movements WHERE warehouse_id = $1', [wid]);
  }
  for (const oid of [O1, O2, O3]) {
    await pool.query('DELETE FROM orders WHERE id = $1', [oid]);
  }
  for (const wid of [WH1, WH2, WH3]) {
    await pool.query('DELETE FROM warehouses WHERE id = $1', [wid]);
  }
}

describe.skipIf(!disponivel)('api-gateway · gestão de armazéns · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();

    await repos.WarehouseRepository.create(WarehouseFactory.build({ id: WH1, code: 'WH-ITEST-1', capacity: 5 }));
    await repos.WarehouseRepository.create(WarehouseFactory.buildFull({ id: WH2, code: 'WH-ITEST-2' })); // capacidade 1
    await repos.WarehouseRepository.create(WarehouseFactory.buildInactive({ id: WH3, code: 'WH-ITEST-3' }));

    await seedOrder(O1, 'TRK-ITESTW-0001');
    await seedOrder(O2, 'TRK-ITESTW-0002');
    await seedOrder(O3, 'TRK-ITESTW-0003');
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should register an intake: link order to warehouse and log the movement', async () => {
    const { order, warehouse, movement } = await svc.intakeOrder(WH1, { order_id: O1 });

    expect(order.current_status).toBe('at_warehouse');
    expect(order.warehouse_id).toBe(WH1);
    expect(warehouse.occupancy).toBe(1);
    expect(movement.type).toBe('intake');

    const movimentos = await repos.WarehouseRepository.listMovements(WH1);
    expect(movimentos.some((m) => m.order_id === O1 && m.type === 'intake')).toBe(true);
  });

  it('should reject setting at_warehouse through the generic status operation', async () => {
    await expect(ordersSvc.updateOrderStatus(O3, OrderFactory.buildWarehouseStatusUpdate()))
      .rejects.toMatchObject({ name: 'WarehouseIntakeRequiredError', statusCode: 409 });
  });

  it('should list the order as currently inside the warehouse', async () => {
    const dentro = await svc.listWarehouseOrders(WH1);
    expect(dentro.map((o) => o.id)).toContain(O1);
  });

  it('should dispatch the order: free the occupancy and log the movement', async () => {
    const { order, warehouse } = await svc.dispatchOrder(WH1, { order_id: O1, destination: 'Maputo - MPM' });

    expect(order.current_status).toBe('out_for_delivery');
    expect(order.warehouse_id ?? null).toBeNull();
    expect(warehouse.occupancy).toBe(0);

    const movimentos = await repos.WarehouseRepository.listMovements(WH1);
    expect(movimentos.some((m) => m.order_id === O1 && m.type === 'dispatch')).toBe(true);
  });

  it('should reject an intake when the warehouse is at capacity', async () => {
    await svc.intakeOrder(WH2, { order_id: O2 }); // preenche a capacidade 1
    await expect(svc.intakeOrder(WH2, { order_id: O3 }))
      .rejects.toMatchObject({ name: 'WarehouseCapacityExceededError', statusCode: 409 });
  });

  it('should reject deactivating a warehouse that still holds orders', async () => {
    await expect(svc.deactivateWarehouse(WH2))
      .rejects.toMatchObject({ name: 'WarehouseHasOrdersError', statusCode: 409 });
  });

  it('should reject an intake into an inactive warehouse', async () => {
    await expect(svc.intakeOrder(WH3, { order_id: O3 }))
      .rejects.toMatchObject({ name: 'WarehouseInactiveError', statusCode: 409 });
  });
});
