/**
 * @file fiscal.factory.ts
 * @description Test factories da conformidade fiscal (documentos, linhas, séries).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Alinhado com backend/shared/types/src/fiscal.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { DocType, ExemptionCode } from '../../../backend/shared/types/src/fiscal.types';

export interface TestInvoiceLine {
  description: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
  tax_rate_pct: number;
  exemption_code?: ExemptionCode;
  exemption_reason?: string;
}

export interface TestFiscalDocument {
  doc_type: DocType;
  series: string;
  client_name: string;
  client_tax_id?: string;
  client_email?: string;
  items: TestInvoiceLine[];
  notes?: string;
}

/** Documento já assinado, como sai da base — para testar a verificação da cadeia. */
export interface TestSignedDocument {
  number: string;
  seq: number;
  issued_at: string;
  signed_at: string;
  total_cents: number;
  hash: string;
  previous_hash: string;
}

export interface TestDocumentSeries {
  doc_type: DocType;
  series: string;
  year: number;
}

let _lineCounter = 1;
let _docCounter = 1;

export class InvoiceLineFactory {
  /** Linha tributada à taxa normal (16%). */
  static build(overrides: Partial<TestInvoiceLine> = {}): TestInvoiceLine {
    const n = _lineCounter++;
    const total = overrides.total_cents ?? 10000;
    return {
      description:  `Serviço de entrega ITEST ${n}`,
      quantity:     1,
      unit_cents:   total,
      total_cents:  total,
      tax_rate_pct: 16,
      ...overrides,
    };
  }

  /** Linha isenta — leva sempre código e motivo, como a lei exige. */
  static exempt(overrides: Partial<TestInvoiceLine> = {}): TestInvoiceLine {
    return InvoiceLineFactory.build({
      tax_rate_pct: 0,
      exemption_code: ExemptionCode.EXPORTACAO,
      exemption_reason: 'Exportação de serviço — isenção ao abrigo da norma aplicável.',
      ...overrides,
    });
  }

  /** Linha isenta MAL formada (sem motivo) — para provar que é rejeitada. */
  static exemptWithoutReason(overrides: Partial<TestInvoiceLine> = {}): TestInvoiceLine {
    return InvoiceLineFactory.build({ tax_rate_pct: 0, ...overrides });
  }
}

export class FiscalDocumentFactory {
  static build(overrides: Partial<TestFiscalDocument> = {}): TestFiscalDocument {
    const n = _docCounter++;
    return {
      doc_type:      DocType.FT,
      series:        'T',
      client_name:   `Cliente Fiscal ITEST ${n}`,
      client_tax_id: '400123456',
      client_email:  `fiscal.itest.${n}@example.co.mz`,
      items:         [InvoiceLineFactory.build()],
      ...overrides,
    };
  }

  /** Documento com duas taxas — exercita o resumo de IVA por taxa. */
  static mixedRates(overrides: Partial<TestFiscalDocument> = {}): TestFiscalDocument {
    return FiscalDocumentFactory.build({
      items: [
        InvoiceLineFactory.build({ total_cents: 10000, tax_rate_pct: 16 }),
        InvoiceLineFactory.build({ total_cents: 4000, tax_rate_pct: 5 }),
        InvoiceLineFactory.exempt({ total_cents: 2500 }),
      ],
      ...overrides,
    });
  }
}

export class DocumentSeriesFactory {
  static build(overrides: Partial<TestDocumentSeries> = {}): TestDocumentSeries {
    return {
      doc_type: DocType.FT,
      series:   'T',
      year:     new Date().getUTCFullYear(),
      ...overrides,
    };
  }
}

/**
 * Cadeia de documentos assinados, coerente por construção — o teste depois
 * adultera um deles para provar que a verificação apanha.
 */
export class SignedChainFactory {
  static build(
    sign: (input: { number: string; issuedAt: string; signedAt: string; totalCents: number; previousHash?: string }) => { hash: string },
    length = 3,
  ): TestSignedDocument[] {
    const docs: TestSignedDocument[] = [];
    let previous = '0';
    for (let i = 1; i <= length; i += 1) {
      const number = `FT T2026/${String(i).padStart(4, '0')}`;
      const issuedAt = `2026-03-0${i}T10:00:00.000Z`;
      const total = 10000 * i;
      const { hash } = sign({ number, issuedAt, signedAt: issuedAt, totalCents: total, previousHash: previous });
      docs.push({ number, seq: i, issued_at: issuedAt, signed_at: issuedAt, total_cents: total, hash, previous_hash: previous });
      previous = hash;
    }
    return docs;
  }
}

export { DocType, ExemptionCode };
