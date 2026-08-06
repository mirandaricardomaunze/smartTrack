/**
 * @file messaging.factory.ts
 * @description Test factory para mensagens ao cliente (SMS/email).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * Alinhado com backend/shared/types/src/messaging.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { MessageChannel, MessageStatus } from '../../../backend/shared/types/src/messaging.types';

export interface TestOutboundMessage {
  id: string;
  channel: MessageChannel;
  recipient: string;
  subject?: string;
  body: string;
  status: MessageStatus;
  provider: string;
  provider_message_id?: string;
  order_id?: string;
  tracking_code?: string;
  error?: string;
  created_at: string;
}

let _counter = 1;

export class OutboundMessageFactory {
  static build(overrides: Partial<TestOutboundMessage> = {}): TestOutboundMessage {
    const n = _counter++;
    return {
      id:                  `msg-test-${n.toString().padStart(4, '0')}`,
      channel:             MessageChannel.SMS,
      recipient:           `+2588400000${String(n).padStart(2, '0')}`,
      subject:             undefined,
      body:                'Recebemos a sua encomenda no armazém.',
      status:              MessageStatus.SIMULATED,
      provider:            'SIMULATED',
      provider_message_id: `sim-${n}`,
      order_id:            `order-test-uuid-${n.toString().padStart(4, '0')}`,
      tracking_code:       `TRK${String(n).padStart(8, '0')}BR`,
      error:               undefined,
      created_at:          new Date().toISOString(),
      ...overrides,
    };
  }

  static buildSms(overrides: Partial<TestOutboundMessage> = {}): TestOutboundMessage {
    return this.build({ channel: MessageChannel.SMS, ...overrides });
  }

  static buildEmail(overrides: Partial<TestOutboundMessage> = {}): TestOutboundMessage {
    return this.build({ channel: MessageChannel.EMAIL, recipient: `cliente${_counter}@exemplo.mz`, subject: 'Encomenda recebida no armazém', ...overrides });
  }

  static buildFailed(overrides: Partial<TestOutboundMessage> = {}): TestOutboundMessage {
    return this.build({ status: MessageStatus.FAILED, error: 'Número recusado (simulado).', ...overrides });
  }
}
