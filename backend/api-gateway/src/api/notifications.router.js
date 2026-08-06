/**
 * @file notifications.router.js
 * @description HTTP adapter autenticado do módulo de notificações.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles } = require('../application/auth.service');
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
} = require('../../../notifications-service/src/application/notifications.service');
const { EmptyTokenListError } = require('../../../notifications-service/src/infrastructure/fcm.client');

const router = Router();
const ANY_ROLE = ['ADMIN', 'SUPPORT', 'DRIVER', 'CLIENT', 'SYSTEM'];

function handleError(err, res) {
  const known = [
    NotificationNotFoundError,
    MissingRequiredFieldError,
    UnknownCategoryError,
    InvalidNotificationTransitionError,
    EmptyTokenListError,
  ];
  if (known.some((ErrorClass) => err instanceof ErrorClass)) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[notifications.module] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listNotifications({ user_id: req.query.user_id, limit: req.query.limit })); }
  catch (err) { handleError(err, res); }
});

router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try { res.json(await getStats()); }
  catch (err) { handleError(err, res); }
});

router.post('/send', requireAuth, requireRoles(['ADMIN', 'SYSTEM']), async (req, res) => {
  try { res.json(await sendNotification(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.get('/preferences', requireAuth, requireRoles(ANY_ROLE), async (req, res) => {
  try { res.json(await getPreferences(req.user.sub, req.user.role)); }
  catch (err) { handleError(err, res); }
});

router.put('/preferences', requireAuth, requireRoles(ANY_ROLE), async (req, res) => {
  try { res.json(await updatePreferences(req.user.sub, req.body?.categories)); }
  catch (err) { handleError(err, res); }
});

router.post('/devices', requireAuth, requireRoles(ANY_ROLE), async (req, res) => {
  try { res.json(await registerDevice({ ...(req.body ?? {}), user_id: req.user.sub })); }
  catch (err) { handleError(err, res); }
});

router.delete('/devices/:token', requireAuth, requireRoles(ANY_ROLE), async (req, res) => {
  try { res.json(await unregisterDevice(req.params.token)); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await getNotification(req.params.id)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
