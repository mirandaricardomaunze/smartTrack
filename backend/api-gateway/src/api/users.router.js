/**
 * @file users.router.js
 * @description Router Express para /v1/users — localização de quem usa o sistema.
 *
 * Endpoints:
 *   POST /v1/users/me/location — regista a localização atual do próprio utilizador
 *   GET  /v1/users/locations   — lista as últimas localizações (ADMIN, monitorização)
 */
'use strict';

const { Router } = require('express');
const { UserLocationRepository } = require('../infrastructure/pg.repository');
const {
  requireAuth,
  requireRoles,
  UnauthorizedError,
  ForbiddenError,
} = require('../application/auth.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[users.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── POST /v1/users/me/location ───────────────────────────────────────────────
router.post('/me/location', requireAuth, async (req, res) => {
  const { lat, lng, accuracy } = req.body ?? {};
  const nlat = Number(lat);
  const nlng = Number(lng);

  if (Number.isNaN(nlat) || Number.isNaN(nlng) || nlat < -90 || nlat > 90 || nlng < -180 || nlng > 180) {
    return res.status(400).json({ error: 'lat e lng são obrigatórios e devem ser coordenadas válidas.' });
  }

  try {
    await UserLocationRepository.ensureTable();
    const saved = await UserLocationRepository.upsert({
      user_id:  req.user.sub,
      email:    req.user.email,
      role:     req.user.role,
      lat:      nlat,
      lng:      nlng,
      accuracy: accuracy != null && !Number.isNaN(Number(accuracy)) ? Number(accuracy) : null,
    });
    res.json({ success: true, updatedAt: saved.updated_at instanceof Date ? saved.updated_at.toISOString() : saved.updated_at });
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/users/locations ──────────────────────────────────────────────────
router.get('/locations', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try {
    await UserLocationRepository.ensureTable();
    res.json(await UserLocationRepository.findAll());
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
