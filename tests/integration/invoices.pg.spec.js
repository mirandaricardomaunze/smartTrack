/**
 * @file invoices.pg.spec.js
 * @description Testes de integração da faturação contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14
 *
 * Prova, contra a base real (`track`): a extração de IVA (tax-inclusive); emitir a
 * fatura de um pedido com numeração FT{ano}/{seq} e o IVA correto; a idempotência
 * (uma fatura ativa por pedido); marcar paga e anular (com as respetivas regras); a
 * cobrança de COD na entrega marcar a fatura paga; e o resumo. Dados via factories.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona invoices + counters)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const orders = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const repo   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const O1 = 'order-itest-inv-0001'; // frete 11600 -> base 10000 + IVA 1600
const O2 = 'order-itest-inv-0002'; // COD -> fatura paga na entrega
const IDS = [O1, O2];

async function seedOrder(id, code, value, extra = {}) {
  const base = OrderFactory.build({ id, tracking_code: code, current_status: extra.current_status ?? 'in_transit' });
  await repo.OrderRepository.create({
    ...base, value,
    history: [{ status: base.current_status, description: 'seed', location: 'Maputo', timestamp: new Date().toISOString() }],
    ...extra,
  });
}

async function cleanup() {
  for (const id of IDS) {
    await pool.query('DELETE FROM invoices WHERE order_id = $1', [id]);
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  }
}

describe.skipIf(!disponivel)('api-gateway · faturação · PostgreSQL', () => {
  let invoiceId;

  beforeAll(async () => {
    await cleanup();
    await seedOrder(O1, 'TRK-ITESTINV-0001', 11600);
    await seedOrder(O2, 'TRK-ITESTINV-0002', 5000, { current_status: 'out_for_delivery', cod_amount: 5000, cod_status: 'pending' });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should split tax from a tax-inclusive total', () => {
    expect(svc.splitTaxInclusive(11600, 16)).toMatchObject({ subtotal_cents: 10000, tax_cents: 1600, total_cents: 11600 });
  });

  it('should issue an invoice from an order with a sequential number and IVA', async () => {
    const inv = await svc.createInvoiceForOrder(O1);
    invoiceId = inv.id;
    // Numeração fiscal (spec § 3.19): tipo + série + ano/sequência.
    expect(inv.number).toMatch(/^FT [A-Z0-9]{1,6}\d{4}\/\d{4}$/);
    expect(inv.doc_type).toBe('FT');
    expect(inv.hash_control).toHaveLength(4);
    expect(inv.status).toBe('issued');
    expect(inv.subtotal_cents).toBe(10000);
    expect(inv.tax_cents).toBe(1600);
    expect(inv.total_cents).toBe(11600);
    expect(inv.tracking_code).toBe('TRK-ITESTINV-0001');
    expect(inv.items).toHaveLength(1);
  });

  it('should be idempotent — one active invoice per order', async () => {
    const again = await svc.createInvoiceForOrder(O1);
    expect(again.id).toBe(invoiceId);
    expect(again.number).toBeDefined();
  });

  it('should reject invoicing an unknown order', async () => {
    await expect(svc.createInvoiceForOrder('order-nao-existe'))
      .rejects.toMatchObject({ name: 'OrderNotFoundError', statusCode: 404 });
  });

  it('should mark the invoice paid', async () => {
    const paid = await svc.markPaid(invoiceId, { payment_method: 'MPESA' });
    expect(paid.status).toBe('paid');
    expect(paid.payment_method).toBe('MPESA');
    expect(paid.paid_at).toBeDefined();
  });

  it('should refuse to void a paid invoice', async () => {
    await expect(svc.voidInvoice(invoiceId))
      .rejects.toMatchObject({ name: 'InvoiceValidationError', statusCode: 400 });
  });

  it('should mark the invoice paid when COD is collected on delivery', async () => {
    const inv = await svc.createInvoiceForOrder(O2);
    expect(inv.status).toBe('issued');

    await orders.deliverOrder(O2, { recipient_name: 'Cliente COD', cod_method: 'CASH' });

    const after = await svc.getInvoice(inv.id);
    expect(after.status).toBe('paid');
    expect(after.payment_method).toBe('CASH');
    expect(after.issuer?.name).toBeDefined(); // cabeçalho do emissor
  });

  it('should report stats reflecting the paid invoices', async () => {
    const stats = await svc.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.paid).toBeGreaterThanOrEqual(2);
    expect(stats.paid_total_cents).toBeGreaterThanOrEqual(11600 + 5000);
  });
});
