/**
 * @file tracking.router.js
 * @description Router Express do tracking-intl-service.
 *
 * Single Responsibility: mapear HTTP req/res → casos de uso.
 * Sem autenticação: o api-gateway autentica antes de encaminhar (regra 1).
 *
 * Endpoints:
 *   GET  /tracking/stats            — Contadores
 *   POST /tracking/poll             — Corre um ciclo de polling
 *   POST /tracking                  — Passa um código a ser acompanhado
 *   POST /tracking/:code/poll       — Consulta uma encomenda específica
 *   GET  /tracking/:code            — Histórico normalizado
 */
'use strict';

const { Router } = require('express');
const {
  trackShipment,
  getTracking,
  pollShipment,
  runPollingCycle,
  getStats,
  MissingRequiredFieldError,
  TrackingNotFoundError,
} = require('../application/tracking.service');

const { UnsupportedCarrierError } = require('../infrastructure/carrier.client');

const router = Router();

/** Tratamento de erros tipados — mesmo padrão dos outros serviços. */
function handleError(err, res) {
  const known = [
    MissingRequiredFieldError,
    TrackingNotFoundError,
    UnsupportedCarrierError,
  ];

  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);
  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  console.error('[tracking.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /tracking/stats ──────────────────────────────────────────────────────
// IMPORTANTE: as rotas literais vêm ANTES de /:code.
router.get('/tracking/stats', async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /tracking/poll ──────────────────────────────────────────────────────
router.post('/tracking/poll', async (req, res) => {
  try {
    const limite = Number(req.body?.limit) || 100;
    res.json(await runPollingCycle(limite));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /tracking ───────────────────────────────────────────────────────────
router.post('/tracking', async (req, res) => {
  try {
    // 200 e não 201: registar é idempotente.
    res.json(await trackShipment(req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /tracking/:code/poll ────────────────────────────────────────────────
router.post('/tracking/:code/poll', async (req, res) => {
  try {
    res.json(await pollShipment({
      tracking_code: req.params.code,
      carrier:       req.body?.carrier,
    }));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /tracking/:code ──────────────────────────────────────────────────────
router.get('/tracking/:code', async (req, res) => {
  try {
    res.json(await getTracking(req.params.code));
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
