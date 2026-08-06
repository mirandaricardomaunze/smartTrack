/**
 * @file sync-event.js
 * @description Validação e normalização de eventos de sincronização offline.
 *
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md § Sync Service Interface
 *
 * REGRAS DA SKILL:
 * - Processar sempre por `device_timestamp ASC` (regra 2). Um evento offline mais
 *   antigo tem de ser aplicado antes de um mais novo, ou o estado final fica errado.
 * - O sync deve ser idempotente (regra 5): reenviar o mesmo evento não pode
 *   duplicar nada — daí a chave determinística.
 *
 * NOTA DE VOCABULÁRIO:
 * O app do motorista envia status em pt-BR (`coletado`, `entregue`, ...), como
 * se vê em tests/harness/fixtures/offline-events-batch.json. O domínio canônico
 * é em inglês (order-status.enum.ts). A tradução acontece aqui, uma única vez,
 * antes de qualquer decisão de transição.
 */
'use strict';

const { createHash } = require('node:crypto');

class MissingRequiredFieldError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Campo obrigatório em falta: ${field}`);
    this.name = 'MissingRequiredFieldError';
    this.statusCode = 400;
  }
}

/** Vocabulário canônico — espelha OrderStatus de shared/types. */
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

/**
 * Tradução pt-BR → canônico. As chaves são exatamente os valores que o app do
 * motorista envia (ver o fixture offline-events-batch.json).
 */
const PT_TO_CANONICAL = Object.freeze({
  criado:             OrderStatus.CREATED,
  coletado:           OrderStatus.COLLECTED,
  em_transito:        OrderStatus.IN_TRANSIT,
  no_armazem:         OrderStatus.AT_WAREHOUSE,
  aguardando_destino: OrderStatus.AWAITING_DESTINATION,
  saiu_para_entrega:  OrderStatus.OUT_FOR_DELIVERY,
  entregue:           OrderStatus.DELIVERED,
  insucesso:          OrderStatus.FAILED,
  cancelado:          OrderStatus.CANCELLED,
});

/**
 * Traduz um status para canônico. Aceita já-canônicos (idempotente) e pt-BR.
 *
 * @param {string} status
 * @returns {string|null} null se não for reconhecível
 */
function toCanonicalStatus(status) {
  if (!status) return null;

  // Já canônico? (o app pode evoluir para enviar em inglês)
  if (Object.values(OrderStatus).includes(status)) return status;

  return PT_TO_CANONICAL[status] ?? null;
}

/**
 * Chave determinística de um evento, para deduplicação idempotente (regra 5).
 *
 * Inclui `device_id` e `device_timestamp`: o mesmo motorista não gera dois
 * eventos distintos no mesmo instante do mesmo dispositivo, mas dois envios do
 * mesmo evento partilham exatamente estes campos.
 *
 * @param {object} evt
 * @returns {string}
 */
function buildDedupeKey(evt) {
  const material = [
    evt.order_id,
    evt.event_type,
    evt.device_id ?? '',
    evt.device_timestamp,
  ].join('|');

  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Valida a forma de um evento de sync.
 *
 * @param {object} evt
 * @param {number} index Posição no lote, para mensagens de erro
 */
function validateSyncEvent(evt, index) {
  if (!evt || typeof evt !== 'object') throw new MissingRequiredFieldError(`events[${index}]`);
  if (!evt.order_id)         throw new MissingRequiredFieldError(`events[${index}].order_id`);
  if (!evt.event_type)       throw new MissingRequiredFieldError(`events[${index}].event_type`);
  if (!evt.device_timestamp) throw new MissingRequiredFieldError(`events[${index}].device_timestamp`);
}

/**
 * Ordena eventos por device_timestamp ASC (regra 2 da skill).
 * Devolve novo array. Empates preservam a ordem de chegada (estável).
 *
 * @param {object[]} eventos
 * @returns {object[]}
 */
function sortChronological(eventos) {
  return eventos
    .map((evt, i) => ({ evt, i }))
    .sort((a, b) => {
      const diff = Date.parse(a.evt.device_timestamp) - Date.parse(b.evt.device_timestamp);
      return diff !== 0 ? diff : a.i - b.i;
    })
    .map(({ evt }) => evt);
}

module.exports = {
  OrderStatus,
  PT_TO_CANONICAL,
  MissingRequiredFieldError,
  toCanonicalStatus,
  buildDedupeKey,
  validateSyncEvent,
  sortChronological,
};
