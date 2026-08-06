/**
 * @file payment.types.ts
 * @description Tipos compartilhados do domínio de pagamentos.
 * Ver .agents/skills/payment-idempotency/SKILL.md para regras de uso.
 */
export enum PaymentStatus {
  PENDING    = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED  = 'succeeded',
  FAILED     = 'failed',
  REFUNDED   = 'refunded',
  CANCELLED  = 'cancelled',
}

export enum PaymentGateway {
  MERCADO_PAGO = 'MERCADO_PAGO',
  STRIPE       = 'STRIPE',
  PAGSEGURO    = 'PAGSEGURO',
}

export interface Pagamento {
  id: string;
  pedido_id: string;
  /** Valor em centavos inteiros. Nunca usar float. Ex: R$ 29,90 = 2990 */
  valor: number;
  status: PaymentStatus;
  gateway: PaymentGateway;
  gateway_transaction_id: string | null;
  /** Formato: `${pedido_id}:charge:${tentativa_numero}` */
  idempotency_key: string;
  tentativa_numero: number;
  criado_em: string;   // ISO8601 UTC
  atualizado_em: string;
}
