/**
 * @file incidents.router.js
 * @description Router das ocorrências e do SLA (/v1/incidents, /v1/sla).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 *   GET  /v1/incidents             lista (status, kind, assignee_id)
 *   GET  /v1/incidents/stats       contagens para o painel
 *   POST /v1/incidents             abrir
 *   GET  /v1/incidents/:id         detalhe
 *   GET  /v1/incidents/:id/history histórico imutável
 *   POST /v1/incidents/:id/transition
 *   POST /v1/incidents/:id/comment
 *
 * RBAC ADMIN/SUPPORT: quem atende o cliente é quem abre a ocorrência —
 * obrigar a passar pelo ADMIN faria a queixa ficar num papel.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const incidents = require('../application/incidents.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[incidents.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(['ADMIN', 'SUPPORT']));

router.get('/stats', async (_req, res) => {
  try { res.json(await incidents.getIncidentStats()); }
  catch (err) { handleError(err, res); }
});

router.get('/', async (req, res) => {
  try {
    res.json(await incidents.listIncidents({
      status: req.query.status, kind: req.query.kind, assignee_id: req.query.assignee_id,
    }));
  } catch (err) { handleError(err, res); }
});

router.post('/', async (req, res) => {
  try { res.status(201).json(await incidents.openIncident({ ...req.body, user_id: req.user?.sub })); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await incidents.getIncident(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.get('/:id/history', async (req, res) => {
  try { res.json(await incidents.getIncidentHistory(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/:id/transition', async (req, res) => {
  try {
    res.json(await incidents.transitionIncident(req.params.id, {
      to: req.body?.to, note: req.body?.note, user_id: req.user?.sub,
    }));
  } catch (err) { handleError(err, res); }
});

router.post('/:id/comment', async (req, res) => {
  try {
    res.json(await incidents.commentIncident(req.params.id, { note: req.body?.note, user_id: req.user?.sub }));
  } catch (err) { handleError(err, res); }
});

module.exports = router;
