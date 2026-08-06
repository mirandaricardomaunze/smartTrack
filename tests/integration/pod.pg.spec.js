/**
 * @file pod.pg.spec.js
 * @description Testes de integração do comprovativo de entrega (POD) e insucesso.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1
 *
 * Prova, contra a base real (`track`), que a entrega a partir de "saiu para
 * entrega" guarda o POD e transiciona para `delivered`; que o insucesso regista
 * o motivo e vai a `failed`; e que entregar fora de OUT_FOR_DELIVERY é rejeitado.
 * Dados via factories do harness.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate -- --reset-core`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';
import { PodFactory, DeliveryFailureFactory } from '../harness/factories/pod.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`).OrderRepository : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const O1 = 'order-itest-pod-0001'; // out_for_delivery → entrega com POD
const O2 = 'order-itest-pod-0002'; // created → tentar entregar (deve falhar 409)
const O3 = 'order-itest-pod-0003'; // out_for_delivery → insucesso

async function seedOrder(id, code, status) {
  const base = OrderFactory.build({ id, tracking_code: code, current_status: status });
  const now = new Date().toISOString();
  await repo.create({
    ...base,
    value:   1990,
    history: [{ status, description: 'seed', location: 'Maputo - MPM', timestamp: now }],
  });
}

async function cleanup() {
  for (const id of [O1, O2, O3]) {
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  }
}

describe.skipIf(!disponivel)('api-gateway · entrega/POD · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await seedOrder(O1, 'TRK-ITESTPOD-0001', 'out_for_delivery');
    await seedOrder(O2, 'TRK-ITESTPOD-0002', 'created');
    await seedOrder(O3, 'TRK-ITESTPOD-0003', 'out_for_delivery');
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should deliver with proof (POD) and store it on the order', async () => {
    const pod = PodFactory.build({ recipient_name: 'Ana Cliente' });
    const order = await svc.deliverOrder(O1, {
      recipient_name: pod.recipient_name,
      signature:      pod.signature,
      lat:            pod.coords.lat,
      lng:            pod.coords.lng,
    });

    expect(order.current_status).toBe('delivered');
    expect(order.pod).toBeTruthy();
    expect(order.pod.recipient_name).toBe('Ana Cliente');
    expect(order.pod.signature).toContain('data:image/png');
    expect(order.history[0].status).toBe('delivered');
    expect(order.history[0].recipient_name).toBe('Ana Cliente');

    // Persistido: reler da base confirma o POD.
    const reloaded = await repo.findById(O1);
    expect(reloaded.current_status).toBe('delivered');
    expect(reloaded.pod.recipient_name).toBe('Ana Cliente');
  });

  it('should reject delivery when the order is not out for delivery', async () => {
    await expect(svc.deliverOrder(O2, { recipient_name: 'Alguém' }))
      .rejects.toMatchObject({ name: 'DeliveryStateError', statusCode: 409 });
  });

  it('should require the recipient name', async () => {
    await expect(svc.deliverOrder(O3, { recipient_name: '  ' }))
      .rejects.toMatchObject({ name: 'MissingRequiredFieldError', statusCode: 400 });
  });

  it('should register a failed delivery attempt with a reason', async () => {
    const failure = DeliveryFailureFactory.build({ reason: 'RECIPIENT_ABSENT', notes: 'Ninguém em casa' });
    const order = await svc.failDelivery(O3, { reason: failure.reason, notes: failure.notes });

    expect(order.current_status).toBe('failed');
    expect(order.history[0].status).toBe('failed');
    expect(order.history[0].failure_reason).toBe('RECIPIENT_ABSENT');
  });

  it('should reject an invalid failure reason', async () => {
    await seedOrder('order-itest-pod-0004', 'TRK-ITESTPOD-0004', 'out_for_delivery');
    await expect(svc.failDelivery('order-itest-pod-0004', { reason: 'INVENTADO' }))
      .rejects.toMatchObject({ name: 'InvalidDeliveryFailureReasonError', statusCode: 400 });
    await pool.query('DELETE FROM orders WHERE id = $1', ['order-itest-pod-0004']);
  });
});
