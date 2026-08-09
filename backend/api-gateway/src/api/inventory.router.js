/**
 * @file inventory.router.js
 * @description Router das transferências entre filiais e contagens (/v1/inventory).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 *   GET    /v1/inventory/warehouses/:id            inventário atual, com idade
 *   GET    /v1/inventory/transfers                 lista (warehouse_id, status)
 *   POST   /v1/inventory/transfers                 abrir com manifesto
 *   GET    /v1/inventory/transfers/:id             detalhe + manifesto
 *   POST   /v1/inventory/transfers/:id/dispatch    a carga sai da origem
 *   POST   /v1/inventory/transfers/:id/receive     conferir e receber no destino
 *   POST   /v1/inventory/transfers/:id/cancel      só em rascunho
 *   GET    /v1/inventory/warehouses/:id/counts     histórico de contagens
 *   POST   /v1/inventory/warehouses/:id/counts     abrir contagem
 *   POST   /v1/inventory/counts/:id/scans          acrescentar leituras
 *   POST   /v1/inventory/counts/:id/close          fechar e obter divergências
 *
 * RBAC: ADMIN e SUPPORT. Quem está ao balcão de uma filial precisa de conferir
 * o que chegou — mandar isso passar por um ADMIN pararia a operação enquanto o
 * camião espera.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const inventory = require('../application/inventory.service');

const router = Router();
const ROLES = ['ADMIN', 'SUPPORT'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[inventory.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.use(requireAuth, requireRoles(ROLES));

// ─── Inventário ───────────────────────────────────────────────────────────────

router.get('/warehouses/:id', async (req, res) => {
  try { res.json(await inventory.getInventory(req.params.id)); }
  catch (err) { handleError(err, res); }
});

// ─── Transferências ───────────────────────────────────────────────────────────

router.get('/transfers', async (req, res) => {
  try {
    res.json(await inventory.listTransfers({
      warehouse_id: req.query.warehouse_id,
      status: req.query.status,
    }));
  } catch (err) { handleError(err, res); }
});

router.post('/transfers', async (req, res) => {
  try {
    res.status(201).json(await inventory.createTransfer({ ...req.body, user_id: req.user?.sub }));
  } catch (err) { handleError(err, res); }
});

router.get('/transfers/:id', async (req, res) => {
  try { res.json(await inventory.getTransfer(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/transfers/:id/dispatch', async (req, res) => {
  try { res.json(await inventory.dispatchTransfer(req.params.id, { user_id: req.user?.sub })); }
  catch (err) { handleError(err, res); }
});

router.post('/transfers/:id/receive', async (req, res) => {
  try {
    res.json(await inventory.receiveTransfer(req.params.id, {
      scanned_codes: req.body?.scanned_codes,
      notes: req.body?.notes,
      user_id: req.user?.sub,
    }));
  } catch (err) { handleError(err, res); }
});

router.post('/transfers/:id/cancel', async (req, res) => {
  try { res.json(await inventory.cancelTransfer(req.params.id, { user_id: req.user?.sub })); }
  catch (err) { handleError(err, res); }
});

// ─── Contagens ────────────────────────────────────────────────────────────────

router.get('/warehouses/:id/counts', async (req, res) => {
  try { res.json(await inventory.listCounts(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/warehouses/:id/counts', async (req, res) => {
  try { res.status(201).json(await inventory.openCount(req.params.id, { user_id: req.user?.sub })); }
  catch (err) { handleError(err, res); }
});

router.post('/counts/:id/scans', async (req, res) => {
  try { res.json(await inventory.addCountScans(req.params.id, { codes: req.body?.codes })); }
  catch (err) { handleError(err, res); }
});

router.post('/counts/:id/close', async (req, res) => {
  try {
    res.json(await inventory.closeCount(req.params.id, { notes: req.body?.notes, user_id: req.user?.sub }));
  } catch (err) { handleError(err, res); }
});

module.exports = router;
