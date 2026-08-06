/**
 * @file payment.entity.spec.js
 * @description Testes da entidade de domínio Pagamento.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md
 */
import { describe, it, expect } from 'vitest';
// Módulo CommonJS (o serviço corre em Node sem build step) — import default.
import paymentEntity from './payment.entity.js';

const {
  PaymentStatus,
  PaymentGateway,
  MAX_ATTEMPTS,
  isValidPaymentTransition,
  buildIdempotencyKey,
  validateAmount,
  createPaymentEntity,
  applyPaymentTransition,
  prepareRetry,
  isSettled,
  InvalidPaymentTransitionError,
  MissingRequiredFieldError,
  InvalidAmountError,
  MaxAttemptsExceededError,
} = paymentEntity;

function makePayment(overrides = {}) {
  const base = createPaymentEntity('payment-test-0001', {
    order_id: 'order-test-uuid-0001',
    value:    2990,
  });
  return { ...base, ...overrides };
}

describe('buildIdempotencyKey', () => {
  // Exigido pela skill: "should generate idempotency_key as pedido_id:charge:attempt_number"
  it('should generate the key as order_id:charge:attempt_number', () => {
    expect(buildIdempotencyKey('ord_abc123', 1)).toBe('ord_abc123:charge:1');
    expect(buildIdempotencyKey('ord_abc123', 3)).toBe('ord_abc123:charge:3');
  });

  it('should reject a missing order_id', () => {
    expect(() => buildIdempotencyKey('', 1)).toThrow(MissingRequiredFieldError);
  });

  it('should reject a non-positive or fractional attempt number', () => {
    expect(() => buildIdempotencyKey('ord_1', 0)).toThrow(MissingRequiredFieldError);
    expect(() => buildIdempotencyKey('ord_1', 1.5)).toThrow(MissingRequiredFieldError);
  });
});

describe('validateAmount', () => {
  // Exigido pela skill: "should store amount as integer cents, not float"
  it('should accept positive integer cents', () => {
    expect(() => validateAmount(2990)).not.toThrow();
    expect(() => validateAmount(1)).not.toThrow();
  });

  it('should reject a float amount', () => {
    // 29.90 é o erro clássico: reais em vez de centavos
    expect(() => validateAmount(29.90)).toThrow(InvalidAmountError);
    expect(() => validateAmount(2990.5)).toThrow(InvalidAmountError);
  });

  it('should reject zero, negative and non-numeric amounts', () => {
    expect(() => validateAmount(0)).toThrow(InvalidAmountError);
    expect(() => validateAmount(-100)).toThrow(InvalidAmountError);
    expect(() => validateAmount('2990')).toThrow(InvalidAmountError);
    expect(() => validateAmount(NaN)).toThrow(InvalidAmountError);
  });
});

describe('createPaymentEntity', () => {
  it('should start as PENDING on attempt 1 with a matching key', () => {
    const p = makePayment();

    expect(p.status).toBe(PaymentStatus.PENDING);
    expect(p.attempt_number).toBe(1);
    expect(p.idempotency_key).toBe('order-test-uuid-0001:charge:1');
    expect(p.gateway_transaction_id).toBeNull();
  });

  it('should default to MERCADO_PAGO', () => {
    expect(makePayment().gateway).toBe(PaymentGateway.MERCADO_PAGO);
  });

  it('should reject an unknown gateway', () => {
    expect(() => createPaymentEntity('p1', {
      order_id: 'o1', value: 2990, gateway: 'BITCOIN',
    })).toThrow(MissingRequiredFieldError);
  });

  it('should reject a float value', () => {
    expect(() => createPaymentEntity('p1', { order_id: 'o1', value: 29.9 }))
      .toThrow(InvalidAmountError);
  });
});

describe('isValidPaymentTransition', () => {
  it('should allow the happy path PENDING → PROCESSING → SUCCEEDED', () => {
    expect(isValidPaymentTransition(PaymentStatus.PENDING, PaymentStatus.PROCESSING)).toBe(true);
    expect(isValidPaymentTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCEEDED)).toBe(true);
  });

  it('should allow retrying from FAILED', () => {
    expect(isValidPaymentTransition(PaymentStatus.FAILED, PaymentStatus.PROCESSING)).toBe(true);
  });

  it('should reject skipping straight from PENDING to SUCCEEDED', () => {
    // Nunca marcar como pago sem ter passado pelo gateway
    expect(isValidPaymentTransition(PaymentStatus.PENDING, PaymentStatus.SUCCEEDED)).toBe(false);
  });

  it('should reject un-succeeding a payment', () => {
    expect(isValidPaymentTransition(PaymentStatus.SUCCEEDED, PaymentStatus.FAILED)).toBe(false);
  });

  it('should treat REFUNDED and CANCELLED as terminal', () => {
    expect(isValidPaymentTransition(PaymentStatus.REFUNDED, PaymentStatus.SUCCEEDED)).toBe(false);
    expect(isValidPaymentTransition(PaymentStatus.CANCELLED, PaymentStatus.PROCESSING)).toBe(false);
  });

  it('should only allow REFUNDED from SUCCEEDED', () => {
    expect(isValidPaymentTransition(PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED)).toBe(true);
    expect(isValidPaymentTransition(PaymentStatus.PENDING, PaymentStatus.REFUNDED)).toBe(false);
  });
});

describe('applyPaymentTransition', () => {
  it('should not mutate the original payment', () => {
    const p = makePayment();
    applyPaymentTransition(p, PaymentStatus.PROCESSING);

    expect(p.status).toBe(PaymentStatus.PENDING);
  });

  it('should store the gateway transaction id on success', () => {
    const processing = applyPaymentTransition(makePayment(), PaymentStatus.PROCESSING);
    const succeeded  = applyPaymentTransition(processing, PaymentStatus.SUCCEEDED, {
      gateway_transaction_id: 'tx-123',
    });

    expect(succeeded.gateway_transaction_id).toBe('tx-123');
  });

  it('should throw on an invalid transition', () => {
    expect(() => applyPaymentTransition(makePayment(), PaymentStatus.SUCCEEDED))
      .toThrow(InvalidPaymentTransitionError);
  });
});

describe('prepareRetry', () => {
  it('should increment the attempt and regenerate the key', () => {
    const p = makePayment();
    const retry = prepareRetry(p);

    expect(retry.attempt_number).toBe(2);
    expect(retry.idempotency_key).toBe('order-test-uuid-0001:charge:2');
  });

  it('should never reuse a previous attempt key', () => {
    const p1 = makePayment();
    const p2 = prepareRetry(p1);
    const p3 = prepareRetry(p2);

    const chaves = new Set([p1.idempotency_key, p2.idempotency_key, p3.idempotency_key]);
    expect(chaves.size).toBe(3);
  });

  it('should refuse to go past the max attempts', () => {
    const p = makePayment({ attempt_number: MAX_ATTEMPTS });
    expect(() => prepareRetry(p)).toThrow(MaxAttemptsExceededError);
  });
});

describe('isSettled', () => {
  it('should treat SUCCEEDED, REFUNDED and CANCELLED as settled', () => {
    expect(isSettled(makePayment({ status: PaymentStatus.SUCCEEDED }))).toBe(true);
    expect(isSettled(makePayment({ status: PaymentStatus.REFUNDED }))).toBe(true);
    expect(isSettled(makePayment({ status: PaymentStatus.CANCELLED }))).toBe(true);
  });

  it('should treat PENDING, PROCESSING and FAILED as open', () => {
    expect(isSettled(makePayment({ status: PaymentStatus.PENDING }))).toBe(false);
    expect(isSettled(makePayment({ status: PaymentStatus.PROCESSING }))).toBe(false);
    // FAILED continua aberto: ainda pode haver retentativa
    expect(isSettled(makePayment({ status: PaymentStatus.FAILED }))).toBe(false);
  });
});
