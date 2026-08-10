/**
 * @file sla.router.js
 * @description Router do SLA de entrega (/v1/sla).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 *   GET /v1/sla/summary   cumprimento no período
 *   GET /v1/sla/breaches  encomendas fora do prazo, a pior primeiro
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const sla = require('../application/sla.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  console.error('[sla.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(['ADMIN', 'SUPPORT']));

router.get('/summary', async (req, res) => {
  try { res.json(await sla.getSlaSummary({ from: req.query.from, to: req.query.to })); }
  catch (err) { handleError(err, res); }
});

router.get('/breaches', async (req, res) => {
  try { res.json(await sla.getSlaBreaches({ from: req.query.from, to: req.query.to })); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
