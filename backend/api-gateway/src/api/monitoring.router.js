/**
 * @file monitoring.router.js
 * @description Router Express da observabilidade (/v1/monitoring).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * Só leitura.
 *
 *   GET /v1/monitoring/metrics  contadores do processo (latência, taxa de erro)
 *   GET /v1/monitoring/errors   últimos erros do servidor, por empresa
 *   GET /v1/monitoring/alerts   o que está mal AGORA e o que fazer
 *
 * PORQUÊ ADMIN E NÃO PÚBLICO: os caminhos das rotas e as mensagens de erro
 * descrevem a superfície interna da API. O `/health`, esse, fica sem
 * autenticação — é o que o balanceador consulta — e por isso não revela nada
 * além de estar de pé ou não.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const monitoring = require('../application/monitoring.service');
const { getHealth: auditHealth } = require('../application/audit.service');
const { listProviders } = require('../application/providers.status');

const router = Router();
const ROLES = ['ADMIN', 'SUPERADMIN'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  console.error('[monitoring.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(ROLES));

router.get('/metrics', (_req, res) => {
  try { res.json(monitoring.getMetrics()); }
  catch (err) { handleError(err, res); }
});

router.get('/errors', async (req, res) => {
  try { res.json(await monitoring.listErrors({ limit: req.query.limit, since: req.query.since })); }
  catch (err) { handleError(err, res); }
});

router.get('/alerts', async (_req, res) => {
  try {
    res.json(await monitoring.getAlerts({ auditHealth, providers: listProviders }));
  } catch (err) { handleError(err, res); }
});

module.exports = router;
