/**
 * @file clients.router.js
 * @description Router Express do registo de clientes/remetentes (/v1/clients).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.12
 *
 * RBAC ADMIN/SUPPORT em todas as rotas.
 *   GET    /v1/clients            lista (search, status, page, pageSize)
 *   GET    /v1/clients/stats      resumo
 *   POST   /v1/clients            criar
 *   GET    /v1/clients/:id        detalhe + histórico de encomendas
 *   PUT    /v1/clients/:id        atualizar
 *   POST   /v1/clients/:id/deactivate   desativar
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const clients = require('../application/clients.service');

const router = Router();
const ROLES = ['ADMIN', 'SUPPORT'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[clients.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(ROLES));

router.get('/', async (req, res) => {
  try {
    res.json(await clients.listClients({
      search: req.query.search, status: req.query.status,
      page: req.query.page, pageSize: req.query.pageSize,
    }));
  } catch (err) { handleError(err, res); }
});

router.get('/stats', async (_req, res) => {
  try { res.json(await clients.getStats()); }
  catch (err) { handleError(err, res); }
});

router.post('/', async (req, res) => {
  try { res.status(201).json(await clients.createClient(req.body)); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await clients.getClient(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.put('/:id', async (req, res) => {
  try { res.json(await clients.updateClient(req.params.id, req.body)); }
  catch (err) { handleError(err, res); }
});

router.post('/:id/deactivate', async (req, res) => {
  try { res.json(await clients.deactivateClient(req.params.id)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
