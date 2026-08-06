/**
 * @file order-status-shim.js
 * @description Shim CommonJS do enum OrderStatus para uso no api-gateway (JS).
 *
 * O enum canônico vive em: backend/shared/types/src/order-status.enum.ts
 * Este arquivo espelha os valores e a função isValidTransition para uso
 * no servidor Express sem compilação TypeScript.
 *
 * REGRA: ao adicionar um novo status, atualizar AMBOS:
 *   1. backend/shared/types/src/order-status.enum.ts
 *   2. Este arquivo
 */
'use strict';

/** @type {Record<string, string>} */
const OrderStatus = Object.freeze({
  CREATED:              'created',
  COLLECTED:            'collected',
  IN_TRANSIT:           'in_transit',
  AT_WAREHOUSE:         'at_warehouse',
  AWAITING_DESTINATION: 'awaiting_destination',
  OUT_FOR_DELIVERY:     'out_for_delivery',
  DELIVERED:            'delivered',
  FAILED:               'failed',
  CANCELLED:            'cancelled',
});

/** @type {Record<string, string[]>} */
const VALID_TRANSITIONS = Object.freeze({
  [OrderStatus.CREATED]:              [OrderStatus.COLLECTED, OrderStatus.CANCELLED],
  [OrderStatus.COLLECTED]:            [OrderStatus.IN_TRANSIT, OrderStatus.FAILED],
  [OrderStatus.IN_TRANSIT]:           [OrderStatus.AT_WAREHOUSE, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.FAILED],
  // DELIVERED a partir do armazém = levantamento ao balcão (spec § 3.23):
  // o cliente vai buscar a encomenda e ela nunca chega a sair para entrega.
  [OrderStatus.AT_WAREHOUSE]:         [OrderStatus.AWAITING_DESTINATION, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  [OrderStatus.AWAITING_DESTINATION]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
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
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

module.exports = { OrderStatus, VALID_TRANSITIONS, isValidTransition };
