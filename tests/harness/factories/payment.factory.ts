/**
 * @file payment.factory.ts
 * @description Factory de pagamentos para testes (em Inglês).
 */
import { PaymentStatus, PaymentGateway } from '../../../backend/shared/types/src/payment.types';

export interface TestPayment {
  id: string;
  order_id: string;
  value: number;
  status: PaymentStatus;
  gateway: PaymentGateway;
  gateway_transaction_id: string | null;
  idempotency_key: string;
  tentativa_numero: number;
  created_at: string;
  updated_at: string;
}

let _counter = 1;

export class PaymentFactory {
  static build(overrides: Partial<TestPayment> = {}): TestPayment {
    const n = _counter++;
    const order_id = overrides.order_id ?? `order-test-uuid-${n.toString().padStart(4, '0')}`;
    const tentativa = overrides.tentativa_numero ?? 1;
    return {
      id:                      `payment-test-uuid-${n.toString().padStart(4, '0')}`,
      order_id,
      value:                   2990, // R$ 29,90 in cents
      status:                  PaymentStatus.PENDING,
      gateway:                 PaymentGateway.MERCADO_PAGO,
      gateway_transaction_id:  null,
      idempotency_key:         `${order_id}:charge:${tentativa}`,
      tentativa_numero:        tentativa,
      created_at:               new Date().toISOString(),
      updated_at:           new Date().toISOString(),
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestPayment> = {}): TestPayment[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  static buildSucceeded(order_id: string): TestPayment {
    return this.build({
      order_id,
      status:                 PaymentStatus.SUCCEEDED,
      gateway_transaction_id: `gw-tx-test-${Date.now()}`,
    });
  }

  static buildFailed(order_id: string, tentativa = 3): TestPayment {
    return this.build({
      order_id,
      status:          PaymentStatus.FAILED,
      tentativa_numero: tentativa,
      idempotency_key: `${order_id}:charge:${tentativa}`,
    });
  }

  static buildProcessing(order_id: string): TestPayment {
    return this.build({
      order_id,
      status: PaymentStatus.PROCESSING,
    });
  }

  static buildRefunded(order_id: string): TestPayment {
    return this.build({
      order_id,
      status:                 PaymentStatus.REFUNDED,
      gateway_transaction_id: `gw-refund-test-${Date.now()}`,
    });
  }
}
