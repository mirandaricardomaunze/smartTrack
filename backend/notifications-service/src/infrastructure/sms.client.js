/**
 * @file sms.client.js
 * @description Adaptador de SMS — simulado por default, real via ambiente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3, § 4 (credenciais só por env)
 *
 * MODO:
 *   - `SMS_API_URL` + `SMS_API_KEY` definidos → cliente REAL (POST HTTP genérico
 *     { to, message } com Bearer key). Adaptar a forma ao provedor real é como no 17TRACK.
 *   - Sem env → `SimulatedSms` determinista (número terminado em '0' → falha; resto → enviado).
 *
 * Devolve sempre { ok, status, providerMessageId?, provider, message } — nunca lança
 * por causa da rede (o messaging.service trata best-effort).
 */
'use strict';

const TIMEOUT_MS = () => Number(process.env.SMS_TIMEOUT_MS) || 8_000;

function apiUrl() { return process.env.SMS_API_URL; }
function apiKey() { return process.env.SMS_API_KEY; }

/** true quando não há provedor real configurado. */
function isSimulated() {
  return !(apiUrl() && apiKey());
}

const SimulatedSms = {
  provider: 'SIMULATED',
  /**
   * @param {{ to: string, message: string }} req
   * @returns {Promise<{ ok: boolean, status: string, providerMessageId?: string, provider: string, message: string }>}
   */
  async send(req) {
    const to = String(req.to ?? '').trim();
    const failed = to.endsWith('0'); // determinista para testes
    return failed
      ? { ok: false, status: 'failed', provider: 'SIMULATED', message: 'Número recusado (simulado).' }
      : { ok: true, status: 'simulated', provider: 'SIMULATED', providerMessageId: `sim-${Date.now().toString(36)}`, message: 'SMS simulado (sem provedor real).' };
  },
};

const RealSms = {
  provider: 'HTTP',
  async send(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({ to: req.to, message: req.message }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, status: 'failed', provider: 'HTTP', message: `SMS HTTP ${res.status}.` };
      }
      return { ok: true, status: 'sent', provider: 'HTTP', providerMessageId: data.id || data.message_id, message: 'SMS enviado.' };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      return { ok: false, status: 'failed', provider: 'HTTP', message: `SMS indisponível: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** @returns {typeof SimulatedSms | typeof RealSms} */
function getSmsClient() {
  return isSimulated() ? SimulatedSms : RealSms;
}

module.exports = { SimulatedSms, RealSms, getSmsClient, isSimulated };
