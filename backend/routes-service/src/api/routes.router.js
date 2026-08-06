/**
 * @file routes.router.js
 * @description Router Express para o recurso /routes.
 *
 * Single Responsibility: mapear HTTP req/res → casos de uso da aplicação.
 *
 * NOTA: este serviço NÃO faz autenticação. Conforme a regra 1 de
 * backend/README.md, ele nunca é exposto diretamente — quem autentica e aplica
 * RBAC é o api-gateway, que faz proxy para cá. Em produção este processo deve
 * estar em rede privada, inacessível a partir do exterior.
 *
 * Endpoints:
 *   GET   /routes                      — Lista rotas (filtro opcional ?driver_id=)
 *   GET   /routes/stats                — Contagens por status
 *   POST  /routes/optimize             — Pré-visualiza otimização (não persiste)
 *   POST  /routes                      — Cria rota otimizada
 *   GET   /routes/:id                  — Detalhe de uma rota
 *   POST  /routes/:id/reoptimize       — Reotimiza (spec § 3.2)
 *   PUT   /routes/:id/status           — Transita status da rota
 *   PUT   /routes/:id/stops/:orderId   — Marca resultado de uma parada
 */
'use strict';

const { Router } = require('express');
const {
  listRoutes,
  getRoute,
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
} = require('../application/routes.service');

const router = Router();

/** Tratamento de erros tipados — mesmo padrão dos routers do api-gateway. */
function handleError(err, res) {
  const known = [
    RouteNotFoundError,
    MissingRequiredFieldError,
    EmptyRouteError,
    InvalidRouteTransitionError,
  ];

  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);
  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  console.error('[routes.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /routes ──────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    res.json(await listRoutes({ driver_id: req.query.driver_id }));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /routes/stats ────────────────────────────────────────────────────────
// IMPORTANTE: deve vir ANTES de /:id para não ser capturada como parâmetro.
router.get('/stats', async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /routes/optimize ────────────────────────────────────────────────────
// Puro: calcula e devolve a ordem ótima sem tocar na base de dados.
router.post('/optimize', (req, res) => {
  try {
    res.json(previewOptimization(req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /routes ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const rota = await createRoute(req.body ?? {});
    res.status(201).json(rota);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /routes/:id ──────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    res.json(await getRoute(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /routes/:id/reoptimize ──────────────────────────────────────────────
router.post('/:id/reoptimize', async (req, res) => {
  try {
    res.json(await reoptimizeRoute(req.params.id, req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── PUT /routes/:id/status ───────────────────────────────────────────────────
router.put('/:id/status', async (req, res) => {
  try {
    res.json(await updateRouteStatus(req.params.id, req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── PUT /routes/:id/stops/:orderId ───────────────────────────────────────────
router.put('/:id/stops/:orderId', async (req, res) => {
  try {
    res.json(await updateStopStatus(req.params.id, req.params.orderId, req.body ?? {}));
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
