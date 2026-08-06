/**
 * @file sync.router.js
 * @description Router Express do orders-service.
 *
 * Single Responsibility: mapear HTTP req/res → casos de uso.
 * Sem autenticação: o api-gateway autentica antes de encaminhar (regra 1).
 *
 * Endpoints:
 *   POST /sync/driver-events         — Sincroniza um lote offline
 *   GET  /orders/:id/conflicts       — Auditoria de conflitos de um pedido
 */
'use strict';

const { Router } = require('express');
const {
  syncDriverEvents,
  getConflicts,
  MissingRequiredFieldError,
} = require('../application/driver-sync.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof MissingRequiredFieldError) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[sync.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── POST /sync/driver-events ─────────────────────────────────────────────────
router.post('/sync/driver-events', async (req, res) => {
  try {
    res.json(await syncDriverEvents(req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /orders/:id/conflicts ────────────────────────────────────────────────
router.get('/orders/:id/conflicts', async (req, res) => {
  try {
    res.json(await getConflicts(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
