/**
 * @file payments.router.js
 * @description HTTP adapter autenticado do módulo de pagamentos.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles } = require('../application/auth.service');
const {
  listPayments,
  getPayment,
  getStats,
  chargeOrder,
  handleWebhook,
  refundPayment,
  reconcile,
  InvalidWebhookSignatureError,
  PaymentNotFoundError,
  MissingRequiredFieldError,
  InvalidAmountError,
  InvalidPaymentTransitionError,
  MaxAttemptsExceededError,
} = require('../../../payments-service/src/application/payments.service');
const { MissingIdempotencyKeyError } = require('../../../payments-service/src/infrastructure/gateway.client');

const paymentsRouter = Router();
const webhookRouter = Router();

function handleError(err, res) {
  const known = [
    PaymentNotFoundError,
    MissingRequiredFieldError,
    InvalidAmountError,
    InvalidPaymentTransitionError,
    MaxAttemptsExceededError,
    InvalidWebhookSignatureError,
    MissingIdempotencyKeyError,
  ];
  if (known.some((ErrorClass) => err instanceof ErrorClass)) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[payments.module] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

paymentsRouter.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listPayments({ order_id: req.query.order_id })); }
  catch (err) { handleError(err, res); }
});

paymentsRouter.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try { res.json(await getStats()); }
  catch (err) { handleError(err, res); }
});

paymentsRouter.get('/reconcile', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await reconcile(req.query.since)); }
  catch (err) { handleError(err, res); }
});

paymentsRouter.post('/charge', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await chargeOrder(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

paymentsRouter.get('/:id', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await getPayment(req.params.id)); }
  catch (err) { handleError(err, res); }
});

paymentsRouter.post('/:id/refund', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await refundPayment(req.params.id)); }
  catch (err) { handleError(err, res); }
});

webhookRouter.post('/payments', async (req, res) => {
  try {
    res.json(await handleWebhook(req.body ?? {}, req.headers['x-webhook-signature']));
  } catch (err) { handleError(err, res); }
});

module.exports = { paymentsRouter, webhookRouter };
