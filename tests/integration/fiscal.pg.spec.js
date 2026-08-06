/**
 * @file fiscal.pg.spec.js
 * @description Testes de integração da conformidade fiscal contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Prova, contra a base real (`track`): a numeração por série sem saltos; a
 * assinatura encadeada entre documentos consecutivos; a nota de crédito a
 * referenciar e a reverter a fatura; a recusa de anular um documento pago; a
 * rejeição de linhas isentas sem motivo e de NUIT inválido; o mapa de IVA com a
 * nota de crédito a subtrair; a exportação SAF-T do período; o relatório de
 * integridade a apanhar uma adulteração feita diretamente na base; e o
 * isolamento das séries entre empresas. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona séries + campos fiscais)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { FiscalDocumentFactory, InvoiceLineFactory, DocumentSeriesFactory } from '../harness/factories/fiscal.factory';
import { CompanyFactory } from '../harness/factories/company.factory';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const fiscal = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/fiscal`) : null;
const repo   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY_A = 'company-itest-fiscal-a';
const COMPANY_B = 'company-itest-fiscal-b';
const SERIES = 'T';
const ORDER_ID = 'order-itest-fiscal-0001';
const YEAR = new Date().getUTCFullYear();

/** Corre o caso de uso como um utilizador da empresa (multi-tenant, § 2.4). */
function asCompany(companyId, fn) {
  return tenant.runWithCompany(companyId, fn);
}

async function cleanup() {
  const companies = [COMPANY_A, COMPANY_B];
  await pool.query('DELETE FROM invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM document_series WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM orders WHERE company_id = ANY($1) OR id = $2', [companies, ORDER_ID]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
}

describe.skipIf(!disponivel)('api-gateway · conformidade fiscal · PostgreSQL', () => {
  let firstInvoice;
  let secondInvoice;

  beforeAll(async () => {
    await cleanup();
    for (const [id, name] of [[COMPANY_A, 'Transportes ITEST A'], [COMPANY_B, 'Transportes ITEST B']]) {
      await repo.CompanyRepository.create(CompanyFactory.build({ id, name, slug: id }));
    }
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Emissão e numeração ───────────────────────────────────────────────────

  it('should issue a signed document numbered by series', async () => {
    const doc = FiscalDocumentFactory.build({ series: SERIES });
    firstInvoice = await asCompany(COMPANY_A, () => svc.issueDocument(doc));

    expect(firstInvoice.number).toBe(fiscal.formatDocumentNumber('FT', SERIES, YEAR, 1));
    expect(firstInvoice.doc_type).toBe('FT');
    expect(firstInvoice.seq).toBe(1);
    expect(firstInvoice.hash).toBeTruthy();
    expect(firstInvoice.hash_control).toHaveLength(4);
    // Primeiro da cadeia: encadeia no valor de génese.
    expect(firstInvoice.previous_hash).toBe(fiscal.GENESIS_HASH);
    expect(firstInvoice.issuer_tax_id).toMatch(/^\d{9}$/);
  });

  it('should chain each document to the previous one of the same series', async () => {
    secondInvoice = await asCompany(COMPANY_A, () => svc.issueDocument(FiscalDocumentFactory.build({ series: SERIES })));

    expect(secondInvoice.seq).toBe(2);
    expect(secondInvoice.previous_hash).toBe(firstInvoice.hash);
    expect(secondInvoice.hash).not.toBe(firstInvoice.hash);
  });

  it('should number series independently of each other', async () => {
    const other = DocumentSeriesFactory.build({ series: 'LOJA2' });
    const doc = await asCompany(COMPANY_A, () => svc.issueDocument(FiscalDocumentFactory.build({ series: other.series })));

    expect(doc.seq).toBe(1); // série nova recomeça do 1
    expect(doc.number).toContain('LOJA2');
    expect(doc.previous_hash).toBe(fiscal.GENESIS_HASH); // cadeia própria
  });

  it('should record the VAT summary per rate on the document', async () => {
    const doc = await asCompany(COMPANY_A, () => svc.issueDocument(FiscalDocumentFactory.mixedRates({ series: SERIES })));

    expect(doc.tax_summary.map((l) => l.rate_pct)).toEqual([16, 5, 0]);
    expect(doc.subtotal_cents).toBe(16500);
    expect(doc.tax_cents).toBe(1800);
    expect(doc.total_cents).toBe(18300);
    expect(doc.tax_summary[2].exemption_reason).toMatch(/Exportação/);
  });

  // ── Validações que protegem o arquivo ─────────────────────────────────────

  it('should refuse an exempt line without a justification', async () => {
    const doc = FiscalDocumentFactory.build({ series: SERIES, items: [InvoiceLineFactory.exemptWithoutReason()] });
    await expect(asCompany(COMPANY_A, () => svc.issueDocument(doc)))
      .rejects.toMatchObject({ name: 'FiscalValidationError', statusCode: 400 });
  });

  it('should refuse an invalid customer NUIT', async () => {
    const doc = FiscalDocumentFactory.build({ series: SERIES, client_tax_id: '123' });
    await expect(asCompany(COMPANY_A, () => svc.issueDocument(doc)))
      .rejects.toMatchObject({ name: 'InvoiceValidationError', statusCode: 400 });
  });

  it('should refuse a document without lines', async () => {
    await expect(asCompany(COMPANY_A, () => svc.issueDocument(FiscalDocumentFactory.build({ series: SERIES, items: [] }))))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Retificação ───────────────────────────────────────────────────────────

  it('should issue a credit note that references and reverses the invoice', async () => {
    const note = await asCompany(COMPANY_A, () => svc.createCreditNote(firstInvoice.id, { reason: 'Serviço não prestado — cliente cancelou.' }));

    expect(note.doc_type).toBe('NC');
    expect(note.number).toContain('NC ');
    expect(note.related_invoice_id).toBe(firstInvoice.id);
    expect(note.related_number).toBe(firstInvoice.number);
    expect(note.total_cents).toBe(firstInvoice.total_cents);

    const original = await asCompany(COMPANY_A, () => svc.getInvoice(firstInvoice.id));
    expect(original.credited_cents).toBe(firstInvoice.total_cents);
  });

  it('should refuse to credit the same document twice', async () => {
    await expect(asCompany(COMPANY_A, () => svc.createCreditNote(firstInvoice.id, { reason: 'Tentativa repetida de crédito.' })))
      .rejects.toMatchObject({ name: 'InvoiceValidationError', statusCode: 400 });
  });

  it('should credit part of a document and keep the remainder open', async () => {
    const partial = await asCompany(COMPANY_A, () => svc.createCreditNote(secondInvoice.id, {
      reason: 'Desconto comercial acordado depois da emissão.',
      amount_cents: 2000,
    }));

    expect(partial.total_cents).toBe(2000);
    const original = await asCompany(COMPANY_A, () => svc.getInvoice(secondInvoice.id));
    expect(original.credited_cents).toBe(2000);
  });

  it('should require a reason for the credit note', async () => {
    await expect(asCompany(COMPANY_A, () => svc.createCreditNote(secondInvoice.id, { reason: '' })))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('should refuse to void a paid document and point to the credit note', async () => {
    const invoice = await asCompany(COMPANY_A, () => svc.issueDocument(FiscalDocumentFactory.build({ series: SERIES })));
    await asCompany(COMPANY_A, () => svc.markPaid(invoice.id, { payment_method: 'MPESA' }));

    await expect(asCompany(COMPANY_A, () => svc.voidInvoice(invoice.id)))
      .rejects.toThrowError(/nota de crédito/i);
  });

  it('should keep a voided document in the archive, with number and reason', async () => {
    const invoice = await asCompany(COMPANY_A, () => svc.issueDocument(FiscalDocumentFactory.build({ series: SERIES })));
    const voided = await asCompany(COMPANY_A, () => svc.voidInvoice(invoice.id, { reason: 'Emitida por engano' }));

    expect(voided.status).toBe('void');
    expect(voided.void_reason).toBe('Emitida por engano');
    expect(voided.number).toBe(invoice.number); // o número não é reciclado
    expect(voided.hash).toBe(invoice.hash);     // a assinatura mantém-se
  });

  // ── Obrigações periódicas ─────────────────────────────────────────────────

  it('should build the VAT report with credit notes subtracted', async () => {
    const report = await asCompany(COMPANY_A, () => svc.getTaxReport({}));

    const normal = report.lines.find((l) => l.rate_pct === 16);
    const exempt = report.lines.find((l) => l.rate_pct === 0);
    expect(normal).toBeDefined();
    expect(exempt.label).toMatch(/Isento/);
    // Houve créditos: a base tributável do período é menor do que a soma bruta emitida.
    expect(normal.base_cents).toBeLessThan(10000 * 6);
    expect(report.totals.gross_cents).toBe(report.totals.base_cents + report.totals.tax_cents);
    expect(report.documents.find((d) => d.doc_type === 'NC')).toBeDefined();
    expect(report.issuer.tax_id).toBeTruthy();
  });

  it('should export a SAF-T file for the period', async () => {
    const result = await asCompany(COMPANY_A, () => svc.exportSaft({}));

    expect(result.filename).toMatch(/^SAFT_\d{6}\.xml$/);
    expect(result.documents).toBeGreaterThan(0);
    expect(result.xml).toContain('<AuditFile');
    expect(result.xml).toContain(firstInvoice.number);
    expect(result.xml).toContain('<TaxCountryRegion>MZ</TaxCountryRegion>');
  });

  it('should link the invoice of an order to its tracking code', async () => {
    await repo.OrderRepository.create({
      ...OrderFactory.build({ id: ORDER_ID, tracking_code: 'TRK-ITESTFISC-01' }),
      value: 11600, history: [],
      company_id: COMPANY_A,
    });

    const invoice = await asCompany(COMPANY_A, () => svc.createInvoiceForOrder(ORDER_ID));
    expect(invoice.tracking_code).toBe('TRK-ITESTFISC-01');
    expect(invoice.subtotal_cents).toBe(10000);
    expect(invoice.tax_cents).toBe(1600);
    expect(invoice.hash).toBeTruthy();
  });

  it('should credit an order-linked invoice without clashing with it', async () => {
    // A regra "uma fatura ativa por pedido" (§ 3.14) não pode impedir a nota de
    // crédito, que refere o MESMO pedido.
    const list = await asCompany(COMPANY_A, () => svc.listInvoices({ search: 'TRK-ITESTFISC-01' }));
    const invoice = list.items.find((i) => i.doc_type === 'FT');

    const note = await asCompany(COMPANY_A, () => svc.createCreditNote(invoice.id, {
      reason: 'Entrega falhada — crédito ao cliente.',
    }));

    expect(note.doc_type).toBe('NC');
    expect(note.order_id).toBe(ORDER_ID);

    // E a fatura do pedido continua a ser a de venda, não a nota de crédito.
    const active = await asCompany(COMPANY_A, () => repo.InvoiceRepository.findActiveByOrderId(ORDER_ID));
    expect(active.doc_type).toBe('FT');
  });

  // ── Inviolabilidade ───────────────────────────────────────────────────────

  it('should report a healthy chain', async () => {
    const report = await asCompany(COMPANY_A, () => svc.verifyIntegrity());

    expect(report.ok).toBe(true);
    expect(report.chains.length).toBeGreaterThan(0);
    expect(report.chains.every((c) => c.broken.length === 0)).toBe(true);
    expect(report.software.certificate).toBe('0');
  });

  it('should detect a value tampered with directly in the database', async () => {
    await pool.query('UPDATE invoices SET total_cents = total_cents + 1 WHERE id = $1', [secondInvoice.id]);

    const report = await asCompany(COMPANY_A, () => svc.verifyIntegrity());
    expect(report.ok).toBe(false);
    const chain = report.chains.find((c) => c.doc_type === 'FT' && c.series === SERIES);
    expect(chain.broken.map((b) => b.number)).toContain(secondInvoice.number);

    // Repõe para não contaminar os testes seguintes.
    await pool.query('UPDATE invoices SET total_cents = total_cents - 1 WHERE id = $1', [secondInvoice.id]);
  });

  // ── Multiempresa ──────────────────────────────────────────────────────────

  it('should keep numbering and chains isolated per company', async () => {
    const docB = await asCompany(COMPANY_B, () => svc.issueDocument(FiscalDocumentFactory.build({ series: SERIES })));

    expect(docB.seq).toBe(1); // a empresa B começa a sua própria sequência
    expect(docB.previous_hash).toBe(fiscal.GENESIS_HASH);

    const seriesB = await asCompany(COMPANY_B, () => svc.listSeries(YEAR));
    expect(seriesB.every((s) => s.company_id === COMPANY_B)).toBe(true);

    // E a empresa B não vê os documentos da A no seu mapa de IVA.
    const reportB = await asCompany(COMPANY_B, () => svc.getTaxReport({}));
    expect(reportB.documents.find((d) => d.doc_type === 'FT').total).toBe(1);
  });

  it('should register a new series without emitting anything', async () => {
    const created = await asCompany(COMPANY_B, () => svc.createSeries(DocumentSeriesFactory.build({ series: 'LOJA9' })));

    expect(created).toMatchObject({ doc_type: 'FT', series: 'LOJA9', last_seq: 0, company_id: COMPANY_B });
  });

  it('should reject an unknown document type for a series', async () => {
    await expect(asCompany(COMPANY_B, () => svc.createSeries({ doc_type: 'XX', series: 'A' })))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
