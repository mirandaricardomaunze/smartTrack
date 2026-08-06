/**
 * @file SubscriptionBanner.spec.ts
 * @description Testes da decisão do aviso de subscrição (função pura).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * O que importa aqui é a ORDEM DE SEVERIDADE: bloqueio > atraso > limite perto
 * do fim > avaliação a terminar — e o silêncio quando está tudo em dia.
 */
import { describe, expect, it } from 'vitest';
import { buildMessage } from './SubscriptionBanner';
import type { SubscriptionState, LimitUsage, SubscriptionStatus } from '@/services/api';

const DAY_MS = 86_400_000;

function limit(used: number, max: number | null): LimitUsage {
  if (max === null) return { used, limit: null, remaining: null, exceeded: false, percent: null };
  return { used, limit: max, remaining: Math.max(0, max - used), exceeded: used >= max, percent: Math.min(100, Math.round((used / max) * 100)) };
}

function state(overrides: {
  status?: SubscriptionStatus;
  blocked?: boolean;
  graceDays?: number;
  trialDays?: number;
  orders?: LimitUsage;
} = {}): SubscriptionState {
  const now = Date.now();
  return {
    subscription: {
      id: 'sub-1',
      company_id: 'company-1',
      plan_code: 'starter',
      status: overrides.status ?? 'active',
      trial_ends_at: overrides.trialDays !== undefined ? new Date(now + overrides.trialDays * DAY_MS).toISOString() : undefined,
      current_period_start: new Date(now - 5 * DAY_MS).toISOString(),
      current_period_end: new Date(now + 25 * DAY_MS).toISOString(),
    },
    plan: null,
    access: {
      blocked: overrides.blocked ?? false,
      reason: overrides.blocked ? 'Pagamento da subscrição em atraso.' : undefined,
      grace_ends_at: overrides.graceDays !== undefined ? new Date(now + overrides.graceDays * DAY_MS).toISOString() : undefined,
    },
    usage: {
      period: '2026-08',
      orders: overrides.orders ?? limit(10, 500),
      users: limit(2, 5),
      warehouses: limit(1, 3),
      drivers: limit(4, null),
    },
    invoices: [],
  };
}

describe('SubscriptionBanner · mensagem', () => {
  it('should stay silent when everything is in order', () => {
    expect(buildMessage(state())).toBeNull();
  });

  it('should stay silent for a trial that still has plenty of time', () => {
    expect(buildMessage(state({ status: 'trialing', trialDays: 12 }))).toBeNull();
  });

  it('should warn when the trial is about to end', () => {
    const msg = buildMessage(state({ status: 'trialing', trialDays: 3 }));
    expect(msg).toMatchObject({ tone: 'info', cta: 'Escolher plano' });
    expect(msg!.text).toContain('3 dia(s)');
  });

  it('should announce the remaining grace when payment is late', () => {
    const msg = buildMessage(state({ status: 'past_due', graceDays: 4 }));
    expect(msg).toMatchObject({ tone: 'warning', cta: 'Pagar agora' });
    expect(msg!.text).toContain('4 dia(s)');
  });

  it('should escalate to danger once access is blocked', () => {
    expect(buildMessage(state({ status: 'past_due', blocked: true }))).toMatchObject({ tone: 'danger', cta: 'Resolver' });
  });

  it('should flag a limit that is close to being reached', () => {
    const msg = buildMessage(state({ orders: limit(450, 500) }));
    expect(msg).toMatchObject({ tone: 'warning', cta: 'Ver planos' });
    expect(msg!.text).toContain('90%');
  });

  it('should flag an exhausted limit as danger', () => {
    const msg = buildMessage(state({ orders: limit(500, 500) }));
    expect(msg).toMatchObject({ tone: 'danger' });
    expect(msg!.text).toContain('Limite do plano atingido');
  });

  it('should prefer the payment problem over the usage warning', () => {
    const msg = buildMessage(state({ status: 'past_due', graceDays: 2, orders: limit(490, 500) }));
    expect(msg!.cta).toBe('Pagar agora');
  });
});
