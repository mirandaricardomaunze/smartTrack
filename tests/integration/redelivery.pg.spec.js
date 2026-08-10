/**
 * @file redelivery.pg.spec.js
 * @description Reagendamento e devolução ao remetente, contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.37
 *
 * O que se prova: que a data acordada e o número de tentativas ficam NO pedido
 * (não num comentário), que o teto de tentativas existe e empurra para a
 * devolução, que a devolução exige prova de quem recebeu, e que o COD é
 * cancelado enquanto a fatura é apenas assinalada.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';
import { RedeliveryFactory } from '../harness/factories/redelivery.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const orders   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const invoices = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const repos    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const ID_FALHADA = 'order-itest-redeliv-0001';
const ID_COD     = 'order-itest-redeliv-0002';
const IDS = [ID_FALHADA, ID_COD];

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM invoices WHERE order_id = ANY($1::text[])', [IDS]);
  await pool.query('DELETE FROM order_pod_images WHERE order_id = ANY($1::text[])', [IDS]);
  await pool.query('DELETE FROM orders WHERE id = ANY($1::text[])', [IDS]);
}

/** Encomenda numa tentativa falhada, pronta para reagendar ou devolver. */
async function semearFalhada(id, extra = {}) {
  const base = OrderFactory.build({ id, tracking_code: `TRK93${id.slice(-4)}BR`, current_status: 'failed' });
  const now = new Date().toISOString();
  return repos.OrderRepository.create({
    ...base,
    id,
    value: 25_000,
    history: [{ status: 'failed', description: 'seed', location: 'Maputo', timestamp: now, failure_reason: 'RECIPIENT_ABSENT' }],
    ...extra,
  });
}

describe.skipIf(!disponivel)('reagendamento e devolução · PostgreSQL', () => {
  beforeAll(limpar);

  beforeEach(async () => {
    if (!disponivel) return;
    await limpar();
    await semearFalhada(ID_FALHADA);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  // ── Reagendar ──────────────────────────────────────────────────────────────

  it('should record the agreed date on the order itself', async () => {
    // Num comentário, a data não serve para nada: é no pedido que ela impede
    // pôr a encomenda numa rota antes do dia acordado.
    const pedido = await orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.reschedule());

    expect(pedido.next_attempt_on).toBe(RedeliveryFactory.TOMORROW);
    expect(pedido.delivery_attempts).toBe(1);
    expect(pedido.current_status).toBe('in_transit');

    const relido = await repos.OrderRepository.findById(ID_FALHADA);
    expect(relido.next_attempt_on).toBe(RedeliveryFactory.TOMORROW);
  });

  it('should refuse to reschedule a delivery that never failed', async () => {
    await pool.query('UPDATE orders SET current_status = $1 WHERE id = $2', ['out_for_delivery', ID_FALHADA]);

    await expect(orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.reschedule()))
      .rejects.toThrow(/só se reagenda uma entrega falhada/i);
  });

  it('should refuse a date in the past', async () => {
    // O erro de digitação que ninguém apanha depois.
    await expect(orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.rescheduleInThePast()))
      .rejects.toThrow(/data passada/i);
  });

  it('should refuse a missing or malformed date', async () => {
    await expect(orders.rescheduleDelivery(ID_FALHADA, { scheduled_for: '' })).rejects.toThrow(/obrigatória/i);
    await expect(orders.rescheduleDelivery(ID_FALHADA, { scheduled_for: '15-08-2026' })).rejects.toThrow(/obrigatória/i);
  });

  it('should count attempts and push to return once they run out', async () => {
    // Sem teto, a encomenda entra em ciclo indefinido e ninguém repara.
    const max = orders.MAX_DELIVERY_ATTEMPTS;
    for (let i = 0; i < max; i += 1) {
      await orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.reschedule());
      await pool.query('UPDATE orders SET current_status = $1 WHERE id = $2', ['failed', ID_FALHADA]);
    }

    const antes = await repos.OrderRepository.findById(ID_FALHADA);
    expect(antes.delivery_attempts).toBe(max);

    await expect(orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.reschedule()))
      .rejects.toThrow(/devolução ao remetente/i);
  });

  it('should leave the agreed date on the tracking history', async () => {
    // O cliente que consulta o código tem de ver que ficou combinada uma data.
    const pedido = await orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.reschedule());
    expect(pedido.history[0].description).toContain(RedeliveryFactory.TOMORROW);
  });

  // ── Devolver ───────────────────────────────────────────────────────────────

  it('should start a return from a failed delivery', async () => {
    const pedido = await orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest());

    expect(pedido.current_status).toBe('in_transit');
    expect(pedido.return_info.reason).toBe('ATTEMPTS_EXHAUSTED');
    expect(pedido.return_info.started_at).toBeTruthy();
  });

  it('should clear a pending attempt date when the return starts', async () => {
    // Já não vai haver nova tentativa: deixar a data marcada faria a encomenda
    // aparecer na lista do dia de quem despacha.
    await orders.rescheduleDelivery(ID_FALHADA, RedeliveryFactory.reschedule());
    await pool.query('UPDATE orders SET current_status = $1 WHERE id = $2', ['failed', ID_FALHADA]);

    const pedido = await orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest());
    expect(pedido.next_attempt_on).toBeUndefined();
  });

  it('should refuse an unknown return reason', async () => {
    await expect(orders.startReturn(ID_FALHADA, { reason: 'PORQUE_SIM' }))
      .rejects.toThrow(/motivo de devolução inválido/i);
  });

  it('should refuse to return an order that is out for delivery', async () => {
    await pool.query('UPDATE orders SET current_status = $1 WHERE id = $2', ['out_for_delivery', ID_FALHADA]);
    await expect(orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest()))
      .rejects.toThrow(/não é possível devolver/i);
  });

  // ── Confirmar a devolução ──────────────────────────────────────────────────

  it('should refuse to confirm without saying who received it', async () => {
    // Uma devolução sem prova é indistinguível de uma encomenda perdida.
    await orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest());

    await expect(orders.confirmReturn(ID_FALHADA, RedeliveryFactory.returnProofWithoutReceiver()))
      .rejects.toThrow(/received_by/i);
  });

  it('should refuse to confirm a return that was never started', async () => {
    await expect(orders.confirmReturn(ID_FALHADA, RedeliveryFactory.returnProof()))
      .rejects.toThrow(/devolução não iniciada/i);
  });

  it('should land the order in returned, with proof and an intact hash chain', async () => {
    await orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest());
    const pedido = await orders.confirmReturn(ID_FALHADA, RedeliveryFactory.returnProof());

    expect(pedido.current_status).toBe('returned');
    expect(pedido.return_info.received_by).toContain('Ana Costa');
    expect(pedido.return_info.received_at).toBeTruthy();
    expect(pedido.return_info.has_signature).toBe(true);

    // A cadeia liga cada evento ao anterior, sem furos. Começa nos eventos com
    // hash: o evento semeado por este teste não passou pelo serviço e por isso
    // não tem assinatura — verificar a partir dele mediria o `beforeEach`, não
    // o código.
    const assinados = [...pedido.history].reverse().filter((e) => e.hash);
    expect(assinados.length).toBeGreaterThan(0);
    for (let i = 1; i < assinados.length; i += 1) {
      expect(assinados[i].parent_hash).toBe(assinados[i - 1].hash);
    }

    // A assinatura fica guardada, no mesmo sítio das imagens de entrega.
    const imagens = await repos.OrderRepository.findPodImages(ID_FALHADA);
    expect(imagens.signature).toContain('data:image/png');
  });

  it('should be a terminal state — nothing follows a return', async () => {
    await orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest());
    await orders.confirmReturn(ID_FALHADA, RedeliveryFactory.returnProof());

    await expect(orders.updateOrderStatus(ID_FALHADA, { new_status: 'delivered' }))
      .rejects.toThrow();
  });

  // ── Consequências financeiras ──────────────────────────────────────────────

  it('should cancel the COD instead of leaving it pending forever', async () => {
    // Deixá-lo `pending` fá-lo aparecer eternamente no que há a receber;
    // `none` apagava o facto de ter existido um valor a cobrar.
    await semearFalhada(ID_COD, { cod_amount: 50_000, cod_status: 'pending' });

    await orders.startReturn(ID_COD, RedeliveryFactory.returnRequest({ reason: 'REFUSED' }));
    const pedido = await orders.confirmReturn(ID_COD, RedeliveryFactory.returnProof());

    expect(pedido.cod_status).toBe('cancelled');
    expect(pedido.cod_amount).toBe(50_000);
  });

  it('should flag an active invoice without touching it', async () => {
    // Creditar automaticamente seria inventar uma política comercial: há quem
    // cobre o frete na mesma, porque o trabalho foi feito.
    const fatura = await invoices.createInvoiceForOrder(ID_FALHADA);

    await orders.startReturn(ID_FALHADA, RedeliveryFactory.returnRequest());
    const pedido = await orders.confirmReturn(ID_FALHADA, RedeliveryFactory.returnProof());

    expect(pedido.return_info.invoice_alert.number).toBe(fatura.number);
    expect(pedido.return_info.invoice_alert.note).toMatch(/nota de crédito/i);

    // A fatura em si continua exatamente como estava.
    const relida = await repos.InvoiceRepository.findById(fatura.id);
    expect(relida.status).toBe(fatura.status);
    expect(relida.total_cents).toBe(fatura.total_cents);
  });
});
