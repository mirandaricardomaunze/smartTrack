/**
 * @file subscriptions.router.js
 * @description Router Express dos planos e subscrições (/v1/subscriptions).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Empresa (ADMIN da própria empresa):
 *   GET   /v1/subscriptions/plans                       catálogo de planos
 *   GET   /v1/subscriptions/me                          plano, acesso, uso e faturas
 *   POST  /v1/subscriptions/me/plan                     mudar de plano { plan_code }
 *   POST  /v1/subscriptions/me/cancel                   cancelar a subscrição
 *   POST  /v1/subscriptions/me/invoices/:id/checkout    pagar { method, msisdn }
 *
 * Plataforma (SUPERADMIN):
 *   GET   /v1/subscriptions                             todas as subscrições
 *   GET   /v1/subscriptions/stats                       MRR e cobrança pendente
 *   GET   /v1/subscriptions/invoices                    todas as faturas
 *   POST  /v1/subscriptions/invoices/:id/pay            confirmação manual { reference }
 *   POST  /v1/subscriptions/invoices/:id/void           anular
 *   POST  /v1/subscriptions/plans                       criar plano
 *   PATCH /v1/subscriptions/plans/:code                 editar preço/limites
 *   POST  /v1/subscriptions/:companyId/plan             atribuir plano a uma empresa
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const subscriptions = require('../application/subscriptions.service');
const audit = require('../application/audit.service');

const router = Router();
const SUPER = ['SUPERADMIN'];
const COMPANY_ADMIN = ['ADMIN'];
const COMPANY_READ = ['ADMIN', 'SUPPORT'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    // O 402 (subscrição/quota) leva o motivo estruturado para a UI reagir.
    const body = { error: err.message };
    if (err.statusCode === 402) body.code = err.name;
    if (err.retryable !== undefined) body.retryable = err.retryable;
    return res.status(err.statusCode).json(body);
  }
  console.error('[subscriptions.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** A empresa do token — as rotas /me exigem um utilizador de empresa. */
function companyOf(req, res) {
  const companyId = req.user?.company_id;
  if (!companyId) {
    res.status(400).json({ error: 'Esta operação exige um utilizador de empresa (o SUPERADMIN gere as empresas em /v1/subscriptions).' });
    return null;
  }
  return companyId;
}

router.use(requireAuth);

// ─── Catálogo ────────────────────────────────────────────────────────────────

router.get('/plans', async (req, res) => {
  try {
    res.json(await subscriptions.listPlans({ includeInactive: req.user.role === 'SUPERADMIN' && req.query.all === 'true' }));
  } catch (err) { handleError(err, res); }
});

router.post('/plans', requireRoles(SUPER), async (req, res) => {
  try { res.status(201).json(await subscriptions.createPlan(req.body)); }
  catch (err) { handleError(err, res); }
});

router.patch('/plans/:code', requireRoles(SUPER), async (req, res) => {
  try { res.json(await subscriptions.updatePlan(req.params.code, req.body)); }
  catch (err) { handleError(err, res); }
});

// ─── Subscrição da empresa ───────────────────────────────────────────────────

router.get('/me', requireRoles(COMPANY_READ), async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) return undefined;
    return res.json(await subscriptions.getSubscriptionState(companyId));
  } catch (err) { return handleError(err, res); }
});

router.post('/me/plan', requireRoles(COMPANY_ADMIN), async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) return undefined;
    const state = await subscriptions.changePlan(companyId, req.body?.plan_code);
    await audit.recordFromRequest(req, {
      action: 'subscriptions.change_plan',
      summary: `${req.user?.email ?? 'sistema'} mudou a subscrição para o plano ${state.plan?.name ?? state.subscription.plan_code}`,
      entity_type: 'subscription', entity_id: state.subscription.id, entity_label: state.plan?.name,
      metadata: { plan_code: state.subscription.plan_code, status: state.subscription.status },
    });
    return res.json(state);
  } catch (err) { return handleError(err, res); }
});

router.post('/me/cancel', requireRoles(COMPANY_ADMIN), async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) return undefined;
    return res.json(await subscriptions.cancelSubscription(companyId));
  } catch (err) { return handleError(err, res); }
});

router.post('/me/invoices/:id/checkout', requireRoles(COMPANY_ADMIN), async (req, res) => {
  try {
    res.json(await subscriptions.checkoutInvoice(req.params.id, {
      method: req.body?.method,
      msisdn: req.body?.msisdn,
    }));
  } catch (err) { handleError(err, res); }
});

// ─── Plataforma ──────────────────────────────────────────────────────────────

router.get('/stats', requireRoles(SUPER), async (_req, res) => {
  try { res.json(await subscriptions.getPlatformStats()); }
  catch (err) { handleError(err, res); }
});

router.get('/invoices', requireRoles(SUPER), async (req, res) => {
  try {
    res.json(await subscriptions.listInvoices({
      status: req.query.status, company_id: req.query.company_id, limit: req.query.limit,
    }));
  } catch (err) { handleError(err, res); }
});

router.post('/invoices/:id/pay', requireRoles(SUPER), async (req, res) => {
  try {
    const invoice = await subscriptions.markInvoicePaid(req.params.id, {
      payment_method: req.body?.payment_method,
      reference: req.body?.reference,
    });
    // Confirmação manual: alguém declarou que o dinheiro entrou.
    await audit.recordFromRequest(req, {
      action: 'subscriptions.manual_payment',
      company_id: invoice.company_id,
      summary: `${req.user?.email ?? 'plataforma'} confirmou o pagamento manual de ${invoice.number}`,
      entity_type: 'subscription_invoice', entity_id: invoice.id, entity_label: invoice.number,
      metadata: { reference: invoice.payment_ref, total_cents: invoice.total_cents },
    });
    res.json(invoice);
  } catch (err) { handleError(err, res); }
});

router.post('/invoices/:id/void', requireRoles(SUPER), async (req, res) => {
  try { res.json(await subscriptions.voidInvoice(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.get('/', requireRoles(SUPER), async (_req, res) => {
  try { res.json(await subscriptions.listSubscriptions()); }
  catch (err) { handleError(err, res); }
});

router.post('/:companyId/plan', requireRoles(SUPER), async (req, res) => {
  try { res.json(await subscriptions.assignPlan(req.params.companyId, req.body?.plan_code)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
