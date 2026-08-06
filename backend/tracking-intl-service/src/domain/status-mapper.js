/**
 * @file status-mapper.js
 * @description Normalização de status de transportadoras internacionais.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 8.3
 * Skill ref: .agents/skills/order-status-mapper/SKILL.md
 *
 * REGRA CENTRAL (order-status.enum.ts):
 *   "Status externos SEMPRE mapeados via StatusMapper antes de persistir um
 *    EventoRastreio."
 *
 * Portado de status-mapper.ts — o backend corre em CommonJS sem build step.
 * As mensagens de aviso são verificadas pelos testes; não as alterar sem
 * atualizar status-mapper.spec.js.
 *
 * FALLBACK: qualquer coisa desconhecida vira IN_TRANSIT e emite aviso. Nunca
 * inventar um status nem deixar passar o valor cru — um status errado no
 * histórico do cliente é pior do que um genérico.
 */
'use strict';

/** Espelha OrderStatus de backend/shared/types/src/order-status.enum.ts */
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

/** Transportadoras com mapeamento conhecido. */
const CARRIER_MAPS = Object.freeze({
  '17TRACK': Object.freeze({
    // Strings legíveis (usadas pelo simulador de desenvolvimento).
    'Delivered':            OrderStatus.DELIVERED,
    'In Transit':           OrderStatus.IN_TRANSIT,
    'Out for Delivery':     OrderStatus.OUT_FOR_DELIVERY,
    'Arrived at warehouse': OrderStatus.AT_WAREHOUSE,
    'Picked up':            OrderStatus.COLLECTED,
    'Delivery failed':      OrderStatus.FAILED,
    'Returned to sender':   OrderStatus.CANCELLED,
    // Vocabulário REAL da API 17TRACK v2.2 (campo `stage` de cada evento).
    // Ref: estados de pacote do 17TRACK. Mantidos aqui porque o raw_status do
    // cliente real (track17.client.js) é o `stage` cru — normalizado uma vez.
    'InfoReceived':         OrderStatus.CREATED,
    'PickedUp':             OrderStatus.COLLECTED,
    'InTransit':            OrderStatus.IN_TRANSIT,
    'AvailableForPickup':   OrderStatus.AT_WAREHOUSE,
    'OutForDelivery':       OrderStatus.OUT_FOR_DELIVERY,
    'DeliveryFailure':      OrderStatus.FAILED,
    'Exception':            OrderStatus.FAILED,
    'Returning':            OrderStatus.CANCELLED,
    'Returned':             OrderStatus.CANCELLED,
  }),
  'CAINIAO': Object.freeze({
    'PACKAGE_ARRIVED':    OrderStatus.AT_WAREHOUSE,
    'PACKAGE_DELIVERING': OrderStatus.OUT_FOR_DELIVERY,
    'SIGN_IN':            OrderStatus.DELIVERED,
    'FAILED_ATTEMPT':     OrderStatus.FAILED,
  }),
  'CORREIOS_BR': Object.freeze({
    'Objeto entregue ao destinatário':              OrderStatus.DELIVERED,
    'Objeto em transferência - por favor aguarde':  OrderStatus.IN_TRANSIT,
    'Objeto saiu para entrega ao destinatário':     OrderStatus.OUT_FOR_DELIVERY,
  }),
});

/** Status devolvido quando não há mapeamento — nunca inventar outro. */
const FALLBACK_STATUS = OrderStatus.IN_TRANSIT;

/**
 * Emite alerta de observabilidade: transportadora sem mapeamento nenhum.
 * @param {string} carrier
 * @param {string} raw
 */
function logUnknownCarrier(carrier, raw) {
  console.warn(`[StatusMapper] Alerta: Carrier desconhecido "${carrier}" com status "${raw}"`);
}

/**
 * Emite métrica: transportadora conhecida mas status novo.
 * É o sinal de que a transportadora mudou o vocabulário e o mapa precisa de
 * ser atualizado — daí ser um aviso distinto do anterior.
 * @param {string} carrier
 * @param {string} raw
 */
function logUnknownStatus(carrier, raw) {
  console.warn(`[StatusMapper] Status desconhecido "${raw}" para o carrier "${carrier}"`);
}

const StatusMapper = {
  /**
   * Traduz um status cru de transportadora para o vocabulário canônico.
   *
   * @param {string} carrier
   * @param {string} rawStatus
   * @returns {string} OrderStatus
   */
  map(carrier, rawStatus) {
    const mapa = CARRIER_MAPS[carrier];

    if (!mapa) {
      logUnknownCarrier(carrier, rawStatus);
      return FALLBACK_STATUS;
    }

    const mapeado = mapa[rawStatus];

    if (!mapeado) {
      logUnknownStatus(carrier, rawStatus);
      return FALLBACK_STATUS;
    }

    return mapeado;
  },

  /**
   * @param {string} carrier
   * @returns {boolean}
   */
  isKnownCarrier(carrier) {
    return Object.prototype.hasOwnProperty.call(CARRIER_MAPS, carrier);
  },

  /** @returns {string[]} */
  knownCarriers() {
    return Object.keys(CARRIER_MAPS);
  },
};

module.exports = {
  OrderStatus,
  CARRIER_MAPS,
  FALLBACK_STATUS,
  StatusMapper,
};
