/**
 * @file invoice.types.ts
 * @description Tipos de faturação (fatura-recibo interna).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14
 *
 * Documento fiscal interno emitido a partir de um pedido: fatura o serviço de
 * entrega (frete). O valor do pedido é tratado como total com IVA incluído — a
 * base tributável e o IVA (16%, MZ) são extraídos. Valores em centavos (MZN).
 * O COD (valor das mercadorias) é um fluxo à parte e não entra na fatura.
 */

export enum InvoiceStatus {
  ISSUED = 'issued',   // emitida, por pagar
  PAID   = 'paid',     // paga (fatura-recibo)
  VOID   = 'void',     // anulada
}

/** Linha de fatura (valores líquidos, sem IVA). */
export interface InvoiceItem {
  description: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
}

export interface Invoice {
  id: string;
  number: string;              // ex.: 'FT2026/0001'
  order_id?: string;
  tracking_code?: string;
  client_ref_id?: string;
  client_name: string;
  client_tax_id?: string;      // NUIT do cliente
  client_email?: string;
  items: InvoiceItem[];
  subtotal_cents: number;      // base tributável (sem IVA)
  tax_rate_pct: number;        // 16
  tax_cents: number;           // IVA
  total_cents: number;         // subtotal + IVA (= valor do pedido)
  status: InvoiceStatus;
  payment_method?: string;     // quando paga (CASH/MPESA/…)
  notes?: string;
  issued_at: string;           // ISO8601 UTC
  paid_at?: string;
  voided_at?: string;
  created_at: string;
  updated_at: string;
}

export interface InvoiceStats {
  total: number;
  issued: number;
  paid: number;
  void: number;
  issued_total_cents: number;  // por cobrar (emitidas)
  paid_total_cents: number;    // cobrado (pagas)
}
