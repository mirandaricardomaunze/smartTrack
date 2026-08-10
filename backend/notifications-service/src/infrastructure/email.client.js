/**
 * @file email.client.js
 * @description Adaptador de email — simulado por default, real via ambiente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3, § 4 (credenciais só por env)
 *
 * MODO:
 *   - `RESEND_API_KEY` + `EMAIL_FROM` definidos → Resend (API oficial).
 *   - `EMAIL_API_URL` + `EMAIL_API_KEY` definidos → cliente REAL (POST HTTP genérico
 *     { to, subject, body }). Para SMTP/SendGrid/Mailgun, ajustar a forma do pedido aqui.
 *   - Sem env → `SimulatedEmail` determinista (endereço sem '@' → falha; resto → enviado).
 */
'use strict';

const TIMEOUT_MS = () => Number(process.env.EMAIL_TIMEOUT_MS) || 8_000;

function apiUrl() { return process.env.EMAIL_API_URL; }
function apiKey() { return process.env.EMAIL_API_KEY; }
function resendApiKey() { return process.env.RESEND_API_KEY; }
function emailFrom() { return process.env.EMAIL_FROM; }

/** true quando não há provedor real configurado. */
function isSimulated() {
  return !((resendApiKey() && emailFrom()) || (apiUrl() && apiKey()));
}

const SimulatedEmail = {
  provider: 'SIMULATED',
  /**
   * @param {{ to: string, subject: string, body: string }} req
   * @returns {Promise<{ ok: boolean, status: string, providerMessageId?: string, provider: string, message: string }>}
   */
  async send(req) {
    const to = String(req.to ?? '').trim();
    const invalid = !to.includes('@');
    return invalid
      ? { ok: false, status: 'failed', provider: 'SIMULATED', message: 'Email inválido (simulado).' }
      : { ok: true, status: 'simulated', provider: 'SIMULATED', providerMessageId: `sim-${Date.now().toString(36)}`, message: 'Email simulado (sem provedor real).' };
  },
};

const RealEmail = {
  provider: 'HTTP',
  async send(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({ to: req.to, subject: req.subject, body: req.body }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, status: 'failed', provider: 'HTTP', message: `Email HTTP ${res.status}.` };
      }
      return { ok: true, status: 'sent', provider: 'HTTP', providerMessageId: data.id || data.message_id, message: 'Email enviado.' };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      return { ok: false, status: 'failed', provider: 'HTTP', message: `Email indisponível: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }
  },
};

const ResendEmail = {
  provider: 'RESEND',
  async send(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resendApiKey()}`,
        },
        body: JSON.stringify({
          from: emailFrom(),
          to: [req.to],
          subject: req.subject || 'Atualização da sua encomenda',
          text: req.body,
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
        return { ok: false, status: 'failed', provider: 'RESEND', message: `Resend: ${detail}.` };
      }
      return { ok: true, status: 'sent', provider: 'RESEND', providerMessageId: data.id, message: 'Email enviado.' };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      return { ok: false, status: 'failed', provider: 'RESEND', message: `Resend indisponível: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** @returns {typeof SimulatedEmail | typeof RealEmail} */
function getEmailClient() {
  if (resendApiKey() && emailFrom()) return ResendEmail;
  return isSimulated() ? SimulatedEmail : RealEmail;
}

module.exports = { SimulatedEmail, RealEmail, ResendEmail, getEmailClient, isSimulated };
