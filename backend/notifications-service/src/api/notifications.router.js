/**
 * @file notifications.router.js
 * @description Router Express para o notifications-service.
 *
 * Single Responsibility: mapear HTTP req/res → casos de uso da aplicação.
 *
 * NOTA: sem autenticação aqui. Conforme a regra 1 de backend/README.md, este
 * serviço nunca é exposto diretamente — o api-gateway autentica e aplica RBAC.
 *
 * Endpoints:
 *   GET    /notifications                    — Histórico (?user_id=, ?limit=)
 *   GET    /notifications/stats              — Contagens por desfecho
 *   POST   /notifications/send               — Envia um push
 *   GET    /notifications/:id                — Detalhe
 *   GET    /preferences/:userId              — Preferências (?role=)
 *   PUT    /preferences/:userId              — Atualiza preferências
 *   POST   /devices                          — Regista token FCM
 *   DELETE /devices/:token                   — Remove token
 */
'use strict';

const { Router } = require('express');
const {
  listNotifications,
  getNotification,
  getStats,
  getPreferences,
  updatePreferences,
  registerDevice,
  unregisterDevice,
  sendNotification,
  NotificationNotFoundError,
  MissingRequiredFieldError,
  UnknownCategoryError,
  InvalidNotificationTransitionError,
} = require('../application/notifications.service');

const { EmptyTokenListError } = require('../infrastructure/fcm.client');

const router = Router();

/** Tratamento de erros tipados — mesmo padrão dos outros serviços. */
function handleError(err, res) {
  const known = [
    NotificationNotFoundError,
    MissingRequiredFieldError,
    UnknownCategoryError,
    InvalidNotificationTransitionError,
    EmptyTokenListError,
  ];

  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);
  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  console.error('[notifications.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /notifications ───────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  try {
    res.json(await listNotifications({
      user_id: req.query.user_id,
      limit:   req.query.limit,
    }));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /notifications/stats ─────────────────────────────────────────────────
// IMPORTANTE: antes de /:id para não ser capturada como parâmetro.
router.get('/notifications/stats', async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /notifications/send ─────────────────────────────────────────────────
router.post('/notifications/send', async (req, res) => {
  try {
    res.json(await sendNotification(req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /notifications/:id ───────────────────────────────────────────────────
router.get('/notifications/:id', async (req, res) => {
  try {
    res.json(await getNotification(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /preferences/:userId ─────────────────────────────────────────────────
router.get('/preferences/:userId', async (req, res) => {
  try {
    res.json(await getPreferences(req.params.userId, req.query.role));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── PUT /preferences/:userId ─────────────────────────────────────────────────
router.put('/preferences/:userId', async (req, res) => {
  try {
    const body = req.body ?? {};
    res.json(await updatePreferences(req.params.userId, body.categories ?? body));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /devices ────────────────────────────────────────────────────────────
router.post('/devices', async (req, res) => {
  try {
    // 200 e não 201: registar é idempotente — a app reenvia a cada arranque.
    res.json(await registerDevice(req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── DELETE /devices/:token ───────────────────────────────────────────────────
router.delete('/devices/:token', async (req, res) => {
  try {
    res.json(await unregisterDevice(req.params.token));
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
