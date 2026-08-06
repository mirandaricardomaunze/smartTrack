/**
 * @file messaging.types.ts
 * @description Tipos de mensagens ao cliente (SMS e email).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 (Notificações)
 *
 * Canais além do push (FCM): SMS e email, simulados por default e reais quando
 * configurados por ambiente. Cada envio é registado (auditoria) em outbound_messages.
 */

/** Canal de envio. */
export enum MessageChannel {
  SMS   = 'sms',
  EMAIL = 'email',
}

/** Estado de um envio. */
export enum MessageStatus {
  SENT      = 'sent',       // entregue ao provedor real
  FAILED    = 'failed',     // o provedor recusou / falhou
  SIMULATED = 'simulated',  // sem provedor real configurado — apenas registado
}

/** Registo de uma mensagem enviada (SMS/email). */
export interface OutboundMessage {
  id: string;
  channel: MessageChannel;
  recipient: string;
  subject?: string;         // só email
  body: string;
  status: MessageStatus;
  provider: string;         // 'SIMULATED' | nome do provedor real
  provider_message_id?: string;
  order_id?: string;
  tracking_code?: string;
  error?: string;
  created_at: string;       // ISO8601 UTC
}
