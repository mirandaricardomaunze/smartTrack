/**
 * @file messaging.service.js
 * @description Envio de mensagens ao cliente por SMS e email + auditoria.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 (Notificações)
 *
 * Complementa o push (FCM). Cada envio é registado em outbound_messages e é
 * **best-effort**: uma falha de canal nunca interrompe o fluxo de negócio (ex.:
 * a receção no armazém conclui mesmo que o SMS falhe).
 *
 * Costura de portas (como tracking/payments): os testes trocam repo/clientes por
 * duplos via `configurePorts`, sem depender do carregador de módulos.
 */
'use strict';

const crypto = require('crypto');
const { OutboundMessageRepository } = require('../infrastructure/pg.repository');
const { getSmsClient, isSimulated: smsIsSimulated } = require('../infrastructure/sms.client');
const { getEmailClient, isSimulated: emailIsSimulated } = require('../infrastructure/email.client');
const { getWhatsAppClient, isSimulated: whatsappIsSimulated } = require('../infrastructure/whatsapp.client');

const DEFAULT_PORTS = Object.freeze({
  repo:        OutboundMessageRepository,
  getSms:      getSmsClient,
  getEmail:    getEmailClient,
  getWhatsApp: getWhatsAppClient,
});

let ports = { ...DEFAULT_PORTS };

/** @param {object} overrides */
function configurePorts(overrides) { ports = { ...ports, ...overrides }; }
/** Repõe a infraestrutura real. */
function resetPorts() { ports = { ...DEFAULT_PORTS }; }

/** @param {string} channel @returns {string} */
function generateMessageId(channel) {
  return `msg-${channel}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Persiste o registo de um envio (nunca lança — best-effort).
 * @param {object} record
 * @returns {Promise<object|null>}
 */
async function recordOutbound(record) {
  try {
    return await ports.repo.create({ ...record, created_at: new Date().toISOString() });
  } catch (err) {
    console.error('[messaging] Falha ao registar mensagem:', err.message);
    return null;
  }
}

/**
 * Envia uma mensagem ao cliente pelos canais indicados, registando cada envio.
 * Best-effort: nunca lança.
 *
 * @param {{ channels?: string[]; to_phone?: string; to_email?: string; subject?: string; body: string; order_id?: string; tracking_code?: string }} dto
 * @returns {Promise<{ results: object[] }>}
 */
async function sendClientMessage(dto) {
  const channels = Array.isArray(dto?.channels) && dto.channels.length ? dto.channels : ['sms', 'email'];
  const body = String(dto?.body ?? '').trim();
  const results = [];
  if (!body) return { results };

  // ── SMS ──────────────────────────────────────────────────────────────────
  if (channels.includes('sms') && dto.to_phone) {
    let res;
    try {
      res = await ports.getSms().send({ to: dto.to_phone, message: body });
    } catch (err) {
      res = { ok: false, status: 'failed', provider: 'HTTP', message: err.message };
    }
    const saved = await recordOutbound({
      id:                  generateMessageId('sms'),
      channel:             'sms',
      recipient:           dto.to_phone,
      body,
      status:              res.status,
      provider:            res.provider,
      provider_message_id: res.providerMessageId,
      order_id:            dto.order_id,
      tracking_code:       dto.tracking_code,
      error:               res.ok ? undefined : res.message,
    });
    if (saved) results.push(saved);
  }

  // ── WhatsApp ─────────────────────────────────────────────────────────────
  // Usa o mesmo `to_phone` do SMS: é o mesmo número, e pedir dois campos ao
  // chamador só produziria dois sítios onde o número pode divergir.
  //
  // Vai por TEMPLATE e não por texto livre — ver a nota sobre a janela de 24
  // horas em whatsapp.client.js. Uma notificação de logística é quase sempre
  // fora da janela, e texto livre aí não chega ao destinatário.
  if (channels.includes('whatsapp') && dto.to_phone) {
    let res;
    try {
      res = await ports.getWhatsApp().send({ to: dto.to_phone, message: body });
    } catch (err) {
      res = { ok: false, status: 'failed', provider: 'META_CLOUD', message: err.message };
    }
    const saved = await recordOutbound({
      id:                  generateMessageId('whatsapp'),
      channel:             'whatsapp',
      recipient:           dto.to_phone,
      body,
      status:              res.status,
      provider:            res.provider,
      provider_message_id: res.providerMessageId,
      order_id:            dto.order_id,
      tracking_code:       dto.tracking_code,
      error:               res.ok ? undefined : res.message,
    });
    if (saved) results.push(saved);
  }

  // ── Email ────────────────────────────────────────────────────────────────
  if (channels.includes('email') && dto.to_email) {
    let res;
    try {
      res = await ports.getEmail().send({ to: dto.to_email, subject: dto.subject, body });
    } catch (err) {
      res = { ok: false, status: 'failed', provider: 'HTTP', message: err.message };
    }
    const saved = await recordOutbound({
      id:                  generateMessageId('email'),
      channel:             'email',
      recipient:           dto.to_email,
      subject:             dto.subject,
      body,
      status:              res.status,
      provider:            res.provider,
      provider_message_id: res.providerMessageId,
      order_id:            dto.order_id,
      tracking_code:       dto.tracking_code,
      error:               res.ok ? undefined : res.message,
    });
    if (saved) results.push(saved);
  }

  return { results };
}

/**
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function listOutboundMessages(limit = 100) {
  return ports.repo.findAll(limit);
}

/** @returns {Promise<object>} */
async function getMessagingStats() {
  return ports.repo.getStats();
}

/** @returns {{ sms: object, whatsapp: object, email: object }} */
function getProviderInfo() {
  return {
    sms:      { simulated: smsIsSimulated() },
    whatsapp: { simulated: whatsappIsSimulated() },
    email:    { simulated: emailIsSimulated() },
  };
}

module.exports = {
  sendClientMessage,
  listOutboundMessages,
  getMessagingStats,
  getProviderInfo,
  configurePorts,
  resetPorts,
  DEFAULT_PORTS,
};
