/**
 * @file invoices.router.js
 * @description Router Express da faturação e das obrigações fiscais (/v1/invoices).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14 (Faturação)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Documentos (RBAC ADMIN/SUPPORT):
 *   GET   /v1/invoices                 lista (status, doc_type, search, page, pageSize)
 *   GET   /v1/invoices/stats           resumo
 *   GET   /v1/invoices/:id             detalhe + emissor + software
 *   POST  /v1/invoices                 emitir a partir de pedido { order_id, notes, series }
 *   POST  /v1/invoices/:id/pay         marcar paga { payment_method }
 *   POST  /v1/invoices/:id/void        anular { reason }  (só antes de paga)
 *   POST  /v1/invoices/:id/credit-note nota de crédito { reason, amount_cents }
 *
 * Obrigações fiscais (ADMIN):
 *   GET   /v1/invoices/tax-report      mapa de IVA do período (period=AAAA-MM | from&to)
 *   GET   /v1/invoices/saft            ficheiro de auditoria SAF-T (XML)
 *   GET   /v1/invoices/integrity       verificação da assinatura e da sequência
 *   GET   /v1/invoices/series          séries de numeração do ano
 *   POST  /v1/invoices/series          criar série { doc_type, series, year }
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const invoices = require('../application/invoices.service');
const audit = require('../application/audit.service');

const router = Router();
const ROLES = ['ADMIN', 'SUPPORT'];
/** As obrigações fiscais são do responsável da empresa, não do suporte. */
const FISCAL_ROLES = ['ADMIN'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[invoices.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(ROLES));

// ─── Obrigações fiscais (antes de /:id para não colidir) ─────────────────────

router.get('/tax-report', requireRoles(FISCAL_ROLES), async (req, res) => {
  try {
    res.json(await invoices.getTaxReport({ period: req.query.period, from: req.query.from, to: req.query.to }));
  } catch (err) { handleError(err, res); }
});

router.get('/saft', requireRoles(FISCAL_ROLES), async (req, res) => {
  try {
    const result = await invoices.exportSaft({ period: req.query.period, from: req.query.from, to: req.query.to });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Document-Count', String(result.documents));
    res.send(result.xml);
  } catch (err) { handleError(err, res); }
});

router.get('/integrity', requireRoles(FISCAL_ROLES), async (_req, res) => {
  try { res.json(await invoices.verifyIntegrity()); }
  catch (err) { handleError(err, res); }
});

router.get('/series', requireRoles(FISCAL_ROLES), async (req, res) => {
  try { res.json(await invoices.listSeries(req.query.year)); }
  catch (err) { handleError(err, res); }
});

router.post('/series', requireRoles(FISCAL_ROLES), async (req, res) => {
  try { res.status(201).json(await invoices.createSeries(req.body)); }
  catch (err) { handleError(err, res); }
});

// ─── Documentos ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    res.json(await invoices.listInvoices({
      status: req.query.status, doc_type: req.query.doc_type, search: req.query.search,
      page: req.query.page, pageSize: req.query.pageSize,
    }));
  } catch (err) { handleError(err, res); }
});

router.get('/stats', async (_req, res) => {
  try { res.json(await invoices.getStats()); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await invoices.getInvoice(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/', async (req, res) => {
  try {
    if (!req.body || !req.body.order_id) {
      return res.status(400).json({ error: 'order_id é obrigatório.' });
    }
    return res.status(201).json(await invoices.createInvoiceForOrder(req.body.order_id, {
      notes: req.body.notes, series: req.body.series, issued_by: req.user?.email,
    }));
  } catch (err) { return handleError(err, res); }
});

router.post('/:id/pay', async (req, res) => {
  try { res.json(await invoices.markPaid(req.params.id, { payment_method: req.body?.payment_method })); }
  catch (err) { handleError(err, res); }
});

router.post('/:id/void', async (req, res) => {
  try {
    const voided = await invoices.voidInvoice(req.params.id, { reason: req.body?.reason });
    // Anular um documento fiscal é dos atos mais sensíveis do sistema.
    await audit.recordFromRequest(req, {
      action: 'invoices.void',
      summary: `${req.user?.email ?? 'sistema'} anulou o documento ${voided.number}`,
      entity_type: 'invoice', entity_id: voided.id, entity_label: voided.number,
      metadata: { reason: voided.void_reason, total_cents: voided.total_cents },
    });
    res.json(voided);
  } catch (err) { handleError(err, res); }
});

router.post('/:id/credit-note', requireRoles(FISCAL_ROLES), async (req, res) => {
  try {
    const note = await invoices.createCreditNote(req.params.id, {
      reason: req.body?.reason,
      amount_cents: req.body?.amount_cents,
      issued_by: req.user?.email,
    });
    await audit.recordFromRequest(req, {
      action: 'invoices.credit_note',
      summary: `${req.user?.email ?? 'sistema'} emitiu a nota de crédito ${note.number} sobre ${note.related_number}`,
      entity_type: 'invoice', entity_id: note.id, entity_label: note.number,
      metadata: { rectifies: note.related_number, total_cents: note.total_cents, reason: req.body?.reason },
    });
    res.status(201).json(note);
  } catch (err) { handleError(err, res); }
});

module.exports = router;
