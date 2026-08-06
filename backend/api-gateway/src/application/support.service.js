/**
 * @file support.service.js
 * @description Camada de aplicação — chat de suporte cliente↔agente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9 (Chat com suporte)
 *
 * O cliente abre uma conversa sem login (à semelhança do rastreio público): recebe
 * um `access_token` opaco que dá acesso apenas àquela conversa. O token é guardado
 * apenas como hash SHA-256 (o texto claro só existe na resposta de abertura) e a
 * verificação usa comparação em tempo constante — mesmo padrão do OTP de entrega.
 * Os agentes (SUPPORT/ADMIN) acedem via JWT/RBAC. O contexto do pedido é resolvido
 * pelo código de rastreio quando fornecido. Atendimento humano; o schema reserva
 * 'bot' para automação futura.
 */
'use strict';

const crypto = require('crypto');
const { SupportRepository, OrderRepository } = require('../infrastructure/pg.repository');

// ─── Constantes de domínio (espelham support.types.ts) ───────────────────────

const Sender = Object.freeze({ CLIENT: 'client', AGENT: 'agent', SYSTEM: 'system', BOT: 'bot' });
const ThreadStatus = Object.freeze({ OPEN: 'open', RESOLVED: 'resolved' });
const AGENT_DISPLAY_NAME = 'Suporte';

const MAX_NAME = 120;
const MAX_SUBJECT = 200;
const MAX_BODY = 4000;

// ─── Erros de Aplicação ──────────────────────────────────────────────────────

class SupportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupportValidationError';
    this.statusCode = 400;
  }
}

class SupportThreadNotFoundError extends Error {
  constructor(id) {
    super(`Conversa de suporte não encontrada: ${id}`);
    this.name = 'SupportThreadNotFoundError';
    this.statusCode = 404;
  }
}

class SupportAccessDeniedError extends Error {
  constructor() {
    super('Token de acesso à conversa inválido.');
    this.name = 'SupportAccessDeniedError';
    this.statusCode = 401;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Comparação em tempo constante de dois hashes hex. */
function hashesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Valida/normaliza um texto obrigatório. */
function requireText(value, field, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new SupportValidationError(`O campo "${field}" é obrigatório.`);
  if (s.length > max) throw new SupportValidationError(`O campo "${field}" excede ${max} caracteres.`);
  return s;
}

function optionalText(value, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s.slice(0, max) : undefined;
}

/** Verifica o token de acesso do cliente contra o hash guardado. */
async function assertClientToken(threadId, token) {
  const storedHash = await SupportRepository.getClientTokenHash(threadId);
  if (!storedHash) throw new SupportThreadNotFoundError(threadId);
  if (!token || !hashesEqual(storedHash, hashToken(token))) throw new SupportAccessDeniedError();
}

/** Devolve a conversa segura + mensagens (contrato partilhado por GET/POST do cliente). */
async function clientView(threadId) {
  const thread = await SupportRepository.findThreadById(threadId);
  if (!thread) throw new SupportThreadNotFoundError(threadId);
  const messages = await SupportRepository.listMessages(threadId);
  return { ...thread, messages };
}

// ─── Use Cases — Cliente (público, por token) ────────────────────────────────

/**
 * Abre uma conversa: cria a thread, regista a primeira mensagem do cliente e
 * devolve o token de acesso (texto claro, apenas aqui).
 *
 * @param {{ client_name: string; client_email?: string; subject?: string; message: string; tracking_code?: string }} dto
 * @returns {Promise<{ thread: object; access_token: string }>}
 */
async function openThread(dto = {}) {
  const clientName = requireText(dto.client_name, 'nome', MAX_NAME);
  const message    = requireText(dto.message, 'mensagem', MAX_BODY);
  const email      = optionalText(dto.client_email, 200);
  const trackingIn = optionalText(dto.tracking_code, 60);
  const subject    = optionalText(dto.subject, MAX_SUBJECT) || message.slice(0, 80);

  // Contexto do pedido: resolve o código de rastreio, se fornecido. A conversa
  // herda a EMPRESA do pedido (multi-tenant, spec § 2.4) — o cliente é público.
  let orderId;
  let companyId;
  let trackingCode = trackingIn;
  if (trackingIn) {
    const order = await OrderRepository.findByCode(trackingIn);
    if (order) { orderId = order.id; trackingCode = order.tracking_code; companyId = order.company_id; }
  }

  const token = crypto.randomBytes(24).toString('hex');
  const id = crypto.randomUUID();

  const thread = await SupportRepository.createThread({
    id,
    client_name: clientName,
    client_email: email,
    subject,
    order_id: orderId,
    tracking_code: trackingCode,
    status: ThreadStatus.OPEN,
    client_token_hash: hashToken(token),
    company_id: companyId,
  });

  await SupportRepository.addMessage({
    id: crypto.randomUUID(),
    thread_id: id,
    sender: Sender.CLIENT,
    sender_name: clientName,
    body: message,
  });

  const messages = await SupportRepository.listMessages(id);
  return { thread: { ...thread, messages }, access_token: token };
}

/** Vê a conversa (mensagens completas) — requer o token do cliente. */
async function getClientThread(id, token) {
  await assertClientToken(id, token);
  return clientView(id);
}

/** Cliente responde na conversa — reabre se estava resolvida. */
async function postClientMessage(id, token, dto = {}) {
  await assertClientToken(id, token);
  const body = requireText(dto.body, 'mensagem', MAX_BODY);

  const thread = await SupportRepository.findThreadById(id);
  await SupportRepository.addMessage({
    id: crypto.randomUUID(),
    thread_id: id,
    sender: Sender.CLIENT,
    sender_name: thread.client_name,
    body,
  });
  await SupportRepository.bumpThread(id, thread.status === ThreadStatus.RESOLVED);
  return clientView(id);
}

// ─── Use Cases — Agente (JWT/RBAC) ───────────────────────────────────────────

/** Lista conversas para a fila do agente. */
async function listThreads(opts = {}) {
  const status = opts.status && [ThreadStatus.OPEN, ThreadStatus.RESOLVED].includes(opts.status)
    ? opts.status : undefined;
  return SupportRepository.listThreads({ status });
}

/** Detalhe de uma conversa para o agente (mensagens + contexto do pedido). */
async function getThread(id) {
  const thread = await SupportRepository.findThreadById(id);
  if (!thread) throw new SupportThreadNotFoundError(id);
  const messages = await SupportRepository.listMessages(id);
  let order;
  if (thread.order_id) order = await OrderRepository.findById(thread.order_id);
  return { ...thread, message_count: messages.length, messages, order };
}

/** Agente responde — atribui-se à conversa se ainda não houver agente. */
async function postAgentMessage(id, agent, dto = {}) {
  const thread = await SupportRepository.findThreadById(id);
  if (!thread) throw new SupportThreadNotFoundError(id);
  const body = requireText(dto.body, 'mensagem', MAX_BODY);

  await SupportRepository.addMessage({
    id: crypto.randomUUID(),
    thread_id: id,
    sender: Sender.AGENT,
    sender_id: agent?.sub ?? null,
    sender_name: AGENT_DISPLAY_NAME,
    body,
  });
  await SupportRepository.bumpThread(id, false);
  if (!thread.assigned_agent_id && agent?.sub) {
    await SupportRepository.updateThread(id, { assigned_agent_id: agent.sub });
  }
  return getThread(id);
}

/** Atualiza estado (resolver/reabrir) e/ou atribuição. */
async function updateThread(id, patch = {}) {
  const existing = await SupportRepository.findThreadById(id);
  if (!existing) throw new SupportThreadNotFoundError(id);

  const clean = {};
  if (patch.status !== undefined) {
    if (![ThreadStatus.OPEN, ThreadStatus.RESOLVED].includes(patch.status)) {
      throw new SupportValidationError('Estado inválido. Use "open" ou "resolved".');
    }
    clean.status = patch.status;
  }
  if (patch.assigned_agent_id !== undefined) clean.assigned_agent_id = patch.assigned_agent_id || null;

  await SupportRepository.updateThread(id, clean);
  return getThread(id);
}

/** Resumo para painel/sidebar. */
async function getStats() {
  return SupportRepository.getStats();
}

module.exports = {
  // Cliente (token)
  openThread,
  getClientThread,
  postClientMessage,
  // Agente (JWT)
  listThreads,
  getThread,
  postAgentMessage,
  updateThread,
  getStats,
  // Erros
  SupportValidationError,
  SupportThreadNotFoundError,
  SupportAccessDeniedError,
};
