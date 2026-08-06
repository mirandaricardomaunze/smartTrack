/**
 * @file pricing.router.js
 * @description Router Express da tarifação (/v1/pricing).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 *   GET   /v1/pricing/zones          lista de zonas (ADMIN/SUPPORT)
 *   POST  /v1/pricing/quote          orçamento { weight_grams, zone_code, service, cod_amount }
 *   POST  /v1/pricing/zones          criar zona (ADMIN)
 *   PUT   /v1/pricing/zones/:id       atualizar zona (ADMIN)
 *   POST  /v1/pricing/zones/:id/deactivate   desativar zona (ADMIN)
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const pricing = require('../application/pricing.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[pricing.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(['ADMIN', 'SUPPORT']));

router.get('/zones', async (req, res) => {
  try { res.json(await pricing.listZones({ activeOnly: req.query.active === 'true' })); }
  catch (err) { handleError(err, res); }
});

router.post('/quote', async (req, res) => {
  try { res.json(await pricing.quote(req.body)); }
  catch (err) { handleError(err, res); }
});

// Gestão de zonas — apenas ADMIN.
router.post('/zones', requireRoles(['ADMIN']), async (req, res) => {
  try { res.status(201).json(await pricing.createZone(req.body)); }
  catch (err) { handleError(err, res); }
});

router.put('/zones/:id', requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await pricing.updateZone(req.params.id, req.body)); }
  catch (err) { handleError(err, res); }
});

router.post('/zones/:id/deactivate', requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await pricing.deactivateZone(req.params.id)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
