/**
 * @file warehouse-pickup.pg.spec.js
 * @description Testes de integração do levantamento ao balcão contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.23 (Levantamento no armazém)
 *
 * Prova, contra a base real (`track`): o cliente levanta a encomenda no armazém
 * sem passar por rota; um terceiro só leva com relação e autorização registadas;
 * o código de entrega é exigido quando existe; a encomenda tem de estar NAQUELE
 * armazém; o COD cobrado ao balcão **não** cai no acerto do motorista; e fica
 * movimento de armazém, comprovativo e evento de auditoria. Dados via factories.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { WarehouseFactory } from '../harness/factories/warehouse.factory';
import { OrderFactory } from '../harness/factories/order.factory';
import { PickupFactory } from '../harness/factories/pickup.factory';
import { KNOWN_OTP_CODE, KNOWN_OTP_HASH } from '../harness/factories/otp.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const warehouses = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/warehouses.service`) : null;
const orders     = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const settlements= disponivel ? require(`${ROOT}/backend/api-gateway/src/application/settlements.service`) : null;
const repo       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY = 'company-itest-pickup';
const DRIVER = 'driver-itest-pickup';
let warehouseA;
let warehouseB;

function asCompany(fn) {
  return tenant.runWithCompany(COMPANY, fn);
}

/** Cria uma encomenda já dentro do armazém, pronta a ser levantada. */
async function seedStoredOrder(overrides = {}) {
  const base = OrderFactory.build({
    id: `order-itest-pickup-${Math.random().toString(36).slice(2, 10)}`,
    tracking_code: `TRK${Math.floor(Math.random() * 8_999_999 + 1_000_000)}BR`,
    current_status: 'at_warehouse',
  });
  return asCompany(() => repo.OrderRepository.create({
    ...base,
    value: 11600,
    warehouse_id: warehouseA.id,
    driver_id: DRIVER,
    history: [{ status: 'at_warehouse', description: 'seed', location: 'Maputo', timestamp: new Date().toISOString() }],
    ...overrides,
  }));
}

async function cleanup() {
  await pool.query('DELETE FROM warehouse_movements WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM driver_settlements WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM audit_events WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM invoices WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM orders WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM warehouses WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}

describe.skipIf(!disponivel)('api-gateway · levantamento no armazém · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY, name: 'Balcão Lda', slug: COMPANY }));

    const build = (code, name) => {
      const w = WarehouseFactory.build({ code, name });
      return { code: w.code, name: w.name, city: w.address.city, capacity: 0 };
    };
    warehouseA = await asCompany(() => warehouses.createWarehouse(build('WH-PICKUP-A', 'Balcão Maputo')));
    warehouseB = await asCompany(() => warehouses.createWarehouse(build('WH-PICKUP-B', 'Balcão Beira')));
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── O caso simples ────────────────────────────────────────────────────────

  it('should hand the parcel to the recipient at the counter', async () => {
    const order = await seedStoredOrder();
    const result = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code,
      ...PickupFactory.recipient(),
      user_id: 'operador-1',
    }));

    expect(result.order.current_status).toBe('delivered');
    expect(result.order.pod.pickup.is_recipient).toBe(true);
    expect(result.order.pod.pickup.name).toBe(PickupFactory.recipient().collector_name);
    expect(result.order.pod.pickup.document).toBeTruthy();
    // Nunca passou por rota: a encomenda saiu pelas mãos do cliente.
    expect(result.order.history[0].description).toMatch(/Levantado no armazém/);
    expect(result.order.history[0].event_origin).toBe('ADMIN');
  });

  it('should record a pickup movement, distinct from a dispatch', async () => {
    const movements = await asCompany(() => warehouses.listWarehouseMovements(warehouseA.id));
    expect(movements[0].type).toBe('pickup');
  });

  it('should free the warehouse occupancy', async () => {
    const order = await seedStoredOrder();
    const before = await asCompany(() => warehouses.getWarehouse(warehouseA.id));

    await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'operador-1',
    }));

    const after = await asCompany(() => warehouses.getWarehouse(warehouseA.id));
    expect(after.occupancy).toBe(before.occupancy - 1);
  });

  // ── Terceiros autorizados ─────────────────────────────────────────────────

  it('should let an authorised third party collect, recording who and how', async () => {
    const order = await seedStoredOrder();
    const collector = PickupFactory.thirdParty();

    const result = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...collector, user_id: 'operador-1',
    }));

    const pickup = result.order.pod.pickup;
    expect(pickup.is_recipient).toBe(false);
    expect(pickup.relationship).toBe(collector.relationship);
    expect(pickup.authorization).toBe(collector.authorization);
    // A descrição no histórico diz que não foi o destinatário — é o que responde
    // mais tarde a "quem levou a minha encomenda?".
    expect(result.order.history[0].description).toMatch(/autorizado pelo destinatário/);
  });

  it.each([
    ['sem relação', { relationship: '' }],
    ['sem autorização', { authorization: '' }],
    ['autorização vaga demais', { authorization: 'ok' }],
  ])('should refuse a third party %s', async (_label, patch) => {
    const order = await seedStoredOrder();
    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.thirdParty(patch), user_id: 'operador-1',
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('should always require a name and an identity document', async () => {
    const order = await seedStoredOrder();
    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient({ collector_document: '' }), user_id: 'op',
    }))).rejects.toThrowError(/collector_document/);

    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient({ collector_name: '  ' }), user_id: 'op',
    }))).rejects.toThrowError(/collector_name/);
  });

  // ── Verificações ──────────────────────────────────────────────────────────

  it('should demand the delivery code when the order has one', async () => {
    const order = await seedStoredOrder({
      delivery_otp: { code_hash: KNOWN_OTP_HASH, expires_at: new Date(Date.now() + 3_600_000).toISOString(), attempts: 0, verified_at: null },
    });

    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }))).rejects.toThrowError(/otp/i);

    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), otp: '000000', user_id: 'op',
    }))).rejects.toMatchObject({ name: 'OtpInvalidError' });

    const done = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), otp: KNOWN_OTP_CODE, user_id: 'op',
    }));
    expect(done.order.current_status).toBe('delivered');
    expect(done.order.delivery_otp.verified_at).toBeTruthy();
  });

  it('should refuse a parcel that is in another warehouse', async () => {
    const order = await seedStoredOrder();
    await expect(asCompany(() => warehouses.pickupOrder(warehouseB.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }))).rejects.toMatchObject({ name: 'OrderNotInWarehouseError' });
  });

  it('should refuse a parcel that is not in a warehouse at all', async () => {
    const order = await seedStoredOrder({ current_status: 'in_transit' });
    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }))).rejects.toMatchObject({ name: 'DeliveryStateError' });
  });

  it('should refuse to hand the same parcel over twice', async () => {
    const order = await seedStoredOrder();
    await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }));

    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }))).rejects.toMatchObject({ name: 'DeliveryStateError' });
  });

  it('should also work for a parcel awaiting a destination decision', async () => {
    const order = await seedStoredOrder({ current_status: 'awaiting_destination' });
    const result = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }));
    expect(result.order.current_status).toBe('delivered');
  });

  // ── Dinheiro ──────────────────────────────────────────────────────────────

  it('should collect COD at the counter and keep it out of the driver settlement', async () => {
    const order = await seedStoredOrder({ cod_amount: 50000, cod_status: 'pending' });

    await expect(asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }))).rejects.toThrowError(/cod_method/);

    const result = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), cod_method: 'CASH', user_id: 'op',
    }));

    expect(result.order.cod_status).toBe('collected');
    expect(result.order.cod.amount).toBe(50000);
    // O dinheiro entrou no caixa do ARMAZÉM.
    expect(result.order.cod.channel).toBe('warehouse');
    expect(result.order.cod.warehouse_id).toBe(warehouseA.id);

    // E por isso não aparece no acerto do motorista que já lhe estava atribuído.
    const pending = await asCompany(() => repo.SettlementRepository.listCollectedUnsettledByDriver(DRIVER));
    expect(pending.map((o) => o.id)).not.toContain(result.order.id);
  });

  it('should keep driver-collected COD in the settlement, untouched', async () => {
    // Contraprova: uma entrega normal continua a alimentar o acerto do motorista.
    const order = await seedStoredOrder({ cod_amount: 30000, cod_status: 'pending' });
    await asCompany(() => orders.requestWarehouseShipment(order.id, { destination: 'Maputo', user_id: 'op' }));
    await asCompany(() => orders.deliverOrder(order.id, {
      recipient_name: 'Cliente em casa', cod_method: 'CASH', user_id: DRIVER,
    }));

    const pending = await asCompany(() => repo.SettlementRepository.listCollectedUnsettledByDriver(DRIVER));
    expect(pending.map((o) => o.id)).toContain(order.id);
  });

  // ── Rasto ─────────────────────────────────────────────────────────────────

  it('should keep the collector and the authorisation readable in the audit trail', async () => {
    // Regressão: a redação do registo oculta chaves parecidas com credenciais
    // (cabeçalho `Authorization`) e chegou a apagar a prova de quem autorizou.
    const audit = require(`${ROOT}/backend/api-gateway/src/application/audit.service`);
    const order = await seedStoredOrder();
    const collector = PickupFactory.thirdParty();

    const result = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...collector, user_id: 'operador-1',
    }));
    await asCompany(() => audit.record({
      action: 'warehouses.pickup',
      summary: `operador entregou ${result.order.tracking_code} ao balcão a ${collector.collector_name}`,
      entity_type: 'order', entity_id: result.order.id, entity_label: result.order.tracking_code,
      metadata: {
        collector: collector.collector_name,
        document: collector.collector_document,
        authorized_how: collector.authorization,
      },
    }));

    const events = await asCompany(() => audit.listEvents({ action: 'warehouses.pickup', pageSize: 1 }));
    expect(events.items[0].metadata.authorized_how).toBe(collector.authorization);
    expect(events.items[0].metadata.collector).toBe(collector.collector_name);
  });

  it('should keep the tracking history chained after a counter pickup', async () => {
    const order = await seedStoredOrder();
    const result = await asCompany(() => warehouses.pickupOrder(warehouseA.id, {
      tracking_code: order.tracking_code, ...PickupFactory.recipient(), user_id: 'op',
    }));

    const [latest, previous] = result.order.history;
    expect(latest.status).toBe('delivered');
    expect(latest.parent_hash).toBe(previous.hash ?? '0000000000000000000000000000000000000000000000000000000000000000');
    expect(latest.hash).toBeTruthy();
  });
});
