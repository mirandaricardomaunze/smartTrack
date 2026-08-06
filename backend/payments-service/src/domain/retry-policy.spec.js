/**
 * @file retry-policy.spec.js
 * @description Testes da política de retentativa.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md § Retry Policy
 * A regra que estes testes protegem é a 2: nunca retentar em 4xx.
 */
import { describe, it, expect } from 'vitest';
import retryPolicy from './retry-policy.js';

const {
  PAYMENT_RETRY,
  classifyResponse,
  isRetryable,
  delayForAttempt,
  hasAttemptsLeft,
} = retryPolicy;

describe('classifyResponse', () => {
  it('should treat 2xx as success', () => {
    expect(classifyResponse(200)).toBe('success');
    expect(classifyResponse(201)).toBe('success');
  });

  // Exigido pela skill: "should not retry on 422 Unprocessable Entity from gateway"
  it('should treat 422 as a definitive failure', () => {
    expect(classifyResponse(422)).toBe('definitive_failure');
    expect(isRetryable(422)).toBe(false);
  });

  it('should treat every declared 4xx as definitive', () => {
    for (const code of PAYMENT_RETRY.nonRetryableHttpCodes) {
      expect(classifyResponse(code)).toBe('definitive_failure');
    }
  });

  // Exigido pela skill: "should retry up to 3 times on 503 from gateway"
  it('should treat 503 as retryable', () => {
    expect(classifyResponse(503)).toBe('retryable');
    expect(isRetryable(503)).toBe(true);
  });

  it('should treat every declared 5xx as retryable', () => {
    for (const code of PAYMENT_RETRY.retryableHttpCodes) {
      expect(classifyResponse(code)).toBe('retryable');
    }
  });

  it('should treat 429 as retryable despite being 4xx', () => {
    // Rate limit não é recusa: é "tente mais tarde"
    expect(classifyResponse(429)).toBe('retryable');
  });

  it('should treat a network error (null code) as retryable', () => {
    // Não sabemos se a cobrança passou — a idempotency_key protege a repetição
    expect(classifyResponse(null)).toBe('retryable');
    expect(classifyResponse(undefined)).toBe('retryable');
  });

  it('should default unknown 4xx to definitive and unknown 5xx to retryable', () => {
    expect(classifyResponse(418)).toBe('definitive_failure');
    expect(classifyResponse(599)).toBe('retryable');
  });
});

describe('delayForAttempt', () => {
  it('should not delay the first attempt', () => {
    expect(delayForAttempt(1)).toBe(0);
  });

  it('should follow the declared fixed steps', () => {
    expect(delayForAttempt(2)).toBe(PAYMENT_RETRY.delays[0]);
    expect(delayForAttempt(3)).toBe(PAYMENT_RETRY.delays[1]);
  });

  it('should clamp to the last step beyond the declared range', () => {
    const ultimo = PAYMENT_RETRY.delays[PAYMENT_RETRY.delays.length - 1];
    expect(delayForAttempt(99)).toBe(ultimo);
  });
});

describe('hasAttemptsLeft', () => {
  it('should allow attempts below the maximum', () => {
    expect(hasAttemptsLeft(1)).toBe(true);
    expect(hasAttemptsLeft(2)).toBe(true);
  });

  it('should stop at the maximum', () => {
    expect(hasAttemptsLeft(PAYMENT_RETRY.maxAttempts)).toBe(false);
    expect(hasAttemptsLeft(PAYMENT_RETRY.maxAttempts + 1)).toBe(false);
  });
});
