/**
 * @file driver-sync.router.js
 * @description HTTP adapter autenticado do módulo de sincronização offline.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, requireBodySubjectOrRoles } = require('../application/auth.service');
const {
  syncDriverEvents,
  getConflicts,
  configurePorts,
  MissingRequiredFieldError,
} = require('../../../orders-service/src/application/driver-sync.service');
const { deliverOrder, failDelivery } = require('../application/orders.service');
const { OrderRepository } = require('../infrastructure/pg.repository');

const router = Router();

configurePorts({
  applyFinalStatus: async ({ orderId, newStatus, payload, driverId, deviceId, deviceTimestamp }) => {
    const audit = { event_origin: 'DRIVER', user_id: driverId, device_id: deviceId, device_timestamp: deviceTimestamp };
    return newStatus === 'delivered'
      ? deliverOrder(orderId, { ...payload, ...audit })
      : failDelivery(orderId, { ...payload, ...audit });
  },
});

async function requireAssignedBatch(req, _res, next) {
  if (req.user?.role === 'ADMIN') return next();
  try {
    const ids = [...new Set((req.body?.events ?? []).map((event) => event.order_id).filter(Boolean))];
    const orders = await Promise.all(ids.map((id) => OrderRepository.findById(id)));
    if (orders.some((order) => !order || order.driver_id !== req.user?.sub)) {
      const error = new Error('Acesso negado: o lote contém pedido não atribuído ao motorista.');
      error.statusCode = 403;
      return next(error);
    }
    return next();
  } catch (err) { return next(err); }
}

function handleError(err, res) {
  if (err instanceof MissingRequiredFieldError || (err.statusCode >= 400 && err.statusCode < 500)) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[driver-sync.module] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.post('/events', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireBodySubjectOrRoles(['ADMIN'], 'driver_id'), requireAssignedBatch, async (req, res) => {
  try { res.json(await syncDriverEvents(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.get('/conflicts/:orderId', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await getConflicts(req.params.orderId)); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
