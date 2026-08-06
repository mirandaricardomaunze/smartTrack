/**
 * @file drivers.router.js
 * @description Router Express para o recurso /v1/drivers.
 *
 * Single Responsibility: mapear HTTP req/res → use cases da aplicação.
 *
 * Endpoints:
 *   GET  /v1/drivers                  — Lista todos os motoristas
 *   GET  /v1/drivers/stats            — Contagens por status (useSidebarStats)
 *   GET  /v1/drivers/locations        — Posições GPS (para mapa ao vivo)
 *   PUT  /v1/drivers/:id/gps          — Atualiza posição GPS
 */
'use strict';

const { Router } = require('express');
const {
  listDrivers,
  listDriverLocations,
  updateDriverGps,
  DriverNotFoundError,
  InvalidGpsPayloadError,
} = require('../application/drivers.service');

const { DriverRepository } = require('../infrastructure/pg.repository');

const {
  requireAuth,
  requireRoles,
  requireSelfOrRoles,
  UnauthorizedError,
  ForbiddenError,
} = require('../application/auth.service');

const router = Router();

function handleError(err, res) {
  const known = [
    DriverNotFoundError,
    InvalidGpsPayloadError,
    UnauthorizedError,
    ForbiddenError,
  ];
  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);

  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  console.error('[drivers.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /v1/drivers ─────────────────────────────────────────────────────────
router.get('/', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try {
    res.json(await listDrivers());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/drivers/stats ───────────────────────────────────────────────────
// Consumido por useSidebarStats (frontend/admin-panel/src/hooks/useSidebarStats.ts)
// IMPORTANTE: esta rota deve vir ANTES de /:id para não ser capturada como parâmetro.
router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try {
    const stats = await DriverRepository.getStats();
    res.json(stats);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/drivers/locations ───────────────────────────────────────────────
// ATENÇÃO: esta rota deve vir ANTES de /:id para não ser capturada como parâmetro.
router.get('/locations', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (_req, res) => {
  try {
    res.json(await listDriverLocations());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── PUT /v1/drivers/:id/gps ─────────────────────────────────────────────────
router.put('/:id/gps', requireAuth, requireSelfOrRoles(['ADMIN']), async (req, res) => {
  try {
    const result = await updateDriverGps(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
