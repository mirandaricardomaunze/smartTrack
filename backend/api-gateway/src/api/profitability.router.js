/**
 * @file profitability.router.js
 * @description Router da rentabilidade (/v1/profitability).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.40
 *
 *   GET /v1/profitability/orders    margem por pedido entregue
 *   GET /v1/profitability/routes    margem por rota
 *   GET /v1/profitability/clients   margem por cliente
 *   GET /v1/profitability/vehicles  margem por viatura
 *
 * Todas aceitam `from`/`to` e todas devolvem `cost_coverage` — uma margem sem a
 * cobertura declarada é um número que parece completo e não é.
 *
 * RBAC só ADMIN: margem por cliente é informação comercial sensível, e quem
 * atende ao balcão não precisa dela para fazer o seu trabalho.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const profitability = require('../application/profitability.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  console.error('[profitability.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(['ADMIN']));

const janela = (req) => ({ from: req.query.from, to: req.query.to });

router.get('/orders', async (req, res) => {
  try { res.json(await profitability.getOrderProfitability(janela(req))); }
  catch (err) { handleError(err, res); }
});

router.get('/routes', async (req, res) => {
  try { res.json(await profitability.getRouteProfitability(janela(req))); }
  catch (err) { handleError(err, res); }
});

router.get('/clients', async (req, res) => {
  try { res.json(await profitability.getClientProfitability(janela(req))); }
  catch (err) { handleError(err, res); }
});

router.get('/vehicles', async (req, res) => {
  try { res.json(await profitability.getVehicleProfitability(janela(req))); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
