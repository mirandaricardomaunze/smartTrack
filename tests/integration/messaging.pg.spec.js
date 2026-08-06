/**
 * @file messaging.pg.spec.js
 * @description Testes de integração do envio de SMS/email ao cliente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * Prova, contra a base real (`track`): `sendClientMessage` regista as mensagens em
 * `outbound_messages`; e a **entrada no armazém** de um pedido com contactos dispara
 * SMS + email. Sem provedor real → estado `simulated`. Dados via factories.
 *
 * Pré-requisitos: PostgreSQL a atender + migrações do gateway e do notifications-service.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';
import { WarehouseFactory } from '../harness/factories/warehouse.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const messaging = disponivel ? require(`${ROOT}/backend/notifications-service/src/application/messaging.service`) : null;
const outboundRepo = disponivel ? require(`${ROOT}/backend/notifications-service/src/infrastructure/pg.repository`).OutboundMessageRepository : null;
const warehouses = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/warehouses.service`) : null;
const repos = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const WH = 'wh-itest-msg-0001';
const O1 = 'order-itest-msg-0001';
const PHONE = '+258849999991'; // não termina em 0 → simulado com sucesso
const EMAIL = 'itest-msg@exemplo.mz';

async function cleanup() {
  await pool.query('DELETE FROM outbound_messages WHERE order_id = $1 OR recipient IN ($2,$3)', [O1, PHONE, EMAIL]);
  await pool.query('DELETE FROM orders WHERE id = $1', [O1]);
  await pool.query('DELETE FROM warehouses WHERE id = $1', [WH]);
}

describe.skipIf(!disponivel)('notifications · SMS/email · PostgreSQL', () => {
  beforeAll(async () => {
    messaging.resetPorts();
    await cleanup();
    await repos.WarehouseRepository.create(WarehouseFactory.build({ id: WH, code: 'WH-IMSG', capacity: 10 }));
    const base = OrderFactory.buildWithContact({
      id: O1, tracking_code: 'TRK-ITESTMSG-0001', current_status: 'in_transit',
      client_phone: PHONE, client_email: EMAIL,
    });
    const now = new Date().toISOString();
    await repos.OrderRepository.create({ ...base, value: 1990, history: [{ status: 'in_transit', description: 'seed', location: 'x', timestamp: now }] });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should record SMS and email when sending a client message', async () => {
    const { results } = await messaging.sendClientMessage({
      to_phone: PHONE, to_email: EMAIL,
      subject: 'Recebida', body: 'Recebemos a sua encomenda no armazém.',
      order_id: O1, tracking_code: 'TRK-ITESTMSG-0001',
    });
    expect(results).toHaveLength(2);

    const all = await outboundRepo.findAll(200);
    const mine = all.filter((m) => m.order_id === O1);
    expect(mine.map((m) => m.channel).sort()).toEqual(['email', 'sms']);
    expect(mine.every((m) => m.status === 'simulated')).toBe(true);
  });

  it('should send SMS + email to the client on warehouse intake', async () => {
    await warehouses.intakeOrder(WH, { order_id: O1 });

    const all = await outboundRepo.findAll(200);
    const forOrder = all.filter((m) => m.order_id === O1);
    // 2 do teste anterior + 2 da entrada
    expect(forOrder.filter((m) => m.channel === 'sms').length).toBeGreaterThanOrEqual(2);
    expect(forOrder.some((m) => m.body.includes('no armazém'))).toBe(true);
  });
});
