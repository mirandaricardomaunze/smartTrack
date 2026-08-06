/**
 * @file fiscal.spec.ts
 * @description Testes unitários do núcleo fiscal (regras puras).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Cobre o que um auditor verifica sem olhar para a base de dados: validação do
 * NUIT, decomposição do IVA por taxa, obrigatoriedade do motivo de isenção,
 * formato do número por série, assinatura encadeada e deteção de adulteração ou
 * de saltos na numeração. Dados via factories do harness.
 */
import { describe, expect, it } from 'vitest';
import { InvoiceLineFactory, FiscalDocumentFactory, SignedChainFactory } from '../../../../tests/harness';

// CommonJS é a fronteira atual do monólito modular.
const fiscal = require('./fiscal');
const { buildSaftXml } = require('./saft');

describe('Fiscal · NUIT', () => {
  it('should accept a 9-digit NUIT with separators', () => {
    expect(fiscal.isValidNuit('400 123 456')).toBe(true);
    expect(fiscal.normalizeNuit('400 123 456')).toBe('400123456');
  });

  it.each(['12345678', '1234567890', 'abcdefghi', ''])('should reject %s', (value) => {
    expect(fiscal.isValidNuit(value)).toBe(false);
  });
});

describe('Fiscal · linhas e IVA', () => {
  it('should compute the tax of a line from its rate', () => {
    const line = fiscal.normalizeLine(InvoiceLineFactory.build({ total_cents: 10000, tax_rate_pct: 16 }));
    expect(line.tax_cents).toBe(1600);
  });

  it('should default to the standard rate when none is given', () => {
    const line = fiscal.normalizeLine({ description: 'Frete', total_cents: 10000 });
    expect(line.tax_rate_pct).toBe(fiscal.DEFAULT_TAX_RATE_PCT);
  });

  it('should refuse an exempt line without an exemption reason', () => {
    expect(() => fiscal.normalizeLine(InvoiceLineFactory.exemptWithoutReason()))
      .toThrowError(/isenta sem código/i);
  });

  it('should refuse an exempt line whose reason is too short to cite the law', () => {
    expect(() => fiscal.normalizeLine(InvoiceLineFactory.exempt({ exemption_reason: 'n/a' })))
      .toThrowError(/motivo por extenso/i);
  });

  it('should refuse a line without a description', () => {
    expect(() => fiscal.normalizeLine({ total_cents: 100 })).toThrowError(/descrição/i);
  });

  it('should refuse an impossible tax rate', () => {
    expect(() => fiscal.normalizeLine(InvoiceLineFactory.build({ tax_rate_pct: 150 }))).toThrowError(/Taxa de IVA/i);
  });

  it('should group the summary by rate and keep the exemption reason', () => {
    const doc = FiscalDocumentFactory.mixedRates();
    const lines = doc.items.map((i) => fiscal.normalizeLine(i));
    const summary = fiscal.buildTaxSummary(lines);

    // Ordenado por taxa decrescente: 16%, 5%, isento.
    expect(summary.map((l: { rate_pct: number }) => l.rate_pct)).toEqual([16, 5, 0]);
    expect(summary[0]).toMatchObject({ base_cents: 10000, tax_cents: 1600 });
    expect(summary[1]).toMatchObject({ base_cents: 4000, tax_cents: 200 });
    expect(summary[2]).toMatchObject({ base_cents: 2500, tax_cents: 0, exemption_code: 'EXPORTACAO' });
    expect(summary[2].exemption_reason).toMatch(/Exportação/);
  });

  it('should total the document from its summary', () => {
    const lines = FiscalDocumentFactory.mixedRates().items.map((i) => fiscal.normalizeLine(i));
    const totals = fiscal.totalsFromSummary(fiscal.buildTaxSummary(lines));
    expect(totals).toEqual({ subtotal_cents: 16500, tax_cents: 1800, total_cents: 18300 });
  });

  it('should extract tax from a tax-inclusive total', () => {
    expect(fiscal.splitTaxInclusive(11600, 16)).toMatchObject({ subtotal_cents: 10000, tax_cents: 1600 });
  });
});

describe('Fiscal · numeração', () => {
  it('should format the legal number with type, series and year', () => {
    expect(fiscal.formatDocumentNumber('FT', 'A', 2026, 7)).toBe('FT A2026/0007');
  });

  it('should normalise a series to uppercase', () => {
    expect(fiscal.normalizeSeries('loja1')).toBe('LOJA1');
  });

  it.each(['', 'DEMASIADO', 'A-1'])('should reject the invalid series %s', (value) => {
    expect(() => fiscal.normalizeSeries(value)).toThrowError(/Série inválida/i);
  });

  it('should derive the tax period from a date', () => {
    expect(fiscal.taxPeriod('2026-03-31T23:00:00.000Z')).toBe('2026-03');
  });
});

describe('Fiscal · assinatura e inviolabilidade', () => {
  const doc = {
    issuedAt: '2026-03-01T10:00:00.000Z',
    signedAt: '2026-03-01T10:00:00.000Z',
    number: 'FT A2026/0001',
    totalCents: 11600,
  };

  it('should be deterministic for the same content', () => {
    expect(fiscal.signDocument(doc).hash).toBe(fiscal.signDocument(doc).hash);
  });

  it('should change when a single cent changes', () => {
    const a = fiscal.signDocument(doc).hash;
    const b = fiscal.signDocument({ ...doc, totalCents: 11601 }).hash;
    expect(a).not.toBe(b);
  });

  it('should chain: the same document signs differently after a different predecessor', () => {
    const first = fiscal.signDocument(doc);
    const chained = fiscal.signDocument({ ...doc, number: 'FT A2026/0002', previousHash: first.hash });
    expect(chained.previous_hash).toBe(first.hash);
    expect(chained.hash).not.toBe(first.hash);
  });

  it('should print a 4-character control taken from fixed positions', () => {
    const { hash, hash_control: control } = fiscal.signDocument(doc);
    expect(control).toHaveLength(4);
    expect(control).toBe([hash[0], hash[10], hash[20], hash[30]].join(''));
  });

  it('should validate a well-formed chain', () => {
    const chain = SignedChainFactory.build(fiscal.signDocument, 4);
    expect(fiscal.verifyChain(chain)).toMatchObject({ ok: true, checked: 4, unsigned: 0, broken: [], gaps: [] });
  });

  it('should catch a tampered amount', () => {
    const chain = SignedChainFactory.build(fiscal.signDocument, 3);
    chain[1].total_cents += 100; // alguém "corrigiu" a fatura na base

    const result = fiscal.verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.broken[0]).toMatchObject({ number: chain[1].number });
    expect(result.broken[0].reason).toMatch(/não corresponde/i);
  });

  it('should catch a document removed from the middle of the chain', () => {
    const chain = SignedChainFactory.build(fiscal.signDocument, 3);
    const withHole = [chain[0], chain[2]];

    const result = fiscal.verifyChain(withHole);
    expect(result.ok).toBe(false);
    expect(result.gaps).toEqual([{ expected: 2, found: 3 }]);
  });

  it('should count pre-fiscal documents as unsigned instead of broken', () => {
    const legacy = [{ number: 'FT2026/0001', seq: 1, issued_at: '2026-01-05T09:00:00.000Z', total_cents: 5000 }];
    expect(fiscal.verifyChain(legacy)).toMatchObject({ ok: true, unsigned: 1, broken: [] });
  });

  it('should never claim a certification it does not have', () => {
    expect(fiscal.SOFTWARE.certificate).toBe('0');
  });
});

describe('Fiscal · exportação SAF-T', () => {
  const issuer = { name: 'Transportes ITEST, Lda.', tax_id: '400123456', address: 'Av. 25 de Setembro', city: 'Maputo' };

  function sampleInvoice(overrides = {}) {
    const items = FiscalDocumentFactory.build().items.map((i) => fiscal.normalizeLine(i));
    const summary = fiscal.buildTaxSummary(items);
    const totals = fiscal.totalsFromSummary(summary);
    const signature = fiscal.signDocument({
      issuedAt: '2026-03-04T08:00:00.000Z', signedAt: '2026-03-04T08:00:00.000Z',
      number: 'FT T2026/0001', totalCents: totals.total_cents,
    });
    return {
      number: 'FT T2026/0001', doc_type: 'FT', status: 'issued',
      issued_at: '2026-03-04T08:00:00.000Z', items, tax_summary: summary,
      client_ref_id: 'client-1', client_name: 'Cliente ITEST',
      ...totals, ...signature, ...overrides,
    };
  }

  it('should produce an AuditFile with the issuer, the document and its signature', () => {
    const invoice = sampleInvoice();
    const xml = buildSaftXml({
      issuer, period: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      invoices: [invoice], customers: [{ id: 'client-1', name: 'Cliente ITEST', tax_id: '400999888' }],
      generatedAt: '2026-04-01T00:00:00.000Z',
    });

    expect(xml).toContain('<AuditFile');
    expect(xml).toContain('<TaxRegistrationNumber>400123456</TaxRegistrationNumber>');
    expect(xml).toContain('<InvoiceNo>FT T2026/0001</InvoiceNo>');
    expect(xml).toContain(`<Hash>${invoice.hash}</Hash>`);
    expect(xml).toContain('<InvoiceStatus>N</InvoiceStatus>');
    // Valores em unidades monetárias, não em centavos.
    expect(xml).toContain('<GrossTotal>116.00</GrossTotal>');
    expect(xml).toContain('<SoftwareCertificateNumber>0</SoftwareCertificateNumber>');
  });

  it('should mark a voided document as A and keep it in the file', () => {
    const xml = buildSaftXml({
      issuer, period: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      invoices: [sampleInvoice({ status: 'void', void_reason: 'Emitida por engano' })],
    });
    expect(xml).toContain('<InvoiceStatus>A</InvoiceStatus>');
    expect(xml).toContain('<Reason>Emitida por engano</Reason>');
  });

  it('should book a credit note as a debit', () => {
    const xml = buildSaftXml({
      issuer, period: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      invoices: [sampleInvoice({ doc_type: 'NC', number: 'NC T2026/0001', related_number: 'FT T2026/0001' })],
    });
    expect(xml).toContain('<DebitAmount>100.00</DebitAmount>');
    expect(xml).toContain('<References>FT T2026/0001</References>');
  });

  it('should escape characters that would break the XML', () => {
    const xml = buildSaftXml({
      issuer: { ...issuer, name: 'Transportes & Cia <Lda>' },
      period: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
      invoices: [],
    });
    expect(xml).toContain('Transportes &amp; Cia &lt;Lda&gt;');
  });
});
