/**
 * @file reports.router.js
 * @description Router Express para relatórios e analytics (/v1/reports).
 *
 * Endpoints:
 *   GET /v1/reports/summary?days=14  — KPIs + volume + desempenho por motorista + distribuição
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const { getSummary } = require('../application/reports.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[reports.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.get('/summary', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await getSummary({ days: Number(req.query.days) || 14 })); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
