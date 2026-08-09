/**
 * @file receivables.router.js
 * @description Router das contas a receber (/v1/receivables).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.41
 *
 *   GET /v1/receivables               carteira por cliente, com escalões
 *   GET /v1/receivables/:clientRefId  faturas em aberto desse cliente
 *
 * RBAC só ADMIN: a carteira de dívida é a informação financeira mais sensível da
 * empresa, e quem atende ao balcão não precisa dela para fazer o seu trabalho.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const receivables = require('../application/receivables.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  console.error('[receivables.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(['ADMIN']));

router.get('/', async (req, res) => {
  try { res.json(await receivables.getReceivables(req.query.today)); }
  catch (err) { handleError(err, res); }
});

router.get('/:clientRefId', async (req, res) => {
  try { res.json(await receivables.getClientReceivables(req.params.clientRefId, req.query.today)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
