/**
 * @file support.factory.ts
 * @description Test factory para o chat de suporte (conversas e mensagens).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9
 *
 * Alinhado com backend/shared/types/src/support.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { SupportSender } from '../../../backend/shared/types/src/support.types';

export interface TestSupportThreadInput {
  client_name: string;
  client_email?: string;
  subject?: string;
  message: string;
  tracking_code?: string;
}

export interface TestSupportMessage {
  id: string;
  thread_id: string;
  sender: SupportSender;
  sender_name: string;
  body: string;
  created_at: string;
}

let _counter = 1;

/** DTOs de abertura de conversa (entrada de `openThread`). */
export class SupportThreadFactory {
  static build(overrides: Partial<TestSupportThreadInput> = {}): TestSupportThreadInput {
    const n = _counter++;
    return {
      client_name:   `Cliente Teste ${n}`,
      client_email:  `cliente${n}@exemplo.mz`,
      subject:       'Dúvida sobre a minha encomenda',
      message:       'Olá, gostaria de saber o estado da minha encomenda.',
      tracking_code: undefined,
      ...overrides,
    };
  }

  /** Abertura com contexto de pedido (código de rastreio). */
  static buildWithTracking(trackingCode: string, overrides: Partial<TestSupportThreadInput> = {}): TestSupportThreadInput {
    return this.build({ tracking_code: trackingCode, subject: 'Problema na entrega', ...overrides });
  }
}

/** Mensagens já persistidas (para asserções sobre o histórico). */
export class SupportMessageFactory {
  static build(overrides: Partial<TestSupportMessage> = {}): TestSupportMessage {
    const n = _counter++;
    return {
      id:          `support-msg-${n.toString().padStart(4, '0')}`,
      thread_id:   `support-thread-${n.toString().padStart(4, '0')}`,
      sender:      SupportSender.CLIENT,
      sender_name: `Cliente Teste ${n}`,
      body:        'Mensagem de teste.',
      created_at:  new Date().toISOString(),
      ...overrides,
    };
  }

  static buildAgent(overrides: Partial<TestSupportMessage> = {}): TestSupportMessage {
    return this.build({ sender: SupportSender.AGENT, sender_name: 'Suporte', body: 'Olá! Já estamos a verificar.', ...overrides });
  }
}
