/**
 * @file retry-policy.js
 * @description Política de retentativa de cobranças.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md § Retry Policy
 *
 * A regra central é a 2 da skill: **nunca retentar em 4xx**. Um 4xx é uma
 * recusa definitiva do gateway (cartão inválido, saldo insuficiente, dados
 * malformados) — repetir só multiplica o erro e polui a conciliação.
 * A exceção é 429 (rate limit), que é 4xx mas indica "tente mais tarde".
 */
'use strict';

const PAYMENT_RETRY = Object.freeze({
  maxAttempts: 3,
  /** Passos fixos (ms). Pagamentos não usam jitter — a ordem importa na conciliação. */
  delays: Object.freeze([2_000, 8_000, 30_000]),
  retryableHttpCodes:    Object.freeze([500, 502, 503, 504, 429]),
  nonRetryableHttpCodes: Object.freeze([400, 401, 402, 403, 422]),
});

/**
 * Classificação do resultado de uma chamada ao gateway.
 * @typedef {'success'|'retryable'|'definitive_failure'} ChargeOutcome
 */

/**
 * Decide o que fazer perante um código HTTP do gateway.
 *
 * @param {number|null} httpCode Código devolvido; null em erro de rede/timeout
 * @returns {ChargeOutcome}
 */
function classifyResponse(httpCode) {
  // Erro de rede ou timeout: não sabemos se a cobrança passou. É retentável
  // precisamente porque a idempotency_key protege contra cobrança dupla.
  if (httpCode === null || httpCode === undefined) return 'retryable';

  if (httpCode >= 200 && httpCode < 300) return 'success';

  if (PAYMENT_RETRY.retryableHttpCodes.includes(httpCode)) return 'retryable';

  if (PAYMENT_RETRY.nonRetryableHttpCodes.includes(httpCode)) return 'definitive_failure';

  // 4xx desconhecido é tratado como definitivo (regra 2 da skill);
  // 5xx desconhecido como retentável.
  return httpCode >= 400 && httpCode < 500 ? 'definitive_failure' : 'retryable';
}

/**
 * @param {number} httpCode
 * @returns {boolean}
 */
function isRetryable(httpCode) {
  return classifyResponse(httpCode) === 'retryable';
}

/**
 * Atraso antes da tentativa `attemptNumber`.
 * A primeira tentativa não espera; a segunda espera delays[0], e assim por diante.
 *
 * @param {number} attemptNumber 1-indexed
 * @returns {number} ms
 */
function delayForAttempt(attemptNumber) {
  if (attemptNumber <= 1) return 0;

  const idx = attemptNumber - 2;
  // Acima do número de passos definidos, mantém o último (não cresce indefinidamente).
  return PAYMENT_RETRY.delays[idx] ?? PAYMENT_RETRY.delays[PAYMENT_RETRY.delays.length - 1];
}

/**
 * @param {number} attemptNumber 1-indexed
 * @returns {boolean}
 */
function hasAttemptsLeft(attemptNumber) {
  return attemptNumber < PAYMENT_RETRY.maxAttempts;
}

module.exports = {
  PAYMENT_RETRY,
  classifyResponse,
  isRetryable,
  delayForAttempt,
  hasAttemptsLeft,
};
