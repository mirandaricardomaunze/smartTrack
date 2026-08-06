/**
 * @file settlements.service.js
 * @description Camada de aplicação — acerto de caixa do motorista (COD).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.5 (Pagamentos / COD)
 *
 * Um acerto junta as cobranças COD `collected` (por acertar) de um motorista,
 * calcula o esperado em numerário (CASH) e em mobile money (informativo), e
 * reconcilia com o numerário efetivamente entregue — registando a diferença.
 * Valores em centavos inteiros (MZN).
 */
'use strict';

const crypto = require('crypto');
const { SettlementRepository } = require('../infrastructure/pg.repository');
const { MissingRequiredFieldError } = require('./orders.service');

const CASH_METHOD = 'CASH';

// ─── Erros de Aplicação ──────────────────────────────────────────────────────

class SettlementNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Acerto não encontrado: ${id}`);
    this.name = 'SettlementNotFoundError';
    this.statusCode = 404;
  }
}

class NoCodToSettleError extends Error {
  /** @param {string} driverId */
  constructor(driverId) {
    super(`Sem cobranças COD por acertar para o motorista "${driverId}".`);
    this.name = 'NoCodToSettleError';
    this.statusCode = 409;
  }
}

class SettlementAlreadyReconciledError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`O acerto "${id}" já foi reconciliado.`);
    this.name = 'SettlementAlreadyReconciledError';
    this.statusCode = 409;
  }
}

class InvalidAmountError extends Error {
  constructor() {
    super('Valor inválido: use um número inteiro de centavos ≥ 0.');
    this.name = 'InvalidAmountError';
    this.statusCode = 400;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** @returns {string} */
function generateSettlementId() {
  return `stl-${crypto.randomUUID()}`;
}

/** @param {unknown} v @returns {boolean} */
function isValidCents(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

/**
 * Soma o COD recolhido de uma lista de pedidos, separando numerário de mobile.
 * @param {object[]} orders
 * @returns {{ cash: number; mobile: number; total: number }}
 */
function sumCod(orders) {
  let cash = 0;
  let mobile = 0;
  for (const o of orders) {
    const amount = Number(o.cod?.amount ?? 0);
    if (o.cod?.method === CASH_METHOD) cash += amount;
    else mobile += amount;
  }
  return { cash, mobile, total: cash + mobile };
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/**
 * Lista acertos (todos ou de um motorista).
 * @param {{ driver_id?: string }} [filtros]
 * @returns {Promise<object[]>}
 */
async function listSettlements(filtros = {}) {
  return filtros.driver_id
    ? SettlementRepository.findByDriver(filtros.driver_id)
    : SettlementRepository.findAll();
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getSettlement(id) {
  const s = await SettlementRepository.findById(id);
  if (!s) throw new SettlementNotFoundError(id);
  return s;
}

/** @returns {Promise<object>} */
async function getSettlementStats() {
  return SettlementRepository.getStats();
}

/**
 * COD recolhido e por acertar de um motorista (com resumo).
 * @param {string} driverId
 * @returns {Promise<{ driver_id: string; order_count: number; expected_cash_cents: number; expected_mobile_cents: number; expected_total_cents: number; orders: object[] }>}
 */
async function listDriverCod(driverId) {
  const orders = await SettlementRepository.listCollectedUnsettledByDriver(driverId);
  const sums = sumCod(orders);
  return {
    driver_id: driverId,
    order_count: orders.length,
    expected_cash_cents:   sums.cash,
    expected_mobile_cents: sums.mobile,
    expected_total_cents:  sums.total,
    orders,
  };
}

/**
 * Abre um acerto de caixa para um motorista: junta o COD `collected` por acertar,
 * calcula o esperado e marca os pedidos como `settled` (transação no repositório).
 *
 * @param {string} driverId
 * @param {{ user_id?: string }} [dto]
 * @returns {Promise<object>} Acerto criado
 */
async function openSettlement(driverId, dto = {}) {
  if (!driverId) throw new MissingRequiredFieldError('driver_id');

  const orders = await SettlementRepository.listCollectedUnsettledByDriver(driverId);
  if (orders.length === 0) throw new NoCodToSettleError(driverId);

  const sums = sumCod(orders);
  const settlement = {
    id:                    generateSettlementId(),
    driver_id:             driverId,
    order_count:           orders.length,
    expected_cash_cents:   sums.cash,
    expected_mobile_cents: sums.mobile,
    expected_total_cents:  sums.total,
    opened_by:             dto.user_id,
    opened_at:             new Date().toISOString(),
  };
  const orderIds = orders.map((o) => o.id);

  console.info(`[audit] Acerto ${settlement.id} aberto p/ ${driverId}: ${orders.length} pedido(s), numerário esperado ${sums.cash}c.`);
  return SettlementRepository.openForDriver(settlement, orderIds);
}

/**
 * Reconcilia um acerto com o numerário entregue pelo motorista.
 *
 * @param {string} id
 * @param {{ received_cash_cents: number; notes?: string; user_id?: string }} dto
 * @returns {Promise<object>} Acerto reconciliado
 */
async function reconcileSettlement(id, dto) {
  const s = await SettlementRepository.findById(id);
  if (!s) throw new SettlementNotFoundError(id);
  if (s.status === 'reconciled') throw new SettlementAlreadyReconciledError(id);

  if (dto == null || dto.received_cash_cents == null) throw new MissingRequiredFieldError('received_cash_cents');
  if (!isValidCents(dto.received_cash_cents)) throw new InvalidAmountError();

  const received   = Number(dto.received_cash_cents);
  const difference = received - s.expected_cash_cents;
  const now        = new Date().toISOString();

  const updated = {
    ...s,
    status:              'reconciled',
    received_cash_cents: received,
    difference_cents:    difference,
    notes:               dto.notes ? String(dto.notes).trim() : null,
    reconciled_by:       dto.user_id ?? null,
    reconciled_at:       now,
  };

  console.info(`[audit] Acerto ${id} reconciliado: recebido ${received}c vs esperado ${s.expected_cash_cents}c (diferença ${difference}c).`);
  return SettlementRepository.update(updated);
}

module.exports = {
  listSettlements,
  getSettlement,
  getSettlementStats,
  listDriverCod,
  openSettlement,
  reconcileSettlement,
  // Erros exportados para uso no controller
  SettlementNotFoundError,
  NoCodToSettleError,
  SettlementAlreadyReconciledError,
  InvalidAmountError,
};
