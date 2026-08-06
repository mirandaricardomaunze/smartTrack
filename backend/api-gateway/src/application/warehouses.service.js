/**
 * @file warehouses.service.js
 * @description Camada de aplicação — use cases de Armazéns (gestão dinâmica).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 8.2 (fluxo de armazém)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Auditabilidade dos movimentos)
 *
 * A entrada (intake) e o envio (dispatch) delegam a transição de status ao
 * orders.service (cadeia de hash, isValidTransition, recálculo de rota). Este
 * serviço trata do lado-armazém: cadastro, capacidade, ocupação e o registo
 * auditável dos movimentos.
 */
'use strict';

const crypto = require('crypto');
const { WarehouseRepository, OrderRepository } = require('../infrastructure/pg.repository');
const ordersService = require('./orders.service');
const { MissingRequiredFieldError } = require('./orders.service');
const { assertResourceLimit } = require('./subscriptions.service');
const { sendNotification } = require('../../../notifications-service/src/application/notifications.service');
const { sendClientMessage } = require('../../../notifications-service/src/application/messaging.service');

// ─── Constantes de domínio (espelham warehouse.types.ts) ─────────────────────

const WarehouseStatus = Object.freeze({ ACTIVE: 'active', INACTIVE: 'inactive' });
// 'pickup' = levantado ao balcão pelo cliente (spec § 3.23), distinto de
// 'dispatch', que é a saída para entrega por um motorista.
const MovementType    = Object.freeze({ INTAKE: 'intake', DISPATCH: 'dispatch', PICKUP: 'pickup' });

// ─── Erros de Aplicação ──────────────────────────────────────────────────────

class WarehouseNotFoundError extends Error {
  /** @param {string} idOrCode */
  constructor(idOrCode) {
    super(`Warehouse not found: ${idOrCode}`);
    this.name = 'WarehouseNotFoundError';
    this.statusCode = 404;
  }
}

class DuplicateWarehouseCodeError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`Já existe um armazém com o código "${code}".`);
    this.name = 'DuplicateWarehouseCodeError';
    this.statusCode = 409;
  }
}

class WarehouseInactiveError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`O armazém "${code}" está inativo e não pode receber encomendas.`);
    this.name = 'WarehouseInactiveError';
    this.statusCode = 409;
  }
}

class WarehouseCapacityExceededError extends Error {
  /**
   * @param {string} code
   * @param {number} capacity
   */
  constructor(code, capacity) {
    super(`O armazém "${code}" atingiu a capacidade máxima (${capacity}).`);
    this.name = 'WarehouseCapacityExceededError';
    this.statusCode = 409;
  }
}

class WarehouseHasOrdersError extends Error {
  /**
   * @param {string} code
   * @param {number} occupancy
   */
  constructor(code, occupancy) {
    super(`O armazém "${code}" tem ${occupancy} encomenda(s) e não pode ser desativado.`);
    this.name = 'WarehouseHasOrdersError';
    this.statusCode = 409;
  }
}

class OrderNotInWarehouseError extends Error {
  /**
   * @param {string} trackingCode
   * @param {string} warehouseCode
   */
  constructor(trackingCode, warehouseCode) {
    super(`A encomenda "${trackingCode}" não está no armazém "${warehouseCode}".`);
    this.name = 'OrderNotInWarehouseError';
    this.statusCode = 409;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** @returns {string} */
function generateWarehouseId() {
  return `wh-${crypto.randomUUID()}`;
}

/** @returns {string} */
function generateMovementId() {
  return `wh-mov-${crypto.randomUUID()}`;
}

/** @param {unknown} code @returns {string} */
function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * Constrói o endereço a partir do DTO (aceita campos soltos city/state/country).
 * @param {{ city?: string; state?: string; country?: string }} dto
 * @returns {{ city: string; state: string; country: string }}
 */
function buildAddress(dto) {
  return {
    city:    String(dto.city ?? '').trim(),
    state:   String(dto.state ?? '').trim(),
    country: String(dto.country ?? 'MZ').trim() || 'MZ',
  };
}

/** @param {unknown} lat @param {unknown} lng @returns {boolean} */
function validCoords(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && !Number.isNaN(lat) && !Number.isNaN(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Normaliza e valida a capacidade (inteiro ≥ 0; 0 = ilimitada).
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCapacity(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Resolve uma encomenda por id ou por código de rastreio (nesta ordem).
 * @param {{ order_id?: string; tracking_code?: string }} dto
 * @returns {Promise<object | undefined>}
 */
async function resolveOrder(dto, executor) {
  if (dto.order_id) {
    return OrderRepository.findById(dto.order_id, executor);
  }
  if (dto.tracking_code) {
    return OrderRepository.findByCode(String(dto.tracking_code).trim().toUpperCase(), executor);
  }
  return undefined;
}

// ─── Use Cases — Cadastro ─────────────────────────────────────────────────────

/**
 * Lista todos os armazéns com ocupação/capacidade/utilização derivadas.
 * @returns {Promise<object[]>}
 */
async function listWarehouses() {
  return WarehouseRepository.findAll();
}

/**
 * Busca um armazém por id.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getWarehouse(id) {
  const warehouse = await WarehouseRepository.findById(id);
  if (!warehouse) throw new WarehouseNotFoundError(id);
  return warehouse;
}

/**
 * Resumo agregado para painel/sidebar.
 * @returns {Promise<{ total: number; active: number; storedOrders: number; nearCapacity: number }>}
 */
async function getWarehouseStats() {
  return WarehouseRepository.getStats();
}

/**
 * Cria um novo armazém.
 * @param {{ code: string; name: string; city: string; state?: string; country?: string; capacity?: number; lat?: number; lng?: number }} dto
 * @returns {Promise<object>}
 */
async function createWarehouse(dto) {
  if (!dto || !dto.name || !String(dto.name).trim()) throw new MissingRequiredFieldError('name');
  if (!dto.code || !normalizeCode(dto.code))          throw new MissingRequiredFieldError('code');
  if (!dto.city || !String(dto.city).trim())          throw new MissingRequiredFieldError('city');

  const code = normalizeCode(dto.code);
  if (await WarehouseRepository.findByCode(code)) {
    throw new DuplicateWarehouseCodeError(code);
  }

  // Limite de armazéns do plano (SaaS, spec § 2.5).
  await assertResourceLimit('warehouses');

  const now = new Date().toISOString();
  const lat = Number(dto.lat);
  const lng = Number(dto.lng);

  const warehouse = {
    id:         generateWarehouseId(),
    code,
    name:       String(dto.name).trim(),
    address:    buildAddress(dto),
    capacity:   normalizeCapacity(dto.capacity, 0),
    status:     WarehouseStatus.ACTIVE,
    gps:        validCoords(lat, lng) ? { lat, lng } : undefined,
    created_at: now,
  };

  console.info(`[audit] Warehouse ${warehouse.id} (${code}) created — ${warehouse.name}`);
  return WarehouseRepository.create(warehouse);
}

/**
 * Atualiza campos editáveis de um armazém (merge parcial).
 * @param {string} id
 * @param {object} dto
 * @returns {Promise<object>}
 */
async function updateWarehouse(id, dto) {
  const current = await WarehouseRepository.findById(id);
  if (!current) throw new WarehouseNotFoundError(id);

  let code = current.code;
  if (dto.code != null && normalizeCode(dto.code) !== current.code) {
    code = normalizeCode(dto.code);
    if (!code) throw new MissingRequiredFieldError('code');
    const clash = await WarehouseRepository.findByCode(code);
    if (clash && clash.id !== id) throw new DuplicateWarehouseCodeError(code);
  }

  const lat = Number(dto.lat);
  const lng = Number(dto.lng);
  const hasNewCoords = dto.lat != null && dto.lng != null;

  const status = dto.status === WarehouseStatus.INACTIVE || dto.status === WarehouseStatus.ACTIVE
    ? dto.status
    : current.status;

  const updated = {
    id,
    code,
    name:       dto.name != null ? String(dto.name).trim() : current.name,
    address:    (dto.city != null || dto.state != null || dto.country != null)
      ? buildAddress({
          city:    dto.city    ?? current.address.city,
          state:   dto.state   ?? current.address.state,
          country: dto.country ?? current.address.country,
        })
      : current.address,
    capacity:   dto.capacity != null ? normalizeCapacity(dto.capacity, current.capacity) : current.capacity,
    status,
    gps:        hasNewCoords ? (validCoords(lat, lng) ? { lat, lng } : undefined) : current.gps,
    updated_at: new Date().toISOString(),
  };

  console.info(`[audit] Warehouse ${id} (${code}) updated`);
  await WarehouseRepository.update(updated);
  // Re-busca para devolver a ocupação derivada (RETURNING * não a inclui).
  return WarehouseRepository.findById(id);
}

/**
 * Desativa um armazém. Bloqueia se ainda houver encomendas dentro.
 * @param {string} id
 * @returns {Promise<object>}
 */
async function deactivateWarehouse(id) {
  const warehouse = await WarehouseRepository.findById(id);
  if (!warehouse) throw new WarehouseNotFoundError(id);
  if (warehouse.occupancy > 0) {
    throw new WarehouseHasOrdersError(warehouse.code, warehouse.occupancy);
  }
  console.info(`[audit] Warehouse ${id} (${warehouse.code}) deactivated`);
  await WarehouseRepository.setStatus(id, WarehouseStatus.INACTIVE, new Date().toISOString());
  return WarehouseRepository.findById(id);
}

// ─── Use Cases — Inventário e movimentos ─────────────────────────────────────

/**
 * Encomendas atualmente dentro do armazém (entrada ainda não expedida).
 * @param {string} id
 * @returns {Promise<object[]>}
 */
async function listWarehouseOrders(id) {
  const warehouse = await WarehouseRepository.findById(id);
  if (!warehouse) throw new WarehouseNotFoundError(id);
  return WarehouseRepository.listOrders(id);
}

/**
 * Histórico auditável de movimentos (entrada/envio) do armazém.
 * @param {string} id
 * @returns {Promise<object[]>}
 */
async function listWarehouseMovements(id) {
  const warehouse = await WarehouseRepository.findById(id);
  if (!warehouse) throw new WarehouseNotFoundError(id);
  return WarehouseRepository.listMovements(id);
}

/**
 * Entrada (intake): recebe fisicamente uma encomenda no armazém.
 *
 * Valida armazém ativo e capacidade → delega a transição in_transit→at_warehouse
 * ao orders.service (define warehouse_id) → regista o movimento `intake`.
 *
 * @param {string} warehouseId
 * @param {{ order_id?: string; tracking_code?: string; notes?: string; user_id?: string }} dto
 * @returns {Promise<{ warehouse: object; order: object; movement: object }>}
 */
async function intakeOrder(warehouseId, dto) {
  if (!dto || (!dto.order_id && !dto.tracking_code)) throw new MissingRequiredFieldError('order_id');

  const result = await WarehouseRepository.withTransaction(async (client) => {
    // Bloqueia a linha para duas receções simultâneas não ultrapassarem a capacidade.
    const warehouse = await WarehouseRepository.findById(warehouseId, client, true);
    if (!warehouse) throw new WarehouseNotFoundError(warehouseId);
    if (warehouse.status !== WarehouseStatus.ACTIVE) {
      throw new WarehouseInactiveError(warehouse.code);
    }
    if (warehouse.capacity > 0 && warehouse.occupancy >= warehouse.capacity) {
      throw new WarehouseCapacityExceededError(warehouse.code, warehouse.capacity);
    }

    const order = await resolveOrder(dto, client);
    if (!order) throw new ordersService.OrderNotFoundError(dto.order_id ?? dto.tracking_code);

    const updatedOrder = await ordersService.receiveIntoWarehouse(order.id, {
      warehouse_id: warehouseId,
      location:     warehouse.name,
      notes:        dto.notes,
      event_origin: 'ADMIN',
      user_id:      dto.user_id,
    }, client);

    const movement = await WarehouseRepository.recordMovement({
      id:            generateMovementId(),
      warehouse_id:  warehouseId,
      order_id:      order.id,
      tracking_code: order.tracking_code,
      type:          MovementType.INTAKE,
      notes:         dto.notes,
      user_id:       dto.user_id,
      created_at:    new Date().toISOString(),
    }, client);

    const refreshed = await WarehouseRepository.findById(warehouseId, client);
    return { warehouse: refreshed, order: updatedOrder, movement };
  });

  // Spec § 8.2, passo 2. A receção fica concluída mesmo que o canal push falhe;
  // o módulo de notificações mantém o desfecho (enviada/falhou) no histórico.
  try {
    await sendNotification({
      user_id: result.order.client_id,
      role: 'CLIENT',
      category: 'DESTINATION_REQUEST',
      title: 'Encomenda recebida no armazém',
      body: `A encomenda ${result.order.tracking_code} chegou a ${result.warehouse.name}. Confirme o destino de entrega.`,
      data: {
        orderId: result.order.id,
        trackingCode: result.order.tracking_code,
        warehouseId,
      },
    });
  } catch (err) {
    console.error(`[warehouse.notification] Falha ao registar notificação da encomenda ${result.order.id}:`, err.message);
  }

  // Aviso ao cliente por SMS e email (best-effort; usa os contactos do pedido).
  try {
    const body = `Recebemos a sua encomenda ${result.order.tracking_code} no armazém ${result.warehouse.name}.`;
    await sendClientMessage({
      channels:      ['sms', 'email'],
      to_phone:      result.order.client_phone,
      to_email:      result.order.client_email,
      subject:       'Encomenda recebida no armazém',
      body,
      order_id:      result.order.id,
      tracking_code: result.order.tracking_code,
    });
  } catch (err) {
    console.error(`[warehouse.messaging] Falha ao enviar SMS/email da encomenda ${result.order.id}:`, err.message);
  }

  return result;
}

/**
 * Envio (dispatch): expede uma encomenda do armazém.
 *
 * Verifica que a encomenda pertence a este armazém → delega ao orders.service o
 * fluxo § 8.2 (confirma destino, recalcula rota, limpa warehouse_id, status
 * out_for_delivery) → regista o movimento `dispatch`.
 *
 * @param {string} warehouseId
 * @param {{ order_id?: string; tracking_code?: string; destination: string; notes?: string; lat?: number; lng?: number; user_id?: string }} dto
 * @returns {Promise<{ warehouse: object; order: object; movement: object }>}
 */
async function dispatchOrder(warehouseId, dto) {
  const warehouse = await WarehouseRepository.findById(warehouseId);
  if (!warehouse) throw new WarehouseNotFoundError(warehouseId);

  const order = await resolveOrder(dto ?? {});
  if (!dto || (!dto.order_id && !dto.tracking_code)) throw new MissingRequiredFieldError('order_id');
  if (!order) throw new ordersService.OrderNotFoundError(dto.order_id ?? dto.tracking_code);
  if (order.warehouse_id !== warehouseId) {
    throw new OrderNotInWarehouseError(order.tracking_code, warehouse.code);
  }

  const updatedOrder = await ordersService.requestWarehouseShipment(order.id, {
    destination:  dto.destination,
    notes:        dto.notes,
    lat:          dto.lat,
    lng:          dto.lng,
    event_origin: 'ADMIN',
    user_id:      dto.user_id,
  });

  const movement = await WarehouseRepository.recordMovement({
    id:            generateMovementId(),
    warehouse_id:  warehouseId,
    order_id:      order.id,
    tracking_code: order.tracking_code,
    type:          MovementType.DISPATCH,
    notes:         dto.notes,
    user_id:       dto.user_id,
    created_at:    new Date().toISOString(),
  });

  const refreshed = await WarehouseRepository.findById(warehouseId);
  return { warehouse: refreshed, order: updatedOrder, movement };
}

// ─── Levantamento ao balcão (spec § 3.23) ────────────────────────────────────

/**
 * O cliente vem buscar a encomenda ao armazém.
 *
 * A encomenda tem de estar NESTE armazém — a verificação existe porque o
 * operador procura por código de rastreio e nada garante que o código que leu
 * pertence ao balcão onde está. Entregar o que está noutra unidade seria um erro
 * caro de corrigir.
 *
 * @param {string} warehouseId
 * @param {object} dto `{ order_id | tracking_code, collector_name, collector_document, is_recipient, relationship, authorization, otp, signature, photo, cod_method, notes, user_id }`
 */
async function pickupOrder(warehouseId, dto = {}) {
  const warehouse = await WarehouseRepository.findById(warehouseId);
  if (!warehouse) throw new WarehouseNotFoundError(warehouseId);

  if (!dto.order_id && !dto.tracking_code) throw new MissingRequiredFieldError('tracking_code');
  const order = await resolveOrder(dto);
  if (!order) throw new ordersService.OrderNotFoundError(dto.order_id ?? dto.tracking_code);
  if (order.warehouse_id !== warehouseId) {
    throw new OrderNotInWarehouseError(order.tracking_code, warehouse.code);
  }

  const updatedOrder = await ordersService.pickupOrder(order.id, dto);

  const movement = await WarehouseRepository.recordMovement({
    id:            generateMovementId(),
    warehouse_id:  warehouseId,
    order_id:      order.id,
    tracking_code: order.tracking_code,
    type:          MovementType.PICKUP,
    notes:         dto.notes ?? `Levantado por ${updatedOrder.pod?.pickup?.name ?? 'cliente'}`,
    user_id:       dto.user_id,
    created_at:    new Date().toISOString(),
  });

  const refreshed = await WarehouseRepository.findById(warehouseId);
  return { warehouse: refreshed, order: updatedOrder, movement };
}

module.exports = {
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
  // Erros exportados para uso no controller
  WarehouseNotFoundError,
  DuplicateWarehouseCodeError,
  WarehouseInactiveError,
  WarehouseCapacityExceededError,
  WarehouseHasOrdersError,
  OrderNotInWarehouseError,
};
