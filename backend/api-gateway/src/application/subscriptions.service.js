/**
 * @file subscriptions.service.js
 * @description Camada de aplicação — planos, subscrições, quotas e faturação SaaS.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Este é o módulo que transforma o produto em SaaS: a PLATAFORMA cobra as
 * EMPRESAS. Não confundir com `invoices.service` (§ 3.14), onde a empresa cobra
 * os seus clientes pelo frete.
 *
 * Decisões:
 *   - **Ciclo preguiçoso, sem agendador.** As transições (fim da avaliação,
 *     renovação do período, emissão da fatura) são calculadas na primeira leitura
 *     após a data. `computeLifecycle` é pura e testável; `loadState` aplica-a.
 *   - **Período de tolerância.** `past_due` não corta o serviço de imediato:
 *     `SAAS_PAST_DUE_GRACE_DAYS` (7 por omissão) antes de bloquear as escritas.
 *   - **Falha aberta.** Empresa sem subscrição (dados legados) ou plano sem
 *     limites nunca é bloqueada — o negócio do cliente não pára por uma linha
 *     em falta na faturação.
 *   - **Sem contexto de empresa, sem imposição.** Testes, tarefas de fundo e o
 *     SUPERADMIN correm sem `company_id` no contexto (spec § 2.4) e não têm quota.
 *   - **Sem proração.** Mudar de plano fecha a fatura em aberto do ciclo e abre
 *     um período novo ao preço novo.
 *   - Preços em centavos (MZN), IVA 16% **incluído** no preço do plano — a base
 *     tributável é extraída com o mesmo `splitTaxInclusive` da faturação interna.
 */
'use strict';

const crypto = require('crypto');
const {
  PlanRepository,
  SubscriptionRepository,
  UsageRepository,
  SubscriptionInvoiceRepository,
  CompanyRepository,
} = require('../infrastructure/pg.repository');
const { readCompanyId } = require('../infrastructure/tenant-context');
const { getBillingGateway, isValidMsisdn, normalizeMsisdn, BillingMethod } = require('../infrastructure/billing.gateway');
const { splitTaxInclusive, TAX_RATE_PCT } = require('./invoices.service');
const { signDocument } = require('./fiscal');

const SubscriptionStatus = Object.freeze({
  TRIALING: 'trialing',
  ACTIVE:   'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
});

const InvoiceStatus = Object.freeze({ ISSUED: 'issued', PAID: 'paid', VOID: 'void' });

/** Métrica medida por período (hoje só pedidos criados). */
const UsageMetric = Object.freeze({ ORDERS: 'orders' });

/** Plano atribuído no auto-registo de uma empresa nova. */
const DEFAULT_PLAN_CODE = process.env.SAAS_DEFAULT_PLAN || 'starter';
/** Dias de tolerância depois de a fatura ficar por pagar. */
const GRACE_DAYS = Number(process.env.SAAS_PAST_DUE_GRACE_DAYS) || 7;
/** Travão do avanço de períodos em atraso (empresa dormente há muito tempo). */
const MAX_ROLLOVER_STEPS = 12;

const DAY_MS = 86_400_000;

// ─── Erros ───────────────────────────────────────────────────────────────────

class SubscriptionValidationError extends Error {
  constructor(message) { super(message); this.name = 'SubscriptionValidationError'; this.statusCode = 400; }
}
class PlanNotFoundError extends Error {
  constructor(code) { super(`Plano não encontrado: ${code}`); this.name = 'PlanNotFoundError'; this.statusCode = 404; }
}
class SubscriptionNotFoundError extends Error {
  constructor(companyId) { super(`Subscrição não encontrada para a empresa: ${companyId}`); this.name = 'SubscriptionNotFoundError'; this.statusCode = 404; }
}
class SubscriptionInvoiceNotFoundError extends Error {
  constructor(id) { super(`Fatura de subscrição não encontrada: ${id}`); this.name = 'SubscriptionInvoiceNotFoundError'; this.statusCode = 404; }
}
/** 402: o serviço está suspenso por falta de pagamento/cancelamento. */
class SubscriptionBlockedError extends Error {
  constructor(message) { super(message); this.name = 'SubscriptionBlockedError'; this.statusCode = 402; }
}
/** 402: o plano atingiu o limite contratado. */
class QuotaExceededError extends Error {
  constructor(message) { super(message); this.name = 'QuotaExceededError'; this.statusCode = 402; }
}
/** 402: o gateway recusou a cobrança. */
class PaymentDeclinedError extends Error {
  constructor(message, retryable = false) {
    super(message); this.name = 'PaymentDeclinedError'; this.statusCode = 402; this.retryable = retryable;
  }
}

// ─── Núcleo puro (testável sem base de dados) ────────────────────────────────

/** Período de medição de uma data — 'YYYY-MM' em UTC. */
function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Soma meses a uma data ISO preservando a hora (31/01 + 1 mês = 28/02).
 * @param {string} iso
 * @param {number} months
 * @returns {string} ISO8601 UTC
 */
function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + months, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  ));
  const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTarget));
  return target.toISOString();
}

/**
 * Um passo do ciclo de vida da subscrição. PURA — não toca na base.
 *
 * Devolve o patch a gravar e, quando há período novo a cobrar, o período da
 * fatura a emitir. Sem alterações a fazer, devolve patch vazio e `invoice` null.
 *
 * @param {object} sub  Subscrição atual
 * @param {object} plan Plano atual
 * @param {Date} [now]
 * @returns {{ patch: object, invoice: { period_start: string, period_end: string } | null }}
 */
function computeLifecycle(sub, plan, now = new Date()) {
  const t = now.getTime();
  const none = { patch: {}, invoice: null };

  if (!sub || !plan) return none;
  if (sub.status === SubscriptionStatus.CANCELED) return none;

  // Fim da avaliação → começa o primeiro período faturado.
  if (sub.status === SubscriptionStatus.TRIALING) {
    if (!sub.trial_ends_at || t < Date.parse(sub.trial_ends_at)) return none;
    return openPeriod(sub, plan, sub.trial_ends_at);
  }

  // Renovação: só quando o período em curso terminou.
  if (t < Date.parse(sub.current_period_end)) return none;
  return openPeriod(sub, plan, sub.current_period_end);
}

/** Abre o período que começa em `startIso` e decide se há fatura. */
function openPeriod(sub, plan, startIso) {
  const start = new Date(startIso).toISOString();
  const end = addMonths(start, 1);

  // Plano sem custo (grátis ou contrato negociado): renova sem faturar.
  if (plan.price_cents <= 0) {
    return {
      patch: {
        status: SubscriptionStatus.ACTIVE,
        current_period_start: start,
        current_period_end: end,
        past_due_since: null,
      },
      invoice: null,
    };
  }

  return {
    patch: {
      status: SubscriptionStatus.PAST_DUE,
      // A tolerância conta desde o PRIMEIRO atraso, não desde o mais recente.
      past_due_since: sub.past_due_since ?? start,
      current_period_start: start,
      current_period_end: end,
    },
    invoice: { period_start: start, period_end: end },
  };
}

/**
 * A empresa pode escrever? PURA.
 * @param {object|null} sub
 * @param {Date} [now]
 * @param {number} [graceDays]
 * @returns {{ blocked: boolean, reason?: string, grace_ends_at?: string }}
 */
function evaluateAccess(sub, now = new Date(), graceDays = GRACE_DAYS) {
  if (!sub) return { blocked: false };

  if (sub.status === SubscriptionStatus.CANCELED) {
    return { blocked: true, reason: 'A subscrição está cancelada. Escolha um plano em Plano & Uso para retomar o serviço.' };
  }

  if (sub.status === SubscriptionStatus.PAST_DUE) {
    const since = sub.past_due_since ? Date.parse(sub.past_due_since) : now.getTime();
    const graceEndsAt = new Date(since + graceDays * DAY_MS).toISOString();
    if (now.getTime() > since + graceDays * DAY_MS) {
      return { blocked: true, reason: 'Pagamento da subscrição em atraso. Regularize a fatura em Plano & Uso para continuar.', grace_ends_at: graceEndsAt };
    }
    return { blocked: false, grace_ends_at: graceEndsAt };
  }

  return { blocked: false };
}

/**
 * Estado de um limite. PURA. `limit` null = ilimitado.
 * @returns {{ used: number, limit: number|null, remaining: number|null, exceeded: boolean, percent: number|null }}
 */
function describeLimit(used, limit) {
  const u = Math.max(0, Number(used) || 0);
  if (limit === null || limit === undefined) {
    return { used: u, limit: null, remaining: null, exceeded: false, percent: null };
  }
  const l = Math.max(0, Number(limit));
  return {
    used: u,
    limit: l,
    remaining: Math.max(0, l - u),
    exceeded: u >= l,
    percent: l === 0 ? 100 : Math.min(100, Math.round((u / l) * 100)),
  };
}

// ─── Estado (leitura + transições preguiçosas) ───────────────────────────────

/**
 * Carrega a subscrição da empresa aplicando as transições em atraso.
 * Devolve null quando a empresa não tem subscrição (falha aberta).
 *
 * @param {string} companyId
 * @returns {Promise<{ subscription: object, plan: object|null } | null>}
 */
async function loadState(companyId) {
  let subscription = await SubscriptionRepository.findByCompany(companyId);
  if (!subscription) return null;

  const plan = await PlanRepository.findByCode(subscription.plan_code);
  if (!plan) return { subscription, plan: null };

  for (let step = 0; step < MAX_ROLLOVER_STEPS; step += 1) {
    const { patch, invoice } = computeLifecycle(subscription, plan);
    if (!invoice && Object.keys(patch).length === 0) break;

    // A fatura primeiro: se falhar, o período não avança e tenta-se de novo.
    if (invoice) await issueInvoice(subscription.company_id, plan, invoice);
    subscription = (await SubscriptionRepository.update(subscription.id, patch)) ?? subscription;
  }

  return { subscription, plan };
}

/** Emite (idempotente por período) a fatura da subscrição. */
async function issueInvoice(companyId, plan, period) {
  const company = await CompanyRepository.findById(companyId);
  const tax = splitTaxInclusive(plan.price_cents, TAX_RATE_PCT);

  // Assinada e encadeada como qualquer documento fiscal (spec § 3.19).
  return SubscriptionInvoiceRepository.createWithNumber({
    id:             crypto.randomUUID(),
    company_id:     companyId,
    company_name:   company?.name ?? companyId,
    plan_code:      plan.code,
    plan_name:      plan.name,
    period_start:   period.period_start,
    period_end:     period.period_end,
    subtotal_cents: tax.subtotal_cents,
    tax_rate_pct:   tax.tax_rate_pct,
    tax_cents:      tax.tax_cents,
    total_cents:    tax.total_cents,
  }, signDocument);
}

// ─── Quotas e limites (chamados pelos casos de uso do produto) ───────────────

/**
 * Barra a operação quando a subscrição está bloqueada ou a quota do mês esgotou.
 * Não faz nada sem empresa no contexto (testes/fundo/SUPERADMIN) nem sem plano.
 *
 * @param {string} [metric]
 */
async function assertQuota(metric = UsageMetric.ORDERS) {
  const companyId = readCompanyId();
  if (!companyId) return;

  const state = await loadState(companyId);
  if (!state || !state.plan) return;

  const access = evaluateAccess(state.subscription);
  if (access.blocked) throw new SubscriptionBlockedError(access.reason);

  const limit = state.plan.max_orders_per_month;
  if (limit === null || limit === undefined) return;

  const used = await UsageRepository.get(companyId, currentPeriod(), metric);
  if (used >= limit) {
    throw new QuotaExceededError(
      `Limite do plano ${state.plan.name} atingido: ${limit} pedidos por mês (${used} usados). Mude de plano em Plano & Uso.`,
    );
  }
}

/** Regista o consumo de uma unidade da métrica no período corrente. */
async function consumeQuota(metric = UsageMetric.ORDERS, by = 1) {
  const companyId = readCompanyId();
  if (!companyId) return;
  await UsageRepository.increment(companyId, currentPeriod(), metric, by);
}

const RESOURCE_LABEL = { users: 'utilizadores', warehouses: 'armazéns' };

/**
 * Barra a criação de um recurso contável (utilizadores, armazéns) acima do plano.
 * @param {'users'|'warehouses'} resource
 */
async function assertResourceLimit(resource) {
  const companyId = readCompanyId();
  if (!companyId) return;

  const state = await loadState(companyId);
  if (!state || !state.plan) return;

  const access = evaluateAccess(state.subscription);
  if (access.blocked) throw new SubscriptionBlockedError(access.reason);

  const limit = resource === 'users' ? state.plan.max_users : state.plan.max_warehouses;
  if (limit === null || limit === undefined) return;

  const counts = await SubscriptionRepository.countResources(companyId);
  if ((counts[resource] ?? 0) >= limit) {
    throw new QuotaExceededError(
      `Limite do plano ${state.plan.name} atingido: ${limit} ${RESOURCE_LABEL[resource]}. Mude de plano em Plano & Uso.`,
    );
  }
}

// ─── Catálogo de planos ──────────────────────────────────────────────────────

/** Catálogo. Por omissão só os planos ativos e self-service. */
async function listPlans(opts = {}) {
  const plans = await PlanRepository.list({ activeOnly: !opts.includeInactive });
  return opts.includeNegotiated === false ? plans.filter((p) => p.self_serve) : plans;
}

async function getPlan(code) {
  const plan = await PlanRepository.findByCode(code);
  if (!plan) throw new PlanNotFoundError(code);
  return plan;
}

/** Cria um plano (SUPERADMIN). */
async function createPlan(dto = {}) {
  const code = String(dto.code || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(code)) throw new SubscriptionValidationError('Código do plano inválido (a-z, 0-9, - e _).');
  if (!String(dto.name || '').trim()) throw new SubscriptionValidationError('O nome do plano é obrigatório.');
  if (await PlanRepository.findByCode(code)) throw new SubscriptionValidationError(`Já existe um plano com o código ${code}.`);

  return PlanRepository.create({
    code,
    name: String(dto.name).trim(),
    description: dto.description ? String(dto.description).trim() : null,
    price_cents: normalizeCents(dto.price_cents),
    trial_days: normalizeCount(dto.trial_days) ?? 14,
    max_orders_per_month: normalizeCount(dto.max_orders_per_month),
    max_users: normalizeCount(dto.max_users),
    max_warehouses: normalizeCount(dto.max_warehouses),
    features: typeof dto.features === 'object' && dto.features ? dto.features : {},
    self_serve: dto.self_serve !== false,
    active: dto.active !== false,
    sort_order: normalizeCount(dto.sort_order) ?? 0,
  });
}

/** Atualiza preço/limites de um plano (SUPERADMIN). */
async function updatePlan(code, patch = {}) {
  await getPlan(code);
  const clean = {};
  if (patch.name !== undefined) clean.name = String(patch.name).trim();
  if (patch.description !== undefined) clean.description = patch.description ? String(patch.description).trim() : null;
  if (patch.price_cents !== undefined) clean.price_cents = normalizeCents(patch.price_cents);
  if (patch.trial_days !== undefined) clean.trial_days = normalizeCount(patch.trial_days) ?? 0;
  if (patch.max_orders_per_month !== undefined) clean.max_orders_per_month = normalizeCount(patch.max_orders_per_month);
  if (patch.max_users !== undefined) clean.max_users = normalizeCount(patch.max_users);
  if (patch.max_warehouses !== undefined) clean.max_warehouses = normalizeCount(patch.max_warehouses);
  if (patch.features !== undefined) clean.features = typeof patch.features === 'object' && patch.features ? patch.features : {};
  if (patch.self_serve !== undefined) clean.self_serve = Boolean(patch.self_serve);
  if (patch.active !== undefined) clean.active = Boolean(patch.active);
  if (patch.sort_order !== undefined) clean.sort_order = normalizeCount(patch.sort_order) ?? 0;
  return PlanRepository.update(code, clean);
}

function normalizeCents(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** null = ilimitado; valores inválidos → null. */
function normalizeCount(value) {
  if (value === null || value === '' || value === undefined) return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── Ciclo de vida da subscrição ─────────────────────────────────────────────

/**
 * Abre a subscrição de uma empresa nova (chamado no auto-registo SaaS).
 * Idempotente: se já existir, devolve a existente.
 *
 * @param {string} companyId
 * @param {string} [planCode]
 */
async function startTrial(companyId, planCode = DEFAULT_PLAN_CODE) {
  const existing = await SubscriptionRepository.findByCompany(companyId);
  if (existing) return existing;

  const plan = (await PlanRepository.findByCode(planCode)) || (await PlanRepository.findByCode('free'));
  if (!plan) throw new PlanNotFoundError(planCode);

  const nowIso = new Date().toISOString();
  const trialing = plan.trial_days > 0;
  const trialEndsAt = trialing ? new Date(Date.now() + plan.trial_days * DAY_MS).toISOString() : null;

  const subscription = await SubscriptionRepository.create({
    id: `sub-${crypto.randomUUID()}`,
    company_id: companyId,
    plan_code: plan.code,
    status: trialing ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE,
    trial_ends_at: trialEndsAt,
    current_period_start: nowIso,
    current_period_end: trialEndsAt ?? addMonths(nowIso, 1),
  });

  // Plano pago sem avaliação: o primeiro período já nasce por cobrar.
  if (!trialing && plan.price_cents > 0) {
    return applyPaidPeriod(subscription, plan, nowIso);
  }
  return subscription;
}

/** Abre um período pago agora (fatura + past_due) e devolve a subscrição. */
async function applyPaidPeriod(subscription, plan, startIso) {
  const period = { period_start: startIso, period_end: addMonths(startIso, 1) };
  await issueInvoice(subscription.company_id, plan, period);
  return (await SubscriptionRepository.update(subscription.id, {
    status: SubscriptionStatus.PAST_DUE,
    past_due_since: startIso,
    current_period_start: period.period_start,
    current_period_end: period.period_end,
    canceled_at: null,
  })) ?? subscription;
}

/**
 * Estado completo para o painel da empresa: plano, acesso, uso e faturas.
 * @param {string} companyId
 */
async function getSubscriptionState(companyId) {
  if (!companyId) throw new SubscriptionValidationError('Sem empresa no contexto — inicie sessão como utilizador de uma empresa.');

  const state = await loadState(companyId);
  if (!state) throw new SubscriptionNotFoundError(companyId);

  const { subscription, plan } = state;
  const counts = await SubscriptionRepository.countResources(companyId);
  const period = currentPeriod();
  const orders = await UsageRepository.get(companyId, period, UsageMetric.ORDERS);

  return {
    subscription,
    plan,
    access: evaluateAccess(subscription),
    usage: {
      period,
      orders:     describeLimit(orders, plan ? plan.max_orders_per_month : null),
      users:      describeLimit(counts.users, plan ? plan.max_users : null),
      warehouses: describeLimit(counts.warehouses, plan ? plan.max_warehouses : null),
      drivers:    describeLimit(counts.drivers, null),
    },
    invoices: await SubscriptionInvoiceRepository.list({ company_id: companyId, limit: 12 }),
  };
}

/**
 * Muda de plano (upgrade/downgrade/reativação). Sem proração: a fatura em aberto
 * do ciclo atual é anulada e abre-se um período novo ao preço novo.
 *
 * @param {string} companyId
 * @param {string} planCode
 * @param {{ allowNegotiated?: boolean }} [opts] SUPERADMIN pode atribuir planos negociados
 */
async function changePlan(companyId, planCode, opts = {}) {
  if (!companyId) throw new SubscriptionValidationError('Sem empresa no contexto.');
  const plan = await getPlan(String(planCode || '').trim().toLowerCase());
  if (!plan.active) throw new SubscriptionValidationError(`O plano ${plan.name} não está disponível.`);
  if (!plan.self_serve && !opts.allowNegotiated) {
    throw new SubscriptionValidationError(`O plano ${plan.name} é por contrato — fale com a equipa comercial.`);
  }

  let subscription = await SubscriptionRepository.findByCompany(companyId);
  if (!subscription) {
    await startTrial(companyId, plan.code);
    subscription = await SubscriptionRepository.findByCompany(companyId);
  }
  if (subscription.plan_code === plan.code && subscription.status !== SubscriptionStatus.CANCELED) {
    return getSubscriptionState(companyId);
  }

  const nowIso = new Date().toISOString();
  const inTrial = subscription.status === SubscriptionStatus.TRIALING
    && subscription.trial_ends_at
    && Date.now() < Date.parse(subscription.trial_ends_at);

  if (inTrial) {
    // Mudar de plano durante a avaliação não cobra nada: a avaliação mantém-se.
    await SubscriptionRepository.update(subscription.id, { plan_code: plan.code });
    return getSubscriptionState(companyId);
  }

  // O ciclo atual deixa de valer ao preço antigo.
  await SubscriptionInvoiceRepository.voidOutstandingFrom(companyId, subscription.current_period_start);

  if (plan.price_cents <= 0) {
    await SubscriptionRepository.update(subscription.id, {
      plan_code: plan.code,
      status: SubscriptionStatus.ACTIVE,
      current_period_start: nowIso,
      current_period_end: addMonths(nowIso, 1),
      past_due_since: null,
      canceled_at: null,
    });
    return getSubscriptionState(companyId);
  }

  await SubscriptionRepository.update(subscription.id, { plan_code: plan.code, past_due_since: null });
  await applyPaidPeriod({ ...subscription, plan_code: plan.code }, plan, nowIso);
  return getSubscriptionState(companyId);
}

/** Cancela a subscrição. As faturas em aberto continuam devidas. */
async function cancelSubscription(companyId) {
  const subscription = await SubscriptionRepository.findByCompany(companyId);
  if (!subscription) throw new SubscriptionNotFoundError(companyId);
  if (subscription.status === SubscriptionStatus.CANCELED) return getSubscriptionState(companyId);

  await SubscriptionRepository.update(subscription.id, {
    status: SubscriptionStatus.CANCELED,
    canceled_at: new Date().toISOString(),
  });
  return getSubscriptionState(companyId);
}

// ─── Faturas da subscrição ───────────────────────────────────────────────────

/** Lista faturas: da empresa em contexto, ou todas (SUPERADMIN). */
async function listInvoices(opts = {}) {
  return SubscriptionInvoiceRepository.list({
    status: opts.status && Object.values(InvoiceStatus).includes(opts.status) ? opts.status : undefined,
    company_id: opts.company_id,
    limit: opts.limit,
  });
}

async function getInvoice(id) {
  const invoice = await SubscriptionInvoiceRepository.findById(id);
  if (!invoice) throw new SubscriptionInvoiceNotFoundError(id);
  return invoice;
}

/**
 * Cobra a fatura por carteira móvel (M-Pesa/eMola) — hoje via gateway simulado.
 * A chave de idempotência é derivada da fatura: repetir não cobra duas vezes.
 *
 * @param {string} id
 * @param {{ method?: string, msisdn?: string }} dto
 */
async function checkoutInvoice(id, dto = {}) {
  const invoice = await getInvoice(id);
  if (invoice.status === InvoiceStatus.PAID) return { invoice, transaction_id: invoice.payment_ref, message: 'Esta fatura já está paga.' };
  if (invoice.status === InvoiceStatus.VOID) throw new SubscriptionValidationError('Não é possível pagar uma fatura anulada.');

  const method = String(dto.method || '').trim().toLowerCase();
  if (![BillingMethod.MPESA, BillingMethod.EMOLA].includes(method)) {
    throw new SubscriptionValidationError('Método de pagamento inválido. Use "mpesa" ou "emola".');
  }
  if (!isValidMsisdn(dto.msisdn)) {
    throw new SubscriptionValidationError('Número de telemóvel inválido. Use um número moçambicano (ex.: 84xxxxxxx).');
  }

  const gateway = getBillingGateway(method);
  const result = await gateway.charge({
    idempotencyKey: `subinv-${invoice.id}`,
    method,
    msisdn: normalizeMsisdn(dto.msisdn),
    amountCents: invoice.total_cents,
    reference: invoice.number,
  });

  if (!result.approved) throw new PaymentDeclinedError(result.message, result.retryable);

  const paid = await settleInvoice(invoice, method, result.transactionId);
  return { invoice: paid, transaction_id: result.transactionId, message: result.message };
}

/**
 * Confirmação manual (transferência/depósito validado pelo SUPERADMIN).
 * @param {string} id
 * @param {{ payment_method?: string, reference?: string }} dto
 */
async function markInvoicePaid(id, dto = {}) {
  const invoice = await getInvoice(id);
  if (invoice.status === InvoiceStatus.PAID) return invoice;
  if (invoice.status === InvoiceStatus.VOID) throw new SubscriptionValidationError('Não é possível pagar uma fatura anulada.');

  const method = String(dto.payment_method || BillingMethod.MANUAL).trim().toLowerCase();
  const reference = dto.reference ? String(dto.reference).trim().slice(0, 120) : null;
  return settleInvoice(invoice, method, reference);
}

/** Anula uma fatura de subscrição (SUPERADMIN). */
async function voidInvoice(id) {
  const invoice = await getInvoice(id);
  if (invoice.status === InvoiceStatus.PAID) throw new SubscriptionValidationError('Não é possível anular uma fatura já paga.');
  if (invoice.status === InvoiceStatus.VOID) return invoice;
  return SubscriptionInvoiceRepository.update(id, { status: InvoiceStatus.VOID, voided_at: new Date().toISOString() });
}

/** Marca a fatura paga e devolve a subscrição ao estado ativo. */
async function settleInvoice(invoice, method, reference) {
  const paid = await SubscriptionInvoiceRepository.update(invoice.id, {
    status: InvoiceStatus.PAID,
    payment_method: method,
    payment_ref: reference,
    paid_at: new Date().toISOString(),
  });

  const subscription = await SubscriptionRepository.findByCompany(invoice.company_id);
  if (subscription && subscription.status === SubscriptionStatus.PAST_DUE) {
    // Só regulariza quando não sobra nenhuma fatura por pagar da empresa.
    const outstanding = await SubscriptionInvoiceRepository.list({
      company_id: invoice.company_id, status: InvoiceStatus.ISSUED, limit: 1,
    });
    if (outstanding.length === 0) {
      await SubscriptionRepository.update(subscription.id, {
        status: SubscriptionStatus.ACTIVE,
        past_due_since: null,
      });
    }
  }

  return paid ?? invoice;
}

// ─── Consola da plataforma (SUPERADMIN) ──────────────────────────────────────

/** Todas as subscrições com empresa e plano. */
async function listSubscriptions() {
  return SubscriptionRepository.listWithDetails();
}

/** Receita recorrente e cobrança pendente. */
async function getPlatformStats() {
  return SubscriptionInvoiceRepository.getPlatformStats();
}

/** Atribui um plano a uma empresa (inclui os negociados). */
async function assignPlan(companyId, planCode) {
  const company = await CompanyRepository.findById(companyId);
  if (!company) throw new SubscriptionValidationError(`Empresa não encontrada: ${companyId}`);
  return changePlan(companyId, planCode, { allowNegotiated: true });
}

module.exports = {
  // Puros (testados sem base de dados)
  currentPeriod,
  addMonths,
  computeLifecycle,
  evaluateAccess,
  describeLimit,
  // Quotas
  assertQuota,
  consumeQuota,
  assertResourceLimit,
  // Planos
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  // Subscrições
  startTrial,
  getSubscriptionState,
  changePlan,
  cancelSubscription,
  // Faturas
  listInvoices,
  getInvoice,
  checkoutInvoice,
  markInvoicePaid,
  voidInvoice,
  // Plataforma
  listSubscriptions,
  getPlatformStats,
  assignPlan,
  // Constantes e erros
  SubscriptionStatus,
  UsageMetric,
  DEFAULT_PLAN_CODE,
  GRACE_DAYS,
  SubscriptionValidationError,
  PlanNotFoundError,
  SubscriptionNotFoundError,
  SubscriptionInvoiceNotFoundError,
  SubscriptionBlockedError,
  QuotaExceededError,
  PaymentDeclinedError,
};
