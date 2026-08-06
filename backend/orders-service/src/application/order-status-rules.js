/**
 * @file order-status-rules.js
 * @description Transições válidas de status de pedido.
 *
 * Portado de backend/shared/types/src/order-status.enum.ts — o serviço corre em
 * CommonJS sem build step, por isso não importa o .ts diretamente.
 *
 * ⚠️ Se VALID_TRANSITIONS mudar na fonte TS, tem de mudar aqui também. Os testes
 * comparam contra o mesmo vocabulário; uma divergência aparece como transição
 * recusada que devia passar (ou vice-versa).
 */
'use strict';

const { OrderStatus } = require('../domain/sync-event');

/** Espelha VALID_TRANSITIONS de order-status.enum.ts. */
const VALID_TRANSITIONS = Object.freeze({
  [OrderStatus.CREATED]:              [OrderStatus.COLLECTED, OrderStatus.CANCELLED],
  [OrderStatus.COLLECTED]:            [OrderStatus.IN_TRANSIT, OrderStatus.FAILED],
  [OrderStatus.IN_TRANSIT]:           [OrderStatus.AT_WAREHOUSE, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.FAILED],
  [OrderStatus.AT_WAREHOUSE]:         [OrderStatus.AWAITING_DESTINATION, OrderStatus.OUT_FOR_DELIVERY],
  [OrderStatus.AWAITING_DESTINATION]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CANCELLED],
  [OrderStatus.OUT_FOR_DELIVERY]:     [OrderStatus.DELIVERED, OrderStatus.FAILED],
  [OrderStatus.DELIVERED]:            [],
  [OrderStatus.FAILED]:               [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
  [OrderStatus.CANCELLED]:            [],
});

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = { VALID_TRANSITIONS, isValidTransition };
