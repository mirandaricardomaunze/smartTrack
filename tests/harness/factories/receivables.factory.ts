/**
 * @file receivables.factory.ts
 * @description Factory das contas a receber por cliente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.41
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export type AgingBucket = 'corrente' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_mais' | 'sem_prazo';

/** Uma fatura em aberto, no formato que o cálculo de antiguidade consome. */
export interface TestReceivableInvoice {
  id: string;
  number: string;
  doc_type: 'FT' | 'FR' | 'NC';
  status: 'issued' | 'paid' | 'void';
  client_ref_id: string;
  client_name: string;
  total_cents: number;
  issued_at: string;
  /** `null` = fatura-recibo, paga no ato, sem prazo acordado (§ 3.35). */
  due_date: string | null;
}

/** Dia de referência fixo — a antiguidade tem de ser afirmável sem depender de hoje. */
export const HOJE = '2026-08-09';

/** `days` dias antes de `HOJE`, em YYYY-MM-DD. */
function antes(days: number): string {
  return new Date(Date.parse(`${HOJE}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** `days` dias depois de `HOJE`. */
function depois(days: number): string {
  return new Date(Date.parse(`${HOJE}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

let contador = 1;

export class ReceivablesFactory {
  static invoice(overrides: Partial<TestReceivableInvoice> = {}): TestReceivableInvoice {
    const n = contador++;
    return {
      id:            `invoice-test-${String(n).padStart(4, '0')}`,
      number:        `FT2026/${String(n).padStart(4, '0')}`,
      doc_type:      'FT',
      status:        'issued',
      client_ref_id: 'client-test-recv-0001',
      client_name:   'Cliente Devedor, Lda',
      total_cents:   100_000,
      issued_at:     `${antes(10)}T09:00:00.000Z`,
      due_date:      depois(20),
      ...overrides,
    };
  }

  /**
   * Uma fatura por escalão, para afirmar a classificação toda de uma vez sem
   * espalhar datas mágicas pelos testes.
   */
  static onePerBucket(): TestReceivableInvoice[] {
    return [
      ReceivablesFactory.invoice({ due_date: depois(20), total_cents: 10_000 }),  // corrente
      ReceivablesFactory.invoice({ due_date: antes(10),  total_cents: 20_000 }),  // 1–30
      ReceivablesFactory.invoice({ due_date: antes(45),  total_cents: 30_000 }),  // 31–60
      ReceivablesFactory.invoice({ due_date: antes(75),  total_cents: 40_000 }),  // 61–90
      ReceivablesFactory.invoice({ due_date: antes(200), total_cents: 50_000 }),  // +90
      ReceivablesFactory.invoice({ due_date: null,       total_cents: 60_000 }),  // sem prazo
    ];
  }

  /** Nota de crédito: abate à dívida do cliente. */
  static creditNote(amountCents = 25_000): TestReceivableInvoice {
    return ReceivablesFactory.invoice({
      doc_type: 'NC', number: `NC2026/${contador}`, total_cents: amountCents,
    });
  }

  /** Fatura já paga — não é dívida e não pode aparecer no mapa. */
  static paid(): TestReceivableInvoice {
    return ReceivablesFactory.invoice({ status: 'paid', total_cents: 999_000 });
  }

  /** Fatura anulada — idem. */
  static voided(): TestReceivableInvoice {
    return ReceivablesFactory.invoice({ status: 'void', total_cents: 888_000 });
  }

  static readonly antes = antes;
  static readonly depois = depois;
}
