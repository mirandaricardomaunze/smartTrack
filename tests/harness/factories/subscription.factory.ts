/**
 * @file subscription.factory.ts
 * @description Test factories da camada SaaS (planos e subscrições).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Alinhado com backend/shared/types/src/subscription.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { SubscriptionStatus } from '../../../backend/shared/types/src/subscription.types';

export interface TestPlanInput {
  code: string;
  name: string;
  description?: string;
  price_cents: number;
  trial_days: number;
  max_orders_per_month: number | null;
  max_users: number | null;
  max_warehouses: number | null;
  features?: Record<string, unknown>;
  self_serve?: boolean;
  active?: boolean;
  sort_order?: number;
}

export interface TestSubscriptionInput {
  id: string;
  company_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at?: string | null;
  current_period_start: string;
  current_period_end: string;
  past_due_since?: string | null;
  canceled_at?: string | null;
}

let _planCounter = 1;
let _subCounter = 1;

const DAY_MS = 86_400_000;

export class PlanFactory {
  /** Plano pago com limites apertados — o default facilita testar quotas. */
  static build(overrides: Partial<TestPlanInput> = {}): TestPlanInput {
    const n = _planCounter++;
    return {
      code:                 `plan_itest_${n}`,
      name:                 `Plano Teste ${n}`,
      description:          'Plano criado pelo harness de testes.',
      price_cents:          250000,  // 2.500,00 MZN/mês
      trial_days:           14,
      max_orders_per_month: 3,
      max_users:            2,
      max_warehouses:       1,
      features:             { intl_tracking: true },
      self_serve:           true,
      active:               true,
      sort_order:           n,
      ...overrides,
    };
  }

  /** Plano sem custo nem limites — para provar a via "nunca bloqueia". */
  static unlimited(overrides: Partial<TestPlanInput> = {}): TestPlanInput {
    return PlanFactory.build({
      price_cents: 0,
      trial_days: 0,
      max_orders_per_month: null,
      max_users: null,
      max_warehouses: null,
      ...overrides,
    });
  }
}

export class SubscriptionFactory {
  /** Subscrição ativa, a meio do período. */
  static build(overrides: Partial<TestSubscriptionInput> = {}): TestSubscriptionInput {
    const n = _subCounter++;
    const now = Date.now();
    return {
      id:                   `sub-itest-${n}`,
      company_id:           `company-itest-${n}`,
      plan_code:            'starter',
      status:               SubscriptionStatus.ACTIVE,
      trial_ends_at:        null,
      current_period_start: new Date(now - 10 * DAY_MS).toISOString(),
      current_period_end:   new Date(now + 20 * DAY_MS).toISOString(),
      past_due_since:       null,
      canceled_at:          null,
      ...overrides,
    };
  }

  /** Em avaliação, a terminar dentro de `daysLeft` dias. */
  static trialing(daysLeft = 7, overrides: Partial<TestSubscriptionInput> = {}): TestSubscriptionInput {
    const trialEnd = new Date(Date.now() + daysLeft * DAY_MS).toISOString();
    return SubscriptionFactory.build({
      status: SubscriptionStatus.TRIALING,
      trial_ends_at: trialEnd,
      current_period_start: new Date().toISOString(),
      current_period_end: trialEnd,
      ...overrides,
    });
  }

  /** Avaliação já terminada há `daysAgo` dias — obriga a transição. */
  static trialExpired(daysAgo = 1, overrides: Partial<TestSubscriptionInput> = {}): TestSubscriptionInput {
    const trialEnd = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    return SubscriptionFactory.build({
      status: SubscriptionStatus.TRIALING,
      trial_ends_at: trialEnd,
      current_period_start: new Date(Date.now() - (daysAgo + 14) * DAY_MS).toISOString(),
      current_period_end: trialEnd,
      ...overrides,
    });
  }

  /** Por pagar há `daysAgo` dias — para exercitar a tolerância. */
  static pastDue(daysAgo = 1, overrides: Partial<TestSubscriptionInput> = {}): TestSubscriptionInput {
    const since = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    return SubscriptionFactory.build({
      status: SubscriptionStatus.PAST_DUE,
      past_due_since: since,
      current_period_start: since,
      current_period_end: new Date(Date.now() + (30 - daysAgo) * DAY_MS).toISOString(),
      ...overrides,
    });
  }
}

export { SubscriptionStatus };
