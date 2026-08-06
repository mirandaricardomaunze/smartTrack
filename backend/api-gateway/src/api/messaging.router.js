/**
 * @file messaging.router.js
 * @description HTTP adapter para o log de mensagens ao cliente (SMS/email).
 *
 * Endpoints:
 *   GET /v1/messaging/messages   — Log de SMS/email enviados
 *   GET /v1/messaging/stats      — Resumo agregado
 *   GET /v1/messaging/provider   — Modo do provedor (real vs simulado)
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const {
  listOutboundMessages,
  getMessagingStats,
  getProviderInfo,
} = require('../../../notifications-service/src/application/messaging.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[messaging.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.get('/messages', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listOutboundMessages(Number(req.query.limit) || 100)); }
  catch (err) { handleError(err, res); }
});

router.get('/stats', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (_req, res) => {
  try { res.json(await getMessagingStats()); }
  catch (err) { handleError(err, res); }
});

router.get('/provider', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), (_req, res) => {
  try { res.json(getProviderInfo()); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
