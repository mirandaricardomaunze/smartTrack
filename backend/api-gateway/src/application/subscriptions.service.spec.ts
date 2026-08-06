/**
 * @file subscriptions.service.spec.ts
 * @description Testes unitários do núcleo puro da camada SaaS.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Cobre o que decide dinheiro e bloqueios sem tocar na base de dados:
 * o ciclo de vida (`computeLifecycle`), a tolerância (`evaluateAccess`), os
 * limites (`describeLimit`) e a aritmética de períodos (`addMonths`).
 * Dados via factories do harness.
 */
import { describe, expect, it } from 'vitest';
import { PlanFactory, SubscriptionFactory } from '../../../../tests/harness';

// CommonJS é a fronteira atual do monólito modular.
const {
  computeLifecycle,
  evaluateAccess,
  describeLimit,
  addMonths,
  currentPeriod,
} = require('./subscriptions.service');

const DAY_MS = 86_400_000;

describe('SaaS · ciclo de vida da subscrição', () => {
  it('should not change anything mid-period', () => {
    const { patch, invoice } = computeLifecycle(SubscriptionFactory.build(), PlanFactory.build());
    expect(patch).toEqual({});
    expect(invoice).toBeNull();
  });

  it('should keep a running trial untouched', () => {
    const { patch, invoice } = computeLifecycle(SubscriptionFactory.trialing(7), PlanFactory.build());
    expect(patch).toEqual({});
    expect(invoice).toBeNull();
  });

  it('should open a billable period and issue an invoice when the trial ends', () => {
    const sub = SubscriptionFactory.trialExpired(1);
    const { patch, invoice } = computeLifecycle(sub, PlanFactory.build({ price_cents: 250000 }));

    expect(patch.status).toBe('past_due');
    expect(patch.past_due_since).toBe(sub.trial_ends_at);
    expect(patch.current_period_start).toBe(sub.trial_ends_at);
    expect(invoice).toMatchObject({ period_start: sub.trial_ends_at });
    // Período de um mês a contar do fim da avaliação.
    expect(invoice!.period_end).toBe(addMonths(sub.trial_ends_at!, 1));
  });

  it('should activate without invoicing when the plan is free', () => {
    const sub = SubscriptionFactory.trialExpired(1);
    const { patch, invoice } = computeLifecycle(sub, PlanFactory.unlimited());

    expect(patch.status).toBe('active');
    expect(patch.past_due_since).toBeNull();
    expect(invoice).toBeNull();
  });

  it('should renew a finished period into a new unpaid one', () => {
    const end = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const sub = SubscriptionFactory.build({ current_period_end: end });
    const { patch, invoice } = computeLifecycle(sub, PlanFactory.build({ price_cents: 950000 }));

    expect(patch.status).toBe('past_due');
    expect(patch.current_period_start).toBe(end);
    expect(invoice).toEqual({ period_start: end, period_end: addMonths(end, 1) });
  });

  it('should count the grace period from the FIRST unpaid period, not the latest', () => {
    const firstMiss = new Date(Date.now() - 40 * DAY_MS).toISOString();
    const sub = SubscriptionFactory.pastDue(40, { current_period_end: new Date(Date.now() - DAY_MS).toISOString(), past_due_since: firstMiss });
    const { patch } = computeLifecycle(sub, PlanFactory.build());

    expect(patch.past_due_since).toBe(firstMiss);
  });

  it('should leave a canceled subscription alone', () => {
    const sub = SubscriptionFactory.build({ status: 'canceled' as never, current_period_end: new Date(Date.now() - DAY_MS).toISOString() });
    expect(computeLifecycle(sub, PlanFactory.build())).toEqual({ patch: {}, invoice: null });
  });
});

describe('SaaS · acesso e tolerância', () => {
  it('should not block an active subscription', () => {
    expect(evaluateAccess(SubscriptionFactory.build())).toEqual({ blocked: false });
  });

  it('should not block during the grace period, but announce its end', () => {
    const sub = SubscriptionFactory.pastDue(2);
    const access = evaluateAccess(sub, new Date(), 7);

    expect(access.blocked).toBe(false);
    expect(Date.parse(access.grace_ends_at)).toBe(Date.parse(sub.past_due_since!) + 7 * DAY_MS);
  });

  it('should block once the grace period is exhausted', () => {
    const access = evaluateAccess(SubscriptionFactory.pastDue(9), new Date(), 7);
    expect(access.blocked).toBe(true);
    expect(access.reason).toMatch(/atraso/i);
  });

  it('should block a canceled subscription', () => {
    const access = evaluateAccess(SubscriptionFactory.build({ status: 'canceled' as never }));
    expect(access.blocked).toBe(true);
    expect(access.reason).toMatch(/cancelada/i);
  });

  it('should never block a company without a subscription (fail-open)', () => {
    expect(evaluateAccess(null)).toEqual({ blocked: false });
  });
});

describe('SaaS · limites', () => {
  it('should treat a null limit as unlimited', () => {
    expect(describeLimit(9999, null)).toEqual({ used: 9999, limit: null, remaining: null, exceeded: false, percent: null });
  });

  it('should report remaining and percentage under the limit', () => {
    expect(describeLimit(3, 4)).toEqual({ used: 3, limit: 4, remaining: 1, exceeded: false, percent: 75 });
  });

  it('should mark exceeded when usage reaches the limit', () => {
    expect(describeLimit(4, 4)).toMatchObject({ exceeded: true, remaining: 0, percent: 100 });
  });
});

describe('SaaS · aritmética de períodos', () => {
  it('should clamp to the last day of a shorter month', () => {
    expect(addMonths('2026-01-31T10:00:00.000Z', 1)).toBe('2026-02-28T10:00:00.000Z');
  });

  it('should roll over the year', () => {
    expect(addMonths('2026-12-15T00:00:00.000Z', 1)).toBe('2027-01-15T00:00:00.000Z');
  });

  it('should format the usage period as YYYY-MM in UTC', () => {
    expect(currentPeriod(new Date('2026-03-09T23:30:00.000Z'))).toBe('2026-03');
  });
});
