/**
 * @file cod-settlement.pg.spec.js
 * @description Testes de integração do COD e acerto de caixa do motorista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.5
 *
 * Prova, contra a base real (`track`): a cobrança COD na entrega marca o pedido
 * `collected`; abrir um acerto junta o COD por acertar (separando numerário de
 * mobile), marca os pedidos `settled` (transação) e a reconciliação calcula a
 * diferença. Dados via factories do harness.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate -- --reset-core`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const orders = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const svc    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/settlements.service`) : null;
const repo   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const DRV = 'driver-itest-cod-0001';
const O1  = 'order-itest-cod-0001'; // COD 5000 (numerário)
const O2  = 'order-itest-cod-0002'; // COD 3000 (mobile MPESA)

async function seedCodOrder(id, code, amount) {
  const base = OrderFactory.buildWithCod(amount, {
    id, tracking_code: code, current_status: 'out_for_delivery', driver_id: DRV,
  });
  const now = new Date().toISOString();
  await repo.OrderRepository.create({
    ...base,
    value:   base.cod_amount,
    history: [{ status: 'out_for_delivery', description: 'seed', location: 'Maputo - MPM', timestamp: now }],
  });
}

async function cleanup() {
  await pool.query('DELETE FROM driver_settlements WHERE driver_id = $1', [DRV]);
  for (const id of [O1, O2]) await pool.query('DELETE FROM orders WHERE id = $1', [id]);
}

describe.skipIf(!disponivel)('api-gateway · COD / acerto de caixa · PostgreSQL', () => {
  let settlementId;

  beforeAll(async () => {
    await cleanup();
    await seedCodOrder(O1, 'TRK-ITESTCOD-0001', 5000);
    await seedCodOrder(O2, 'TRK-ITESTCOD-0002', 3000);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should collect COD on delivery (cash and mobile)', async () => {
    const d1 = await orders.deliverOrder(O1, { recipient_name: 'Cliente 1', cod_method: 'CASH' });
    expect(d1.current_status).toBe('delivered');
    expect(d1.cod_status).toBe('collected');
    expect(d1.cod.method).toBe('CASH');
    expect(d1.cod.amount).toBe(5000);

    const d2 = await orders.deliverOrder(O2, { recipient_name: 'Cliente 2', cod_method: 'MPESA' });
    expect(d2.cod_status).toBe('collected');
    expect(d2.cod.method).toBe('MPESA');
  });

  it('should require a COD method when the order has a COD amount', async () => {
    await seedCodOrder('order-itest-cod-0003', 'TRK-ITESTCOD-0003', 2000);
    await expect(orders.deliverOrder('order-itest-cod-0003', { recipient_name: 'X' }))
      .rejects.toMatchObject({ name: 'MissingRequiredFieldError' });
    await pool.query('DELETE FROM orders WHERE id = $1', ['order-itest-cod-0003']);
  });

  it('should open a settlement splitting cash vs mobile and mark orders settled', async () => {
    const s = await svc.openSettlement(DRV, { user_id: 'admin-test' });
    settlementId = s.id;

    expect(s.order_count).toBe(2);
    expect(s.expected_cash_cents).toBe(5000);    // só o numerário
    expect(s.expected_mobile_cents).toBe(3000);  // mobile (informativo)
    expect(s.expected_total_cents).toBe(8000);
    expect(s.status).toBe('open');

    const o1 = await repo.OrderRepository.findById(O1);
    expect(o1.cod_status).toBe('settled');
    expect(o1.cod_settlement_id).toBe(s.id);
  });

  it('should reject opening a settlement when there is nothing to settle', async () => {
    await expect(svc.openSettlement(DRV))
      .rejects.toMatchObject({ name: 'NoCodToSettleError', statusCode: 409 });
  });

  it('should reconcile with the received cash and compute the difference', async () => {
    const r = await svc.reconcileSettlement(settlementId, { received_cash_cents: 4800, notes: 'faltou troco' });
    expect(r.status).toBe('reconciled');
    expect(r.received_cash_cents).toBe(4800);
    expect(r.difference_cents).toBe(-200); // esperado 5000, recebido 4800 → falta 200
  });

  it('should reject reconciling an already reconciled settlement', async () => {
    await expect(svc.reconcileSettlement(settlementId, { received_cash_cents: 5000 }))
      .rejects.toMatchObject({ name: 'SettlementAlreadyReconciledError', statusCode: 409 });
  });
});
