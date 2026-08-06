/**
 * @file invoice.factory.ts
 * @description Test factory para faturas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14
 *
 * Alinhado com backend/shared/types/src/invoice.types.ts. As faturas são
 * normalmente emitidas a partir de um pedido; esta factory serve asserções e a
 * inserção direta de linhas quando o teste precisa de controlar os valores.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { InvoiceStatus } from '../../../backend/shared/types/src/invoice.types';

export interface TestInvoiceItem {
  description: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
}

export interface TestInvoiceInput {
  id: string;
  order_id?: string;
  tracking_code?: string;
  client_ref_id?: string;
  client_name: string;
  client_tax_id?: string;
  client_email?: string;
  items: TestInvoiceItem[];
  subtotal_cents: number;
  tax_rate_pct: number;
  tax_cents: number;
  total_cents: number;
  notes?: string;
}

let _counter = 1;

export class InvoiceFactory {
  /** Fatura com total 11.600 (base 10.000 + IVA 16% 1.600) por default. */
  static build(overrides: Partial<TestInvoiceInput> = {}): TestInvoiceInput {
    const n = _counter++;
    const base = 10000;
    return {
      id:             `invoice-test-${n.toString().padStart(4, '0')}`,
      order_id:       `order-test-uuid-${n.toString().padStart(4, '0')}`,
      tracking_code:  `TRK${String(n).padStart(8, '0')}BR`,
      client_name:    `Cliente Teste ${n}`,
      client_tax_id:  undefined,
      items:          [{ description: 'Serviço de entrega', quantity: 1, unit_cents: base, total_cents: base }],
      subtotal_cents: base,
      tax_rate_pct:   16,
      tax_cents:      1600,
      total_cents:    11600,
      notes:          undefined,
      ...overrides,
    };
  }
}

export { InvoiceStatus };
