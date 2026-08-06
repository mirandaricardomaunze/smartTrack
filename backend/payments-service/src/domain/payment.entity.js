/**
 * @file payment.entity.js
 * @description Entidade de domínio Pagamento.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Pagamento)
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md
 *
 * REGRAS DE DOMÍNIO (da skill):
 * - Montantes SEMPRE em centavos inteiros. Nunca float. R$ 29,90 = 2990.
 * - `idempotency_key` = `${order_id}:charge:${attempt_number}`.
 * - `attempt_number` é 1-indexed e só incrementa após falha DEFINITIVA.
 * - Toda mudança de status passa por `isValidPaymentTransition()`.
 * - Funções puras: nunca mutam o argumento, devolvem novo objeto.
 *
 * NOTA DE NOMENCLATURA:
 * O runtime deste repo é em inglês (api-gateway, routes-service, e a factory
 * tests/harness/factories/payment.factory.ts usam `order_id` / `value`).
 * backend/shared/types/src/payment.types.ts ainda declara `pedido_id` / `valor`
 * em português — divergência conhecida, resolvida aqui a favor do inglês para
 * ficar consistente com o que corre de facto.
 */
'use strict';

/** Vocabulário canônico — espelha PaymentStatus de shared/types. */
const PaymentStatus = Object.freeze({
  PENDING:    'pending',
  PROCESSING: 'processing',
  SUCCEEDED:  'succeeded',
  FAILED:     'failed',
  REFUNDED:   'refunded',
  CANCELLED:  'cancelled',
});

/** Gateways suportados — espelha PaymentGateway de shared/types. */
const PaymentGateway = Object.freeze({
  MERCADO_PAGO: 'MERCADO_PAGO',
  STRIPE:       'STRIPE',
  PAGSEGURO:    'PAGSEGURO',
});

/**
 * Transições válidas.
 * FAILED → PROCESSING existe para permitir nova tentativa; a incrementação de
 * `attempt_number` é responsabilidade do caso de uso, não da entidade.
 */
const VALID_PAYMENT_TRANSITIONS = Object.freeze({
  [PaymentStatus.PENDING]:    [PaymentStatus.PROCESSING, PaymentStatus.FAILED, PaymentStatus.CANCELLED],
  [PaymentStatus.PROCESSING]: [PaymentStatus.SUCCEEDED,  PaymentStatus.FAILED],
  [PaymentStatus.SUCCEEDED]:  [PaymentStatus.REFUNDED],
  [PaymentStatus.FAILED]:     [PaymentStatus.PROCESSING, PaymentStatus.CANCELLED],
  [PaymentStatus.REFUNDED]:   [],
  [PaymentStatus.CANCELLED]:  [],
});

/** Máximo de tentativas — da retry policy da skill. */
const MAX_ATTEMPTS = 3;

// ─── Erros tipados ────────────────────────────────────────────────────────────

class InvalidPaymentTransitionError extends Error {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    super(`Transição de pagamento inválida: ${from} → ${to}`);
    this.name = 'InvalidPaymentTransitionError';
    this.statusCode = 409;
  }
}

class MissingRequiredFieldError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Campo obrigatório em falta: ${field}`);
    this.name = 'MissingRequiredFieldError';
    this.statusCode = 400;
  }
}

class InvalidAmountError extends Error {
  /** @param {unknown} value */
  constructor(value) {
    super(`Montante inválido: ${value}. Use centavos inteiros positivos (R$ 29,90 = 2990).`);
    this.name = 'InvalidAmountError';
    this.statusCode = 400;
  }
}

class PaymentNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Pagamento não encontrado: ${id}`);
    this.name = 'PaymentNotFoundError';
    this.statusCode = 404;
  }
}

class MaxAttemptsExceededError extends Error {
  /** @param {string} orderId */
  constructor(orderId) {
    super(`Limite de ${MAX_ATTEMPTS} tentativas atingido para o pedido ${orderId}.`);
    this.name = 'MaxAttemptsExceededError';
    this.statusCode = 409;
  }
}

// ─── Funções de domínio puras ────────────────────────────────────────────────

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidPaymentTransition(from, to) {
  const allowed = VALID_PAYMENT_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Constrói a chave de idempotência no formato canônico da skill.
 *
 * @param {string} orderId
 * @param {number} attemptNumber 1-indexed
 * @returns {string}
 */
function buildIdempotencyKey(orderId, attemptNumber) {
  if (!orderId) throw new MissingRequiredFieldError('order_id');
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new MissingRequiredFieldError('attempt_number (inteiro >= 1)');
  }
  return `${orderId}:charge:${attemptNumber}`;
}

/**
 * Valida um montante monetário.
 * Rejeita floats explicitamente — a regra 3 da skill não admite exceções.
 *
 * @param {unknown} value
 */
function validateAmount(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new InvalidAmountError(value);
  if (!Number.isInteger(value)) throw new InvalidAmountError(value);
  if (value <= 0) throw new InvalidAmountError(value);
}

/**
 * Cria um novo Pagamento com status PENDING e tentativa 1.
 *
 * @param {string} id
 * @param {{ order_id: string, value: number, gateway?: string }} dto
 * @returns {object} Pagamento
 */
function createPaymentEntity(id, dto) {
  if (!dto.order_id) throw new MissingRequiredFieldError('order_id');
  validateAmount(dto.value);

  const gateway = dto.gateway ?? PaymentGateway.MERCADO_PAGO;
  if (!Object.values(PaymentGateway).includes(gateway)) {
    throw new MissingRequiredFieldError(
      `gateway (esperado um de: ${Object.values(PaymentGateway).join(', ')})`,
    );
  }

  const now = new Date().toISOString();

  return {
    id,
    order_id:               dto.order_id,
    value:                  dto.value,
    status:                 PaymentStatus.PENDING,
    gateway,
    gateway_transaction_id: null,
    idempotency_key:        buildIdempotencyKey(dto.order_id, 1),
    attempt_number:         1,
    /** Motivo da última falha — nulo enquanto não houver falha. */
    failure_reason:         null,
    created_at:             now,
    updated_at:             now,
  };
}

/**
 * Aplica uma transição de status ao pagamento.
 * Devolve novo objeto — não muta o original.
 *
 * @param {object} payment
 * @param {string} newStatus
 * @param {{ gateway_transaction_id?: string, failure_reason?: string }} [extras]
 * @returns {object} Pagamento atualizado
 */
function applyPaymentTransition(payment, newStatus, extras = {}) {
  if (!isValidPaymentTransition(payment.status, newStatus)) {
    throw new InvalidPaymentTransitionError(payment.status, newStatus);
  }

  return {
    ...payment,
    status: newStatus,
    gateway_transaction_id:
      extras.gateway_transaction_id ?? payment.gateway_transaction_id,
    failure_reason: extras.failure_reason ?? null,
    updated_at:     new Date().toISOString(),
  };
}

/**
 * Prepara a próxima tentativa após uma falha definitiva.
 * Incrementa `attempt_number` e regenera a `idempotency_key` — a skill é
 * explícita: nunca reutilizar a chave de uma tentativa anterior.
 *
 * @param {object} payment
 * @returns {object} Pagamento pronto para nova tentativa
 */
function prepareRetry(payment) {
  const proxima = payment.attempt_number + 1;

  if (proxima > MAX_ATTEMPTS) {
    throw new MaxAttemptsExceededError(payment.order_id);
  }

  return {
    ...payment,
    attempt_number:  proxima,
    idempotency_key: buildIdempotencyKey(payment.order_id, proxima),
    updated_at:      new Date().toISOString(),
  };
}

/**
 * Um pagamento já resolvido não deve ser recobrado.
 *
 * @param {object} payment
 * @returns {boolean}
 */
function isSettled(payment) {
  return (
    payment.status === PaymentStatus.SUCCEEDED ||
    payment.status === PaymentStatus.REFUNDED  ||
    payment.status === PaymentStatus.CANCELLED
  );
}

module.exports = {
  PaymentStatus,
  PaymentGateway,
  VALID_PAYMENT_TRANSITIONS,
  MAX_ATTEMPTS,
  InvalidPaymentTransitionError,
  MissingRequiredFieldError,
  InvalidAmountError,
  PaymentNotFoundError,
  MaxAttemptsExceededError,
  isValidPaymentTransition,
  buildIdempotencyKey,
  validateAmount,
  createPaymentEntity,
  applyPaymentTransition,
  prepareRetry,
  isSettled,
};
