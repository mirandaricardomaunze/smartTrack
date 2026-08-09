/**
 * @file orders.router.js
 * @description Router Express para o recurso /v1/orders (em Inglês).
 *
 * Endpoints:
 *   GET  /v1/orders                 — Lista todos os pedidos (admin)
 *   GET  /v1/orders/stats           — Contagens por status (useSidebarStats)
 *   POST /v1/orders                 — Cria um novo pedido
 *   GET  /v1/orders/:code/status    — Rastreamento público por código
 *   PUT  /v1/orders/:id/status      — Atualiza status (motorista/admin)
 */
'use strict';

const { Router } = require('express');
const {
  listOrders,
  createOrder,
  getOrderTracking,
  getPodImages,
  getPodImagesByCode,
  getDriverOrder,
  updateOrderStatus,
  requestWarehouseShipment,
  requestShipmentByCode,
  deliverOrder,
  failDelivery,
  requestDeliveryOtp,
  OrderNotFoundError,
  InvalidStatusTransitionError,
  InvalidTrackingCodeError,
  MissingRequiredFieldError,
  WarehouseActionError,
  WarehouseIntakeRequiredError,
  DeliveryStateError,
  PodTooLargeError,
  InvalidDeliveryFailureReasonError,
  NoContactForOtpError,
  OtpInvalidError,
  OtpExpiredError,
  OtpMaxAttemptsError,
  // Reagendamento e devolução (§ 3.37)
  rescheduleDelivery,
  startReturn,
  confirmReturn,
  RescheduleError,
  ReturnStateError,
} = require('../application/orders.service');

const { OrderRepository } = require('../infrastructure/pg.repository');

const {
  requireAuth,
  requireRoles,
  requireResourceOwnerOrRoles,
  UnauthorizedError,
  ForbiddenError,
} = require('../application/auth.service');

const router = Router();
const requireAssignedDriver = requireResourceOwnerOrRoles(
  ['ADMIN'],
  (id) => OrderRepository.findById(id),
  'driver_id',
);

/** Middleware de tratamento de erros tipados */
function handleError(err, res) {
  const known = [
    OrderNotFoundError,
    InvalidStatusTransitionError,
    InvalidTrackingCodeError,
    MissingRequiredFieldError,
    WarehouseActionError,
    WarehouseIntakeRequiredError,
    DeliveryStateError,
    PodTooLargeError,
    InvalidDeliveryFailureReasonError,
    NoContactForOtpError,
    OtpInvalidError,
    OtpExpiredError,
    OtpMaxAttemptsError,
    RescheduleError,
    ReturnStateError,
    UnauthorizedError,
    ForbiddenError,
  ];

  const isKnown = known.some((ErrorClass) => err instanceof ErrorClass);
  if (isKnown) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }

  // Quota/subscrição (SaaS, spec § 2.5): 402 com o código para a UI reagir
  // (banner "Plano & Uso" em vez de um erro genérico).
  if (err.statusCode === 402) {
    return res.status(402).json({ error: err.message, code: err.name });
  }

  console.error('[orders.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── GET /v1/orders ───────────────────────────────────────────────────────────
// Paginada e filtrada no servidor (spec § 3.1): devolve `{ items, total, page, pageSize }`.
router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    res.json(await listOrders({
      page: req.query.page,
      pageSize: req.query.pageSize,
      status: req.query.status,
      search: req.query.search,
      driver_id: req.query.driver_id,
      warehouse_id: req.query.warehouse_id,
      cod_status: req.query.cod_status,
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/orders/stats ─────────────────────────────────────────────────────
router.get('/stats', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try {
    const stats = await OrderRepository.getStats();
    res.json(stats);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders ──────────────────────────────────────────────────────────
router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    // Body DTO format: { tracking_code, client, destination, value }
    const order = await createOrder(req.body);
    res.status(201).json(order);
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/:id/driver-view', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireAssignedDriver, async (req, res) => {
  try {
    res.json(await getDriverOrder(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/orders/:id/pod ───────────────────────────────────────────────────
// Imagens do comprovativo, sob pedido (spec § 3.28). Ficam fora da listagem de
// propósito: são o objeto mais pesado do sistema e ninguém as quer 25 de cada vez.
router.get('/:id/pod', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    res.json(await getPodImages(req.params.id));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/orders/:code/status ──────────────────────────────────────────────
router.get('/:code/status', async (req, res) => {
  try {
    const order = await getOrderTracking(req.params.code);
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/orders/:code/status/pod ──────────────────────────────────────────
// Equivalente público, para o portal de rastreio do cliente. Mantém a visibilidade
// que a prova sempre teve neste ecrã — o que muda é só o momento em que é carregada.
router.get('/:code/status/pod', async (req, res) => {
  try {
    res.json(await getPodImagesByCode(req.params.code));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:code/request-shipment ───────────────────────────────────
// Fluxo do CLIENTE (spec § 8.2): confirma o destino pelo código de rastreio, sem
// login — equivalente ao "link de confirmação" da spec. Mesma lógica do operador.
router.post('/:code/request-shipment', async (req, res) => {
  try {
    const order = await requestShipmentByCode(req.params.code, req.body);
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── PUT /v1/orders/:id/status ────────────────────────────────────────────────
router.put('/:id/status', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireAssignedDriver, async (req, res) => {
  try {
    const order = await updateOrderStatus(req.params.id, {
      ...req.body,
      event_origin: req.user.role === 'DRIVER' ? 'DRIVER' : 'ADMIN',
      user_id: req.user.sub,
    });
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/warehouse/dispatch ───────────────────────────────────
// Spec § 8.2: solicitar envio ao chegar no armazém (confirma destino → saída p/ entrega)
router.post('/:id/warehouse/dispatch', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    const order = await requestWarehouseShipment(req.params.id, {
      ...req.body,
      event_origin: 'ADMIN',
      user_id: req.user.sub,
    });
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/deliver ──────────────────────────────────────────────
// Spec § 3.1: regista a entrega com comprovativo (POD) — nome/assinatura/foto.
router.post('/:id/deliver', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireAssignedDriver, async (req, res) => {
  try {
    const order = await deliverOrder(req.params.id, {
      ...req.body,
      event_origin: req.user.role === 'DRIVER' ? 'DRIVER' : 'ADMIN',
      user_id: req.user.sub,
    });
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/delivery-otp ─────────────────────────────────────────
// Spec § 3.1/§3.3: gera um código de entrega e envia-o ao cliente por SMS.
router.post('/:id/delivery-otp', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireAssignedDriver, async (req, res) => {
  try {
    const result = await requestDeliveryOtp(req.params.id, { user_id: req.user.sub });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/delivery-failure ─────────────────────────────────────
// Spec § 3.1: regista o insucesso de uma tentativa de entrega, com motivo.
router.post('/:id/delivery-failure', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireAssignedDriver, async (req, res) => {
  try {
    const order = await failDelivery(req.params.id, {
      ...req.body,
      event_origin: req.user.role === 'DRIVER' ? 'DRIVER' : 'ADMIN',
      user_id: req.user.sub,
    });
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/reschedule ───────────────────────────────────────────
// Spec § 3.37: marca nova tentativa, com a data acordada com o destinatário.
// O motorista pode reagendar: é ele que está à porta a combinar a nova data, e
// obrigar a passar pelo painel faria a informação chegar tarde ou não chegar.
router.post('/:id/reschedule', requireAuth, requireRoles(['ADMIN', 'SUPPORT', 'DRIVER']), requireAssignedDriver, async (req, res) => {
  try {
    const order = await rescheduleDelivery(req.params.id, {
      ...req.body,
      event_origin: req.user.role === 'DRIVER' ? 'DRIVER' : 'ADMIN',
      user_id: req.user.sub,
    });
    res.json(order);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/return ───────────────────────────────────────────────
// Spec § 3.37: desiste-se da entrega e a encomenda volta ao remetente.
// Só ADMIN/SUPPORT: desistir de entregar tem consequência comercial (o COD não
// é cobrado, pode haver nota de crédito) e não é decisão de quem está na rua.
router.post('/:id/return', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    res.json(await startReturn(req.params.id, { ...req.body, user_id: req.user.sub }));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/orders/:id/return/confirm ───────────────────────────────────────
// Spec § 3.37: a encomenda chegou de volta — quem a recebeu e quando.
router.post('/:id/return/confirm', requireAuth, requireRoles(['ADMIN', 'SUPPORT', 'DRIVER']), async (req, res) => {
  try {
    res.json(await confirmReturn(req.params.id, {
      ...req.body,
      event_origin: req.user.role === 'DRIVER' ? 'DRIVER' : 'ADMIN',
      user_id: req.user.sub,
    }));
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
