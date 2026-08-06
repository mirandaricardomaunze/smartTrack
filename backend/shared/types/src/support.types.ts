/**
 * @file support.types.ts
 * @description Tipos do chat de suporte cliente↔agente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9 (Chat com suporte)
 *
 * Canal cliente↔suporte com o contexto do pedido pré-carregado e histórico de
 * conversas persistido. Atendimento humano (agentes SUPPORT/ADMIN); o campo
 * `sender` reserva 'bot' para atendimento automático futuro sem alterar o schema.
 */

/** Autor de uma mensagem. 'bot' reservado para atendimento automático futuro. */
export enum SupportSender {
  CLIENT = 'client',
  AGENT  = 'agent',
  SYSTEM = 'system',
  BOT    = 'bot',
}

/** Estado de uma conversa. */
export enum SupportThreadStatus {
  OPEN     = 'open',      // aguarda / em atendimento
  RESOLVED = 'resolved',  // encerrada pelo agente
}

/** Uma mensagem dentro de uma conversa. */
export interface SupportMessage {
  id: string;
  thread_id: string;
  sender: SupportSender;
  sender_name: string;   // rótulo apresentável (ex.: nome do cliente, "Suporte")
  body: string;
  created_at: string;    // ISO8601 UTC
}

/** Uma conversa de suporte. */
export interface SupportThread {
  id: string;
  client_name: string;
  client_email?: string;
  subject: string;
  order_id?: string;        // contexto do pedido, se houver
  tracking_code?: string;   // contexto do pedido, se houver
  status: SupportThreadStatus;
  assigned_agent_id?: string;
  message_count?: number;
  last_message_preview?: string;
  last_message_at: string;  // ISO8601 UTC
  created_at: string;       // ISO8601 UTC
  updated_at: string;       // ISO8601 UTC
  messages?: SupportMessage[];
}

/** Resposta ao abrir uma conversa — o token dá acesso ao cliente (sem login). */
export interface SupportThreadCreated {
  thread: SupportThread;
  access_token: string;
}
