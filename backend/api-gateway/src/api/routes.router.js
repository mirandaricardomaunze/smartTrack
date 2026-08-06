/**
 * @file routes.router.js
 * @description HTTP adapter do módulo de rotas no monólito modular.
 *
 * O gateway mantém autenticação/RBAC e chama os casos de uso diretamente.
 * Não existe salto HTTP nem processo adicional para o módulo de rotas.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, requireResourceOwnerOrRoles } = require('../application/auth.service');
const {
  listRoutes,
  getRoute,
  getActiveRouteForDriver,
  previewOptimization,
  createRoute,
  reoptimizeRoute,
  updateRouteStatus,
  updateStopStatus,
  getStats,
  RouteNotFoundError,
  MissingRequiredFieldError,
  EmptyRouteError,
  InvalidRouteTransitionError,
} = require('../../../routes-service/src/application/routes.service');

const router = Router();
const requireAssignedRoute = requireResourceOwnerOrRoles(
  ['ADMIN', 'SUPPORT'],
  (id) => getRoute(id),
  'driver_id',
);

function handleError(err, res) {
  const known = [
    RouteNotFoundError,
    MissingRequiredFieldError,
    EmptyRouteError,
    InvalidRouteTransitionError,
  ];
  if (known.some((ErrorClass) => err instanceof ErrorClass)) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[routes.module] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json(await listRoutes({ driver_id: req.query.driver_id })); }
  catch (err) { handleError(err, res); }
});

router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try { res.json(await getStats()); }
  catch (err) { handleError(err, res); }
});

router.get('/me', requireAuth, requireRoles(['DRIVER']), async (req, res) => {
  try { res.json(await getActiveRouteForDriver(req.user.sub)); }
  catch (err) { handleError(err, res); }
});

router.post('/optimize', requireAuth, requireRoles(['ADMIN']), (req, res) => {
  try { res.json(previewOptimization(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.status(201).json(await createRoute(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', requireAuth, requireRoles(['ADMIN', 'SUPPORT', 'DRIVER']), requireAssignedRoute, async (req, res) => {
  try { res.json(await getRoute(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/:id/reoptimize', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await reoptimizeRoute(req.params.id, req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.put('/:id/status', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await updateRouteStatus(req.params.id, req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.put('/:id/stops/:orderId', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireAssignedRoute, async (req, res) => {
  try { res.json(await updateStopStatus(req.params.id, req.params.orderId, req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

module.exports = router;
