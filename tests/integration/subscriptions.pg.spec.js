/**
 * @file subscriptions.pg.spec.js
 * @description Testes de integração da camada SaaS contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Prova, contra a base real (`track`): o catálogo por omissão; o auto-registo
 * abrir a avaliação; a quota mensal contar os pedidos criados e bloquear o
 * excedente; o limite de armazéns do plano; o fim da avaliação emitir fatura e
 * pôr a subscrição por pagar; a tolerância antes do bloqueio; o pagamento por
 * carteira móvel (simulado) e a confirmação manual regularizarem a subscrição;
 * a mudança de plano anular a fatura em aberto; e o isolamento das faturas de
 * subscrição entre empresas. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona a camada SaaS)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { PlanFactory } from '../harness/factories/subscription.factory';
import { CompanyFactory } from '../harness/factories/company.factory';
import { WarehouseFactory } from '../harness/factories/warehouse.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc        = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/subscriptions.service`) : null;
const orders     = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const warehouses = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/warehouses.service`) : null;
const repo       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY_A = 'company-itest-saas-a';
const COMPANY_B = 'company-itest-saas-b';
const PLAN_CODE = 'plan_itest_saas';
const DAY_MS = 86_400_000;

/** Corre um caso de uso como se o pedido viesse de um utilizador da empresa. */
function asCompany(companyId, fn) {
  return tenant.runWithCompany(companyId, fn);
}

/** A factory descreve a ENTIDADE; o caso de uso recebe o DTO plano do formulário. */
function warehouseDto(overrides) {
  const w = WarehouseFactory.build(overrides);
  return { code: w.code, name: w.name, city: w.address.city, capacity: w.capacity };
}

async function cleanup() {
  const companies = [COMPANY_A, COMPANY_B];
  await pool.query('DELETE FROM orders WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM warehouse_movements WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM warehouses WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM subscription_invoices WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM usage_counters WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await pool.query('DELETE FROM plans WHERE code = $1', [PLAN_CODE]);
}

describe.skipIf(!disponivel)('api-gateway · planos e subscrições (SaaS) · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    for (const [id, name] of [[COMPANY_A, 'Empresa ITEST SaaS A'], [COMPANY_B, 'Empresa ITEST SaaS B']]) {
      await repo.CompanyRepository.create(CompanyFactory.build({ id, name, slug: id }));
    }
    // Plano apertado: 3 pedidos/mês, 2 utilizadores, 1 armazém, 250,00 MZN/mês.
    await svc.createPlan(PlanFactory.build({ code: PLAN_CODE, name: 'Plano ITEST', trial_days: 14 }));
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should ship the default plan catalogue', async () => {
    const codes = (await svc.listPlans()).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['free', 'starter', 'pro', 'enterprise']));

    const enterprise = await svc.getPlan('enterprise');
    // Negociado: fora do upgrade self-service e sem limites.
    expect(enterprise.self_serve).toBe(false);
    expect(enterprise.max_orders_per_month).toBeNull();
  });

  it('should open a trial for a newly registered company', async () => {
    const subscription = await svc.startTrial(COMPANY_A, PLAN_CODE);
    expect(subscription.status).toBe('trialing');
    expect(subscription.plan_code).toBe(PLAN_CODE);
    expect(Date.parse(subscription.trial_ends_at)).toBeGreaterThan(Date.now());

    // Idempotente: registar de novo não abre uma segunda subscrição.
    const again = await svc.startTrial(COMPANY_A, 'pro');
    expect(again.id).toBe(subscription.id);
  });

  it('should meter created orders against the monthly quota', async () => {
    const before = await svc.getSubscriptionState(COMPANY_A);
    expect(before.usage.orders.used).toBe(0);
    expect(before.usage.orders.limit).toBe(3);

    await asCompany(COMPANY_A, () => orders.createOrder({
      tracking_code: 'TRK90011BR', client: 'Cliente ITEST', destination: 'Maputo',
    }));

    const after = await svc.getSubscriptionState(COMPANY_A);
    expect(after.usage.orders.used).toBe(1);
    expect(after.usage.orders.remaining).toBe(2);
  });

  it('should refuse a new order once the monthly quota is exhausted', async () => {
    await repo.UsageRepository.increment(COMPANY_A, svc.currentPeriod(), 'orders', 2); // 1 + 2 = 3 (limite)

    await expect(asCompany(COMPANY_A, () => orders.createOrder({
      tracking_code: 'TRK90012BR', client: 'Cliente ITEST', destination: 'Matola',
    }))).rejects.toMatchObject({ name: 'QuotaExceededError', statusCode: 402 });

    // O pedido recusado não entrou na base.
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM orders WHERE company_id = $1', [COMPANY_A]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('should enforce the warehouse limit of the plan', async () => {
    await asCompany(COMPANY_A, () => warehouses.createWarehouse(
      warehouseDto({ code: 'WH-ITEST-SAAS-1', name: 'Armazém ITEST 1' }),
    ));

    await expect(asCompany(COMPANY_A, () => warehouses.createWarehouse(
      warehouseDto({ code: 'WH-ITEST-SAAS-2', name: 'Armazém ITEST 2' }),
    ))).rejects.toMatchObject({ name: 'QuotaExceededError', statusCode: 402 });
  });

  it('should invoice and mark past due when the trial ends', async () => {
    const sub = await repo.SubscriptionRepository.findByCompany(COMPANY_A);
    const trialEnded = new Date(Date.now() - DAY_MS).toISOString();
    await repo.SubscriptionRepository.update(sub.id, { trial_ends_at: trialEnded, current_period_end: trialEnded });

    const state = await svc.getSubscriptionState(COMPANY_A);
    expect(state.subscription.status).toBe('past_due');
    expect(state.invoices).toHaveLength(1);

    const invoice = state.invoices[0];
    expect(invoice.number).toMatch(/^SB\d{4}\/\d{4}$/);
    expect(invoice.total_cents).toBe(250000);
    // IVA 16% extraído do total (o preço do plano já inclui imposto).
    expect(invoice.subtotal_cents + invoice.tax_cents).toBe(invoice.total_cents);
    expect(invoice.status).toBe('issued');
  });

  it('should keep serving during the grace period and block after it', async () => {
    const sub = await repo.SubscriptionRepository.findByCompany(COMPANY_A);

    // Dentro da tolerância: em atraso, mas o serviço continua (a quota é que trava).
    await repo.SubscriptionRepository.update(sub.id, { past_due_since: new Date(Date.now() - DAY_MS).toISOString() });
    await repo.UsageRepository.increment(COMPANY_A, svc.currentPeriod(), 'orders', -2); // volta a haver folga
    await expect(asCompany(COMPANY_A, () => svc.assertQuota())).resolves.toBeUndefined();

    // Passada a tolerância: bloqueio.
    await repo.SubscriptionRepository.update(sub.id, {
      past_due_since: new Date(Date.now() - (svc.GRACE_DAYS + 2) * DAY_MS).toISOString(),
    });
    await expect(asCompany(COMPANY_A, () => svc.assertQuota()))
      .rejects.toMatchObject({ name: 'SubscriptionBlockedError', statusCode: 402 });
  });

  it('should settle the invoice through the mobile wallet checkout', async () => {
    const [invoice] = await svc.listInvoices({ company_id: COMPANY_A, status: 'issued' });

    // Número terminado em 0 → recusado pelo gateway simulado.
    await expect(svc.checkoutInvoice(invoice.id, { method: 'mpesa', msisdn: '840000000' }))
      .rejects.toMatchObject({ name: 'PaymentDeclinedError', statusCode: 402 });

    const result = await svc.checkoutInvoice(invoice.id, { method: 'mpesa', msisdn: '841234567' });
    expect(result.invoice.status).toBe('paid');
    expect(result.transaction_id).toMatch(/^MPESA-/);

    // Fatura paga → subscrição regularizada e escritas desbloqueadas.
    const state = await svc.getSubscriptionState(COMPANY_A);
    expect(state.subscription.status).toBe('active');
    expect(state.access.blocked).toBe(false);
  });

  it('should void the outstanding invoice when the plan changes', async () => {
    await svc.startTrial(COMPANY_B, PLAN_CODE);
    const subB = await repo.SubscriptionRepository.findByCompany(COMPANY_B);
    const trialEnded = new Date(Date.now() - DAY_MS).toISOString();
    await repo.SubscriptionRepository.update(subB.id, { trial_ends_at: trialEnded, current_period_end: trialEnded });
    await svc.getSubscriptionState(COMPANY_B); // dispara a emissão

    const state = await svc.changePlan(COMPANY_B, 'free');
    expect(state.subscription.plan_code).toBe('free');
    expect(state.subscription.status).toBe('active');

    const statuses = (await svc.listInvoices({ company_id: COMPANY_B })).map((i) => i.status);
    expect(statuses).toContain('void');
    expect(statuses).not.toContain('issued');
  });

  it('should refuse a negotiated plan in self-service and accept it from the platform', async () => {
    await expect(svc.changePlan(COMPANY_B, 'enterprise'))
      .rejects.toMatchObject({ name: 'SubscriptionValidationError', statusCode: 400 });

    const state = await svc.assignPlan(COMPANY_B, 'enterprise');
    expect(state.subscription.plan_code).toBe('enterprise');
    expect(state.usage.orders.limit).toBeNull();
  });

  it('should isolate subscription invoices between companies', async () => {
    const seenByA = await asCompany(COMPANY_A, () => svc.listInvoices({}));
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((i) => i.company_id === COMPANY_A)).toBe(true);

    // A empresa B não consegue sequer ler a fatura da A pelo id.
    const invoiceOfA = seenByA[0];
    await expect(asCompany(COMPANY_B, () => svc.getInvoice(invoiceOfA.id)))
      .rejects.toMatchObject({ name: 'SubscriptionInvoiceNotFoundError', statusCode: 404 });
  });

  it('should never enforce quotas without a company in context', async () => {
    // Testes e tarefas de fundo correm sem empresa — nunca são bloqueados.
    await expect(svc.assertQuota()).resolves.toBeUndefined();
    await expect(svc.assertResourceLimit('warehouses')).resolves.toBeUndefined();
  });

  it('should report platform revenue for the SUPERADMIN console', async () => {
    const stats = await svc.getPlatformStats();
    expect(stats.collected_cents).toBeGreaterThanOrEqual(250000);
    expect(stats.mrr_cents).toBeGreaterThanOrEqual(0);
    expect(stats.active).toBeGreaterThanOrEqual(1);

    const rows = await svc.listSubscriptions();
    const rowA = rows.find((r) => r.company_id === COMPANY_A);
    expect(rowA).toMatchObject({ company_name: 'Empresa ITEST SaaS A', plan_code: PLAN_CODE });
  });
});
