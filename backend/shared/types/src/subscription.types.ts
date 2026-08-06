/**
 * @file subscription.types.ts
 * @description Tipos de Planos e Subscrições (camada SaaS).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Aqui a PLATAFORMA cobra as EMPRESAS. Não confundir com `invoice.types.ts`
 * (§ 3.14), onde a empresa cobra os seus clientes pelo frete.
 * Valores monetários em centavos (MZN); o preço do plano é mensal com IVA incluído.
 */

export enum SubscriptionStatus {
  /** Período de avaliação — sem cobrança até `trial_ends_at`. */
  TRIALING = 'trialing',
  /** Em dia. */
  ACTIVE = 'active',
  /** Fatura por pagar; o serviço continua durante a tolerância. */
  PAST_DUE = 'past_due',
  /** Cancelada — as escritas ficam bloqueadas até escolher um plano. */
  CANCELED = 'canceled',
}

export enum SubscriptionInvoiceStatus {
  ISSUED = 'issued',
  PAID = 'paid',
  VOID = 'void',
}

/** Métodos aceites na cobrança da subscrição. */
export enum BillingMethod {
  MPESA = 'mpesa',
  EMOLA = 'emola',
  /** Transferência/depósito confirmado manualmente pelo SUPERADMIN. */
  MANUAL = 'manual_transfer',
}

/** Métricas medidas por período (`YYYY-MM`). */
export enum UsageMetric {
  ORDERS = 'orders',
}

export interface Plan {
  code: string;
  name: string;
  description?: string;
  /** Mensal, em centavos, IVA incluído. 0 = grátis ou negociado. */
  price_cents: number;
  currency: string;
  trial_days: number;
  /** null = ilimitado. */
  max_orders_per_month: number | null;
  max_users: number | null;
  max_warehouses: number | null;
  features: Record<string, unknown>;
  /** false = plano por contrato: não aparece no upgrade self-service. */
  self_serve: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  company_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at?: string;
  current_period_start: string;
  current_period_end: string;
  /** Desde quando há fatura por pagar — origem da contagem da tolerância. */
  past_due_since?: string;
  canceled_at?: string;
  created_at: string;
  updated_at: string;
}

/** Resultado da avaliação de acesso (escritas bloqueadas ou não). */
export interface SubscriptionAccess {
  blocked: boolean;
  reason?: string;
  grace_ends_at?: string;
}

/** Estado de um limite do plano. `limit` null = ilimitado. */
export interface LimitUsage {
  used: number;
  limit: number | null;
  remaining: number | null;
  exceeded: boolean;
  percent: number | null;
}

export interface SubscriptionUsage {
  /** Período de medição, `YYYY-MM` (UTC). */
  period: string;
  orders: LimitUsage;
  users: LimitUsage;
  warehouses: LimitUsage;
  /** Informativo — os motoristas não têm limite de plano. */
  drivers: LimitUsage;
}

export interface SubscriptionInvoice {
  id: string;
  /** SB{ano}/{seq} — sequência global (o emissor é a plataforma). */
  number: string;
  company_id: string;
  company_name: string;
  plan_code: string;
  plan_name: string;
  period_start: string;
  period_end: string;
  subtotal_cents: number;
  tax_rate_pct: number;
  tax_cents: number;
  total_cents: number;
  status: SubscriptionInvoiceStatus;
  payment_method?: string;
  payment_ref?: string;
  issued_at: string;
  paid_at?: string;
  voided_at?: string;
  created_at: string;
  updated_at: string;
}

/** Resposta de `GET /v1/subscriptions/me`. */
export interface SubscriptionState {
  subscription: Subscription;
  plan: Plan | null;
  access: SubscriptionAccess;
  usage: SubscriptionUsage;
  invoices: SubscriptionInvoice[];
}

/** Linha da consola da plataforma (SUPERADMIN). */
export interface SubscriptionSummary extends Subscription {
  company_name: string;
  company_status: string;
  plan_name: string;
  price_cents: number;
}

/** Receita da plataforma. */
export interface PlatformBillingStats {
  /** Receita recorrente mensal (subscrições ativas e em atraso). */
  mrr_cents: number;
  trialing: number;
  active: number;
  past_due: number;
  canceled: number;
  /** Faturas emitidas por cobrar. */
  outstanding_cents: number;
  collected_cents: number;
}
