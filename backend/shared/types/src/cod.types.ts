/**
 * @file cod.types.ts
 * @description Tipos de COD (cobrança na entrega) e acerto de caixa do motorista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.5 (Pagamentos)
 *
 * Valores SEMPRE em centavos inteiros (MZN), como orders.value. Mobile money é
 * rastreado mas não entra no caixa físico do motorista (vai direto para a conta);
 * o acerto de numerário separa os dois.
 */

/** Método de cobrança na entrega. */
export enum CodMethod {
  CASH  = 'CASH',   // numerário — entra no caixa do motorista
  MPESA = 'MPESA',  // mobile money
  EMOLA = 'EMOLA',  // mobile money
  MKESH = 'MKESH',  // mobile money
}

/** Estado do COD de um pedido. */
export enum CodStatus {
  NONE      = 'none',       // sem COD
  PENDING   = 'pending',    // tem COD, ainda não cobrado
  COLLECTED = 'collected',  // cobrado na entrega, por acertar
  SETTLED   = 'settled',    // incluído num acerto do motorista
}

/** Estado de um acerto de caixa. */
export enum SettlementStatus {
  OPEN       = 'open',        // aberto — à espera do numerário do motorista
  RECONCILED = 'reconciled',  // reconciliado — recebido vs esperado
}

/** Métodos que são mobile money (não entram no caixa físico). */
export const MOBILE_COD_METHODS: readonly CodMethod[] = [CodMethod.MPESA, CodMethod.EMOLA, CodMethod.MKESH];

/** @returns true se o método é numerário (entra no caixa). */
export function isCashMethod(method: CodMethod | string): boolean {
  return method === CodMethod.CASH;
}

/** Cobrança COD registada num pedido (no momento da entrega). */
export interface CodCollection {
  /** Valor recolhido em centavos. */
  amount: number;
  method: CodMethod;
  collected_by?: string;
  collected_at: string; // ISO8601 UTC
}

/** Acerto de caixa de um motorista. */
export interface DriverSettlement {
  id: string;
  driver_id: string;
  status: SettlementStatus;
  order_count: number;
  /** Esperado em numerário (soma das cobranças CASH). */
  expected_cash_cents: number;
  /** Esperado em mobile money (informativo — já na conta). */
  expected_mobile_cents: number;
  expected_total_cents: number;
  /** Numerário efetivamente entregue pelo motorista (null enquanto aberto). */
  received_cash_cents: number | null;
  /** received_cash_cents − expected_cash_cents (positivo = sobra; negativo = falta). */
  difference_cents: number | null;
  order_ids: string[];
  opened_at: string;
  opened_by?: string;
  reconciled_at?: string | null;
  reconciled_by?: string | null;
  notes?: string | null;
}
