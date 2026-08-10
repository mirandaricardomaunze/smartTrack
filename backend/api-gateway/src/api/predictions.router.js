/**
 * @file predictions.router.js
 * @description Router Express da previsão e do risco (/v1/predictions).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.46 e § 3.47
 *
 * Endpoints:
 *   GET /v1/predictions/delivery-time?days  — ADMIN
 *   GET /v1/predictions/risks?days          — ADMIN, SUPPORT
 *
 * O RISCO É LEGÍVEL PELO SUPORTE. Quem atende o cliente que liga a perguntar
 * pela encomenda é quem precisa de ver que ela está em risco — e é a única
 * pessoa em posição de fazer alguma coisa antes de o prazo passar.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const { getDeliveryPredictions } = require('../application/predictions.service');
const { getRisks } = require('../application/risks.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err.statusCode) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[predictions.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** Janela do histórico. Meio ano por omissão: menos não junta amostra. */
function janela(req) {
  return { days: Math.min(Math.max(Number(req.query.days) || 180, 30), 730) };
}

router.get('/delivery-time', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await getDeliveryPredictions(janela(req))); }
  catch (err) { handleError(err, res); }
});

router.get('/risks', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await getRisks(janela(req))); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
