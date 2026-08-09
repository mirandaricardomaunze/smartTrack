/**
 * @file operations.router.js
 * @description Router do dashboard operacional (/v1/operations).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.39
 *
 *   GET /v1/operations/summary     indicadores agregados na base
 *   GET /v1/operations/exceptions  o que está à espera de uma decisão
 *
 * RBAC ADMIN/SUPPORT: quem atende o cliente precisa de ver a fila de exceções
 * para responder — mandar isso passar só pelo ADMIN atrasaria a resposta a quem
 * está ao telefone.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const operations = require('../application/operations.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  console.error('[operations.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(['ADMIN', 'SUPPORT']));

router.get('/summary', async (_req, res) => {
  try { res.json(await operations.getSummary()); }
  catch (err) { handleError(err, res); }
});

router.get('/exceptions', async (_req, res) => {
  try { res.json(await operations.getExceptions()); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
