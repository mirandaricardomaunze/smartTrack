/**
 * @file drivers.router.js
 * @description Router Express para o recurso /v1/drivers.
 *
 * Single Responsibility: mapear HTTP req/res → use cases da aplicação.
 *
 * Endpoints:
 *   GET  /v1/drivers                  — Lista todos os motoristas
 *   POST /v1/drivers                  — Registra um motorista
 *   GET  /v1/drivers/stats            — Contagens por status (useSidebarStats)
 *   GET  /v1/drivers/locations        — Posições GPS (para mapa ao vivo)
 *   POST /v1/drivers/:id/access       — Cria o acesso à aplicação do motorista
 *   PUT  /v1/drivers/:id/gps          — Atualiza posição GPS
 */
'use strict';

const { Router } = require('express');
const {
  listDrivers,
  listDriverLocations,
  updateDriverGps,
  createDriver,
  grantDriverAccess,
  DriverNotFoundError,
  InvalidGpsPayloadError,
  DriverAccessError,
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
    DriverAccessError,
    UnauthorizedError,
    ForbiddenError,
  ];
  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);

  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  // Limite de utilizadores do plano (SaaS, spec § 2.5) — o acesso do motorista
  // é uma conta e conta para a quota.
  if (err.statusCode === 402) {
    return res.status(402).json({ error: err.message, code: err.name });
  }

  console.error('[drivers.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── POST /v1/drivers ────────────────────────────────────────────────────────
// O painel tinha um botão de adicionar que só mexia no estado do React; sem este
// endpoint não havia como uma empresa nova cadastrar os seus motoristas.
router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const driver = await createDriver(req.body ?? {}, {
      actor: req.user, ip: req.ip, request_id: req.requestId,
    });
    res.status(201).json(driver);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/drivers/:id/access ─────────────────────────────────────────────
// Cria a conta com que o motorista entra na aplicação. É a única porta para um
// acesso DRIVER, porque só aqui a conta fica com o id do motorista — sem isso a
// aplicação autentica e não encontra rota nem entregas (ver o serviço).
router.post('/:id/access', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const account = await grantDriverAccess(req.params.id, req.body ?? {}, {
      actor: req.user, ip: req.ip, request_id: req.requestId,
    });
    res.status(201).json(account);
  } catch (err) {
    handleError(err, res);
  }
});

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
