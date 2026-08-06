/**
 * @file warehouses.router.js
 * @description Router Express para o recurso /v1/warehouses (gestão dinâmica de armazéns).
 *
 * Single Responsibility: mapear HTTP req/res → use cases da aplicação.
 *
 * Endpoints:
 *   GET    /v1/warehouses               — Lista armazéns com ocupação (admin/suporte)
 *   GET    /v1/warehouses/stats         — Resumo agregado (sidebar/painel)
 *   POST   /v1/warehouses               — Cria um armazém (admin)
 *   GET    /v1/warehouses/:id           — Detalhe de um armazém
 *   PUT    /v1/warehouses/:id           — Atualiza um armazém (admin)
 *   DELETE /v1/warehouses/:id           — Desativa um armazém (admin)
 *   GET    /v1/warehouses/:id/orders    — Encomendas atualmente dentro (entrada)
 *   GET    /v1/warehouses/:id/movements — Histórico de movimentos (auditoria)
 *   POST   /v1/warehouses/:id/intake    — Registar entrada de uma encomenda
 *   POST   /v1/warehouses/:id/dispatch  — Expedir (envio) de uma encomenda
 *   POST   /v1/warehouses/:id/pickup    — Levantamento ao balcão pelo cliente
 */
'use strict';

const { Router } = require('express');
const {
  listWarehouses,
  getWarehouse,
  getWarehouseStats,
  createWarehouse,
  updateWarehouse,
  deactivateWarehouse,
  listWarehouseOrders,
  listWarehouseMovements,
  intakeOrder,
  dispatchOrder,
  pickupOrder,
  WarehouseNotFoundError,
  DuplicateWarehouseCodeError,
  WarehouseInactiveError,
  WarehouseCapacityExceededError,
  WarehouseHasOrdersError,
  OrderNotInWarehouseError,
} = require('../application/warehouses.service');
const audit = require('../application/audit.service');

const {
  OrderNotFoundError,
  InvalidStatusTransitionError,
  MissingRequiredFieldError,
  WarehouseActionError,
} = require('../application/orders.service');

const {
  requireAuth,
  requireRoles,
  UnauthorizedError,
  ForbiddenError,
} = require('../application/auth.service');

const router = Router();

/** Middleware de tratamento de erros tipados. */
function handleError(err, res) {
  const known = [
    WarehouseNotFoundError,
    DuplicateWarehouseCodeError,
    WarehouseInactiveError,
    WarehouseCapacityExceededError,
    WarehouseHasOrdersError,
    OrderNotInWarehouseError,
    OrderNotFoundError,
    InvalidStatusTransitionError,
    MissingRequiredFieldError,
    WarehouseActionError,
    UnauthorizedError,
    ForbiddenError,
  ];

  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);
  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  // Limite do plano (SaaS, spec § 2.5) — 402 com o código para a UI reagir.
  if (err.statusCode === 402) {
    return res.status(402).json({ error: err.message, code: err.name });
  }

  console.error('[warehouses.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /v1/warehouses ───────────────────────────────────────────────────────
router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (_req, res) => {
  try {
    res.json(await listWarehouses());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/warehouses/stats ─────────────────────────────────────────────────
// IMPORTANTE: esta rota deve vir ANTES de /:id para não ser capturada como parâmetro.
router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try {
    res.json(await getWarehouseStats());
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/warehouses ──────────────────────────────────────────────────────
router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const warehouse = await createWarehouse(req.body);
    res.status(201).json(warehouse);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/warehouses/:id ───────────────────────────────────────────────────
router.get('/:id', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    res.json(await getWarehouse(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── PUT /v1/warehouses/:id ───────────────────────────────────────────────────
router.put('/:id', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    res.json(await updateWarehouse(req.params.id, req.body));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── DELETE /v1/warehouses/:id ────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    res.json(await deactivateWarehouse(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/warehouses/:id/orders ────────────────────────────────────────────
router.get('/:id/orders', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    res.json(await listWarehouseOrders(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/warehouses/:id/movements ─────────────────────────────────────────
router.get('/:id/movements', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    res.json(await listWarehouseMovements(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/warehouses/:id/intake ───────────────────────────────────────────
router.post('/:id/intake', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    const result = await intakeOrder(req.params.id, { ...req.body, user_id: req.user.sub });
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/warehouses/:id/dispatch ─────────────────────────────────────────
router.post('/:id/dispatch', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    const result = await dispatchOrder(req.params.id, { ...req.body, user_id: req.user.sub });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/warehouses/:id/pickup ───────────────────────────────────────────
// Levantamento ao balcão (spec § 3.23): o cliente — ou um terceiro autorizado —
// vem buscar a encomenda. Termina o pedido como entregue, sem passar por rota.
router.post('/:id/pickup', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    const result = await pickupOrder(req.params.id, { ...req.body, user_id: req.user.sub });

    await audit.recordFromRequest(req, {
      action: 'warehouses.pickup',
      summary: `${req.user?.email ?? 'operador'} entregou ${result.order.tracking_code} ao balcão a ${result.order.pod?.pickup?.name}`,
      entity_type: 'order', entity_id: result.order.id, entity_label: result.order.tracking_code,
      metadata: {
        warehouse: result.warehouse?.code,
        collector: result.order.pod?.pickup?.name,
        document: result.order.pod?.pickup?.document,
        is_recipient: result.order.pod?.pickup?.is_recipient,
        relationship: result.order.pod?.pickup?.relationship,
        // NÃO chamar a este campo `authorization`: a redação do registo oculta
        // chaves que parecem credenciais (cabeçalho Authorization) e apagava
        // justamente a prova de quem autorizou o levantamento.
        authorized_how: result.order.pod?.pickup?.authorization,
        cod_cents: result.order.cod?.amount,
      },
    });

    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
