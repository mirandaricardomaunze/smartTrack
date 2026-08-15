/**
 * @file event.publisher.js
 * @description Publicação de eventos de domínio financeiro.
 *
 * backend/README.md, regra 3: eventos sempre com `correlation_id` + `timestamp`
 * + `schema_version`.
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md § regra 5 —
 *   eventos financeiros devem incluir order_id, value, gateway e
 *   gateway_transaction_id.
 *
 * NÃO HÁ BROKER, E É DE PROPÓSITO (ADR-002). O sistema é um monólito modular
 * num só processo: não há equipas a publicar umas para as outras nem
 * consumidores independentes, e um Kafka em produção sem nada do outro lado
 * seria um componente a manter sem problema que resolva. O broker chegou a
 * estar declarado no compose de desenvolvimento e foi retirado — ninguém se
 * ligava a ele.
 *
 * O QUE ISTO FAZ: escreve cada evento no log em formato estruturado, com
 * envelope completo. Serve auditoria e depuração do fluxo; NÃO entrega a
 * consumidor nenhum, e quem precisar de reagir a um evento tem de o fazer em
 * processo.
 *
 * Se um dia houver um consumidor externo real, é este envelope que se liga a um
 * produtor — os schemas em backend/shared/events/schemas já assumem esta forma.
 */
'use strict';

const SOURCE_SERVICE = 'payments-service';
const SCHEMA_VERSION = '1.0';

/**
 * Gera um correlation id. Usa randomUUID quando disponível.
 * @returns {string}
 */
function newCorrelationId() {
  const { randomUUID } = require('node:crypto');
  return randomUUID();
}

/**
 * Monta o envelope canônico e "publica".
 *
 * @param {string} eventType
 * @param {object} payload
 * @param {string} [correlationId] Reaproveitado quando o evento continua um fluxo
 * @returns {object} O envelope publicado
 */
function publish(eventType, payload, correlationId) {
  const envelope = {
    eventType,
    schemaVersion: SCHEMA_VERSION,
    correlationId: correlationId ?? newCorrelationId(),
    timestamp:     new Date().toISOString(),
    sourceService: SOURCE_SERVICE,
    payload,
  };

  // Prefixo [event] para ser filtrável no agregador de logs.
  console.info('[event]', JSON.stringify(envelope));

  return envelope;
}

/**
 * @param {object} payment
 * @param {string} [correlationId]
 * @returns {object}
 */
function publishPaymentSucceeded(payment, correlationId) {
  return publish('PAYMENT_SUCCEEDED', {
    paymentId:            payment.id,
    orderId:              payment.order_id,
    value:                payment.value,
    gateway:              payment.gateway,
    gatewayTransactionId: payment.gateway_transaction_id,
    attemptNumber:        payment.attempt_number,
  }, correlationId);
}

/**
 * @param {object} payment
 * @param {string} reason
 * @param {string} [correlationId]
 * @returns {object}
 */
function publishPaymentFailed(payment, reason, correlationId) {
  return publish('PAYMENT_FAILED', {
    paymentId:            payment.id,
    orderId:              payment.order_id,
    value:                payment.value,
    gateway:              payment.gateway,
    gatewayTransactionId: payment.gateway_transaction_id,
    attemptNumber:        payment.attempt_number,
    reason,
  }, correlationId);
}

/**
 * @param {object} payment
 * @param {string} [correlationId]
 * @returns {object}
 */
function publishPaymentRefunded(payment, correlationId) {
  return publish('PAYMENT_REFUNDED', {
    paymentId:            payment.id,
    orderId:              payment.order_id,
    value:                payment.value,
    gateway:              payment.gateway,
    gatewayTransactionId: payment.gateway_transaction_id,
  }, correlationId);
}

module.exports = {
  SOURCE_SERVICE,
  SCHEMA_VERSION,
  publish,
  publishPaymentSucceeded,
  publishPaymentFailed,
  publishPaymentRefunded,
};
