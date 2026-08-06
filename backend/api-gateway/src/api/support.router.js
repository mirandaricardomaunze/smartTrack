/**
 * @file support.router.js
 * @description Router Express do chat de suporte (/v1/support).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9
 *
 * Dois espaços de acesso:
 *   - Cliente (público, sem login): autenticado pelo `access_token` da conversa.
 *       POST /v1/support/threads               abrir conversa (rate-limited)
 *       GET  /v1/support/threads/:id?token=…    ver conversa
 *       POST /v1/support/threads/:id/reply      responder (token no corpo)
 *   - Agente (JWT + RBAC ADMIN/SUPPORT):
 *       GET   /v1/support/agent/threads[?status=]   fila de conversas
 *       GET   /v1/support/agent/threads/:id          detalhe + contexto do pedido
 *       POST  /v1/support/agent/threads/:id/reply    responder
 *       PATCH /v1/support/agent/threads/:id          resolver/reabrir/atribuir
 *       GET   /v1/support/agent/stats                resumo
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const { rateLimit } = require('../infrastructure/rate-limit');
const support = require('../application/support.service');

const router = Router();

const AGENT_ROLES = ['ADMIN', 'SUPPORT'];

// Anti-spam: abertura de conversas limitada por IP.
const openLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.SUPPORT_OPEN_RATE_LIMIT_MAX) || 8,
  message: 'Demasiadas conversas abertas. Aguarde um minuto.',
});

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[support.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── Cliente (público, por token) ─────────────────────────────────────────────

router.post('/threads', openLimiter, async (req, res) => {
  try { res.status(201).json(await support.openThread(req.body)); }
  catch (err) { handleError(err, res); }
});

router.get('/threads/:id', async (req, res) => {
  try { res.json(await support.getClientThread(req.params.id, req.query.token)); }
  catch (err) { handleError(err, res); }
});

router.post('/threads/:id/reply', async (req, res) => {
  try {
    const { token, ...body } = req.body ?? {};
    res.json(await support.postClientMessage(req.params.id, token, body));
  } catch (err) { handleError(err, res); }
});

// ─── Agente (JWT + RBAC) ──────────────────────────────────────────────────────

router.get('/agent/threads', requireAuth, requireRoles(AGENT_ROLES), async (req, res) => {
  try { res.json(await support.listThreads({ status: req.query.status })); }
  catch (err) { handleError(err, res); }
});

router.get('/agent/stats', requireAuth, requireRoles(AGENT_ROLES), async (_req, res) => {
  try { res.json(await support.getStats()); }
  catch (err) { handleError(err, res); }
});

router.get('/agent/threads/:id', requireAuth, requireRoles(AGENT_ROLES), async (req, res) => {
  try { res.json(await support.getThread(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/agent/threads/:id/reply', requireAuth, requireRoles(AGENT_ROLES), async (req, res) => {
  try { res.json(await support.postAgentMessage(req.params.id, req.user, req.body)); }
  catch (err) { handleError(err, res); }
});

router.patch('/agent/threads/:id', requireAuth, requireRoles(AGENT_ROLES), async (req, res) => {
  try { res.json(await support.updateThread(req.params.id, req.body)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
