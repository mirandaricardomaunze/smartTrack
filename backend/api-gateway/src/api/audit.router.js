/**
 * @file audit.router.js
 * @description Router Express do registo de auditoria (/v1/audit).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * Só leitura — não existe endpoint para criar, alterar ou apagar eventos. Um
 * registo que se pode editar não serve para auditar nada.
 *
 *   GET /v1/audit            lista com filtros (from, to, action, actor,
 *                            entity_type, entity_id, outcome, search, page, pageSize)
 *   GET /v1/audit/stats      resumo do período (volume, recusas, erros, atores)
 *   GET /v1/audit/actions    ações distintas — alimenta o filtro da página
 *   GET /v1/audit/integrity  recálculo das assinaturas e da sequência
 *   GET /v1/audit/health     contadores do próprio registo (falhas de escrita)
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const audit = require('../application/audit.service');

const router = Router();
/** O registo é do responsável da empresa; a plataforma vê tudo. */
const ROLES = ['ADMIN', 'SUPERADMIN'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[audit.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(ROLES));

router.get('/', async (req, res) => {
  try {
    res.json(await audit.listEvents({
      from: req.query.from, to: req.query.to, action: req.query.action, actor: req.query.actor,
      entity_type: req.query.entity_type, entity_id: req.query.entity_id, outcome: req.query.outcome,
      search: req.query.search, page: req.query.page, pageSize: req.query.pageSize,
    }));
  } catch (err) { handleError(err, res); }
});

router.get('/stats', async (req, res) => {
  try { res.json(await audit.getStats({ from: req.query.from, to: req.query.to })); }
  catch (err) { handleError(err, res); }
});

router.get('/actions', async (_req, res) => {
  try { res.json(await audit.listActions()); }
  catch (err) { handleError(err, res); }
});

router.get('/integrity', async (_req, res) => {
  try { res.json(await audit.verifyIntegrity()); }
  catch (err) { handleError(err, res); }
});

router.get('/health', async (_req, res) => {
  try { res.json(audit.getHealth()); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
