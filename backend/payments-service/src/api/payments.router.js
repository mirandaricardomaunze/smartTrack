/**
 * @file payments.router.js
 * @description Router Express para o recurso /payments.
 *
 * Single Responsibility: mapear HTTP req/res → casos de uso da aplicação.
 *
 * NOTA: este serviço NÃO faz autenticação de utilizador. Conforme a regra 1 de
 * backend/README.md, nunca é exposto diretamente — o api-gateway autentica e
 * aplica RBAC antes de encaminhar. A EXCEÇÃO é `/webhooks/gateway`, que é
 * chamado pelo gateway de pagamento (não pelo nosso api-gateway) e por isso tem
 * a sua própria verificação de assinatura.
 *
 * Endpoints:
 *   GET   /payments                — Lista (filtro opcional ?order_id=)
 *   GET   /payments/stats          — Contagens por status + receita
 *   POST  /payments/charge         — Cobra um pedido (idempotente)
 *   GET   /payments/reconcile      — Relatório de conciliação
 *   GET   /payments/:id            — Detalhe
 *   POST  /payments/:id/refund     — Estorno
 *   POST  /webhooks/gateway        — Notificação do gateway (assinada)
 */
'use strict';

const { Router } = require('express');
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
} = require('../application/payments.service');

const { MissingIdempotencyKeyError } = require('../infrastructure/gateway.client');

const router = Router();

/** Tratamento de erros tipados — mesmo padrão dos outros serviços. */
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

  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);
  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  console.error('[payments.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /payments ────────────────────────────────────────────────────────────
router.get('/payments', async (req, res) => {
  try {
    res.json(await listPayments({ order_id: req.query.order_id }));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /payments/stats ──────────────────────────────────────────────────────
// IMPORTANTE: antes de /:id para não ser capturada como parâmetro.
router.get('/payments/stats', async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /payments/reconcile ──────────────────────────────────────────────────
router.get('/payments/reconcile', async (req, res) => {
  try {
    res.json(await reconcile(req.query.since));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /payments/charge ────────────────────────────────────────────────────
router.post('/payments/charge', async (req, res) => {
  try {
    const pagamento = await chargeOrder(req.body ?? {});
    // 200 e não 201: a operação é idempotente — repetir devolve o mesmo recurso.
    res.json(pagamento);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /payments/:id ────────────────────────────────────────────────────────
router.get('/payments/:id', async (req, res) => {
  try {
    res.json(await getPayment(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /payments/:id/refund ────────────────────────────────────────────────
router.post('/payments/:id/refund', async (req, res) => {
  try {
    res.json(await refundPayment(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /webhooks/gateway ───────────────────────────────────────────────────
// Chamado pelo gateway de pagamento, não pelo api-gateway.
// A assinatura é verificada dentro de handleWebhook (skill § regra 4).
router.post('/webhooks/gateway', async (req, res) => {
  try {
    const assinatura = req.headers['x-webhook-signature'];
    const resultado  = await handleWebhook(req.body ?? {}, assinatura);

    // Sempre 200 quando a assinatura é válida — mesmo em no-op — para o gateway
    // não reenviar indefinidamente uma notificação que já tratámos.
    res.json(resultado);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
