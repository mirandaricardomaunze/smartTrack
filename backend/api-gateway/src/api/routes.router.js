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

const {
  assertRouteFitsDriver, assignRouteOrders, planAutomaticDispatch, DispatchError,
} = require('../application/dispatch.service');

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
    DispatchError,
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

// ─── Despacho automático (spec § 3.38) ────────────────────────────────────────
// PROPÕE, não executa. Um sistema que cria rotas sozinho é, na prática, uma
// forma de ninguém olhar: quando a proposta estiver errada, a carga já saiu.

router.post('/dispatch/plan', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await planAutomaticDispatch(req.body ?? {})); }
  catch (err) { handleError(err, res); }
});

router.post('/dispatch/confirm', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    // Confirmar passa pelo MESMO caminho do despacho manual — verificação de
    // carga e atribuição incluídas. O automático não é uma porta lateral que
    // salta as validações.
    const criadas = [];
    for (const proposta of req.body?.routes ?? []) {
      if (proposta.driver_id) await assertRouteFitsDriver(proposta.driver_id, proposta.stops ?? []);
      const route = await createRoute({ driver_id: proposta.driver_id, stops: proposta.stops, origin: req.body?.origin });
      const assignment = await assignRouteOrders(route);
      criadas.push({ ...route, assignment });
    }
    res.status(201).json({ routes: criadas, created: criadas.length });
  } catch (err) { handleError(err, res); }
});

router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  const body = req.body ?? {};
  try {
    // A capacidade verifica-se antes de otimizar: não vale a pena calcular a
    // melhor ordem de paradas que a moto não consegue transportar (§ 3.33).
    if (body.driver_id) await assertRouteFitsDriver(body.driver_id, body.stops ?? []);
    const route = await createRoute(body);
    // Despachar é atribuir: sem isto a rota existe e o motorista continua sem a
    // encomenda nas mãos da aplicação dele. Ver a nota em dispatch.service.
    const assignment = await assignRouteOrders(route);
    res.status(201).json({ ...route, assignment });
  } catch (err) { handleError(err, res); }
});

router.get('/:id', requireAuth, requireRoles(['ADMIN', 'SUPPORT', 'DRIVER']), requireAssignedRoute, async (req, res) => {
  try { res.json(await getRoute(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/:id/reoptimize', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  const body = req.body ?? {};
  try {
    // Reotimizar é o outro caminho por onde entra carga nova numa rota. O que
    // conta é o que o motorista ainda tem de levar: as paradas já resolvidas
    // saíram do veículo, as pendentes somam-se às novas.
    if (Array.isArray(body.new_stops) && body.new_stops.length > 0) {
      const route = await getRoute(req.params.id);
      const pendentes = (route.stops ?? []).filter((stop) => stop.status === 'pending');
      await assertRouteFitsDriver(route.driver_id, [...pendentes, ...body.new_stops]);
    }
    const reoptimized = await reoptimizeRoute(req.params.id, body);
    // As paradas novas entram por aqui e precisam da mesma atribuição que as da
    // criação — caso contrário um pedido acrescentado a meio do turno fica com o
    // motorista sem lhe poder tocar.
    const assignment = await assignRouteOrders(reoptimized);
    res.json({ ...reoptimized, assignment });
  } catch (err) { handleError(err, res); }
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
