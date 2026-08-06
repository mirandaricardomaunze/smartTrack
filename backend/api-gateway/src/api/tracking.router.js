/**
 * @file tracking.router.js
 * @description HTTP adapter do módulo de rastreio internacional.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles } = require('../application/auth.service');
const {
  trackShipment,
  getTracking,
  pollShipment,
  runPollingCycle,
  getStats,
  listShipments,
  listCarriers,
  getProviderInfo,
  MissingRequiredFieldError,
  TrackingNotFoundError,
} = require('../../../tracking-intl-service/src/application/tracking.service');
const { UnsupportedCarrierError } = require('../../../tracking-intl-service/src/infrastructure/carrier.client');

const router = Router();

function handleError(err, res) {
  const known = [MissingRequiredFieldError, TrackingNotFoundError, UnsupportedCarrierError];
  if (known.some((ErrorClass) => err instanceof ErrorClass)) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[tracking.module] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try { res.json(await getStats()); }
  catch (err) { handleError(err, res); }
});

// Transportadoras conhecidas (para o formulário de registo). ANTES de /:code.
router.get('/carriers', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), (_req, res) => {
  try { res.json({ carriers: listCarriers() }); }
  catch (err) { handleError(err, res); }
});

// Modo do provedor (real 17TRACK vs simulado). ANTES de /:code.
router.get('/provider', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), (_req, res) => {
  try { res.json(getProviderInfo()); }
  catch (err) { handleError(err, res); }
});

// Lista dos envios em acompanhamento. Rota exata (não colide com /:code).
router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listShipments(Number(req.query?.limit) || 100)); }
  catch (err) { handleError(err, res); }
});

router.post('/poll', requireAuth, requireRoles(['ADMIN', 'SYSTEM']), async (req, res) => {
  try { res.json(await runPollingCycle(Number(req.body?.limit) || 100)); }
  catch (err) { handleError(err, res); }
});

router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await trackShipment(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.post('/:code/poll', requireAuth, requireRoles(['ADMIN', 'SYSTEM']), async (req, res) => {
  try { res.json(await pollShipment({ tracking_code: req.params.code, carrier: req.body?.carrier })); }
  catch (err) { handleError(err, res); }
});

// Público por contrato da spec §9: rastreamento pelo código sem login.
router.get('/:code', async (req, res) => {
  try { res.json(await getTracking(req.params.code)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
