/**
 * @file settlements.router.js
 * @description Router Express para /v1/settlements (acerto de caixa do motorista — COD).
 *
 * Endpoints:
 *   GET  /v1/settlements                     — Lista acertos (opcional ?driver_id)
 *   GET  /v1/settlements/stats               — Resumo agregado
 *   GET  /v1/settlements/driver/:id/cod      — COD recolhido por acertar de um motorista
 *   POST /v1/settlements                     — Abre um acerto para um motorista
 *   GET  /v1/settlements/:id                 — Detalhe de um acerto
 *   POST /v1/settlements/:id/reconcile       — Reconcilia com o numerário entregue
 */
'use strict';

const { Router } = require('express');
const {
  listSettlements,
  getSettlement,
  getSettlementStats,
  listDriverCod,
  openSettlement,
  reconcileSettlement,
  SettlementNotFoundError,
  NoCodToSettleError,
  SettlementAlreadyReconciledError,
  InvalidAmountError,
} = require('../application/settlements.service');

const { MissingRequiredFieldError } = require('../application/orders.service');

const {
  requireAuth,
  requireRoles,
  UnauthorizedError,
  ForbiddenError,
} = require('../application/auth.service');

const router = Router();

function handleError(err, res) {
  const known = [
    SettlementNotFoundError,
    NoCodToSettleError,
    SettlementAlreadyReconciledError,
    InvalidAmountError,
    MissingRequiredFieldError,
    UnauthorizedError,
    ForbiddenError,
  ];
  if (known.some((ErrorClass) => err instanceof ErrorClass)) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[settlements.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /v1/settlements ──────────────────────────────────────────────────────
router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listSettlements({ driver_id: req.query.driver_id })); }
  catch (err) { handleError(err, res); }
});

// ─── GET /v1/settlements/stats ────────────────────────────────────────────────
router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try { res.json(await getSettlementStats()); }
  catch (err) { handleError(err, res); }
});

// ─── GET /v1/settlements/driver/:driverId/cod ─────────────────────────────────
router.get('/driver/:driverId/cod', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listDriverCod(req.params.driverId)); }
  catch (err) { handleError(err, res); }
});

// ─── POST /v1/settlements ─────────────────────────────────────────────────────
router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const settlement = await openSettlement(req.body?.driver_id, { user_id: req.user.sub });
    res.status(201).json(settlement);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/settlements/:id ──────────────────────────────────────────────────
router.get('/:id', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await getSettlement(req.params.id)); }
  catch (err) { handleError(err, res); }
});

// ─── POST /v1/settlements/:id/reconcile ───────────────────────────────────────
router.post('/:id/reconcile', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const settlement = await reconcileSettlement(req.params.id, { ...req.body, user_id: req.user.sub });
    res.json(settlement);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
