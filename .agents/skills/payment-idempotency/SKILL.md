# SKILL.md — payment-idempotency

---
name: payment-idempotency
description: >
  Ensures all payment charge attempts in sistemaTrack are idempotent,
  preventing duplicate charges. Use when writing or reviewing payment
  service endpoints, retry logic, webhook handlers, or financial
  reconciliation flows.
triggers:
  - "payment"
  - "pagamento"
  - "cobrança"
  - "charge"
  - "idempotency"
  - "gateway"
  - "webhook pagamento"
  - "retry pagamento"
  - "mercado pago"
  - "stripe"
---

## Objective

Guarantee that no customer is charged more than once for the same delivery,
even under network failures, retries, or concurrent requests.

## Idempotency Key Convention

```
idempotency_key = `${pedido_id}:charge:${attempt_number}`
```

Examples:
- `ord_abc123:charge:1` — first attempt
- `ord_abc123:charge:2` — first retry
- `ord_abc123:charge:3` — second retry (max)

The `attempt_number` is persisted in `Pagamento.tentativa_numero` and incremented only
after a definitive failure (not on network errors or 5xx).

## Payment Entity

```typescript
// packages/shared-types/src/payment.entity.ts
export interface Pagamento {
  id: string;
  pedido_id: string;
  valor: number; // in cents (avoid float arithmetic)
  status: PaymentStatus;
  gateway: 'MERCADO_PAGO' | 'STRIPE' | 'PAGSEGURO';
  gateway_transaction_id: string | null;
  idempotency_key: string;
  tentativa_numero: number; // 1-indexed
  criado_em: string; // ISO8601 UTC
  atualizado_em: string;
}

export enum PaymentStatus {
  PENDING    = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED  = 'succeeded',
  FAILED     = 'failed',
  REFUNDED   = 'refunded',
  CANCELLED  = 'cancelled',
}
```

## Charge Flow

```
1. Create Pagamento record (status: PENDING, tentativa_numero: 1)
2. Call gateway API with idempotency_key
   a. 200 SUCCESS → update status to SUCCEEDED, store gateway_transaction_id
   b. 4xx CLIENT ERROR → update status to FAILED, do NOT retry
   c. 5xx / timeout → retry with exponential backoff (max 3 attempts)
      - Before retry: increment tentativa_numero, generate new idempotency_key
      - After 3 failures: status → FAILED, emit PaymentFailedEvent, alert ops
3. On SUCCESS: emit PaymentSucceededEvent → orders-service updates order
4. MVP: failed payment does NOT block order delivery
   Fase 2: implement delivery hold until payment confirmed
```

## Retry Policy

```typescript
const PAYMENT_RETRY = {
  maxAttempts: 3,
  delays: [2_000, 8_000, 30_000], // ms, fixed steps for payments
  retryableHttpCodes: [500, 502, 503, 504, 429],
  nonRetryableCodes: [400, 401, 402, 403, 422], // definitive failures
};
```

## Webhook Handler Rules

```typescript
// services/payments-service/src/api/webhooks/gateway-webhook.controller.ts

// CRITICAL: webhooks can be delivered multiple times — MUST be idempotent
async handleWebhook(dto: GatewayWebhookDto): Promise<void> {
  const existing = await this.paymentsRepo.findByGatewayTxId(dto.transaction_id);
  if (existing?.status === PaymentStatus.SUCCEEDED) {
    // Already processed — acknowledge and return (idempotent)
    return;
  }
  // Process...
}
```

## Rules for Agents Using This Skill

1. **Never** call the gateway without an `idempotency_key` set in the request header.
2. **Never** retry on 4xx responses (client errors are definitive).
3. Amounts stored as **integer cents** only — never float. `R$ 29,90` = `2990`.
4. Webhook endpoints must validate the gateway signature before processing.
5. Financial events (PaymentSucceeded, PaymentFailed) must include `pedido_id`, `valor`, `gateway`, `gateway_transaction_id`.
6. Reconciliation: daily job in `services/payments-service/src/jobs/reconciliation.job.ts` must cross-check all `SUCCEEDED` payments against gateway records.

## Required Tests

```typescript
describe('PaymentService', () => {
  it('should generate idempotency_key as pedido_id:charge:attempt_number');
  it('should not retry on 422 Unprocessable Entity from gateway');
  it('should retry up to 3 times on 503 from gateway');
  it('should not create duplicate charge when webhook received twice');
  it('should store amount as integer cents, not float');
  it('should emit PaymentFailedEvent after maxAttempts exceeded');
});
```

## References

- `services/payments-service/src/domain/payment.service.ts`
- `services/payments-service/src/api/webhooks/`
- `services/payments-service/src/jobs/reconciliation.job.ts`
- `packages/shared-types/src/payment.entity.ts`
- `docs/events/schemas/payment-succeeded-event.json`
- `docs/events/schemas/payment-failed-event.json`
