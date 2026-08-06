/**
 * @file track17.client.js
 * @description Cliente HTTP REAL da API 17TRACK (v2.2) — agregador multi-transportadora.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6, § 3.10 (rastreio internacional)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (credenciais só via ambiente)
 *
 * Contrato 17TRACK v2.2 (https://api.17track.net/track/v2.2):
 *   - Autenticação: header `17token: <API_KEY>`.
 *   - Registar um número (uma vez) antes de o consultar:
 *       POST /register        body: [{ number, auto_detection: true }]
 *   - Obter o histórico:
 *       POST /gettrackinfo    body: [{ number, auto_detection: true }]
 *     Resposta: { code: 0, data: { accepted: [{ number, track_info:{
 *                 tracking:{ providers:[{ events:[{ time_iso, stage, sub_status,
 *                 description, location }] }] } } }], rejected: [...] } }
 *
 * A key NUNCA está no código — lida de `TRACK17_API_KEY`. Devolve leituras CRUAS
 * (o `raw_status` é o `stage` do 17TRACK); a normalização é do StatusMapper.
 *
 * Variáveis de ambiente:
 *   TRACK17_API_KEY     (obrigatória para o modo real)
 *   TRACK17_BASE_URL    (default https://api.17track.net/track/v2.2)
 *   TRACK17_TIMEOUT_MS  (default 10000)
 */
'use strict';

const DEFAULT_BASE_URL = 'https://api.17track.net/track/v2.2';

class Track17NotConfiguredError extends Error {
  constructor() {
    super('Rastreio real indisponível: defina TRACK17_API_KEY no ambiente.');
    this.name = 'Track17NotConfiguredError';
    this.statusCode = 503;
  }
}

function apiKey()   { return process.env.TRACK17_API_KEY; }
function baseUrl()  { return process.env.TRACK17_BASE_URL || DEFAULT_BASE_URL; }
function timeoutMs() { return Number(process.env.TRACK17_TIMEOUT_MS) || 10_000; }

/**
 * POST autenticado à API 17TRACK, com timeout.
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<{ httpStatus: number, json: any }>}
 */
async function post17(path, body) {
  const key = apiKey();
  if (!key) throw new Track17NotConfiguredError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method:  'POST',
      headers: { '17token': key, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { httpStatus: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Um número foi rejeitado por ainda não estar registado? */
function wasRejected(json, number) {
  const rejected = json?.data?.rejected;
  if (!Array.isArray(rejected)) return false;
  return rejected.some((r) => r && r.number === number);
}

/** Extrai a entrada aceite de um número na resposta gettrackinfo. */
function acceptedFor(json, number) {
  const accepted = json?.data?.accepted;
  if (!Array.isArray(accepted)) return null;
  return accepted.find((a) => a && a.number === number) ?? accepted[0] ?? null;
}

/**
 * Achata os eventos de todos os providers de uma entrada track_info → leituras cruas.
 * @param {object} accepted
 * @returns {Array<{ raw_status: string, carrier_timestamp: string, location: string|null, description: string|null }>}
 */
function extractEvents(accepted) {
  const providers = accepted?.track_info?.tracking?.providers;
  if (!Array.isArray(providers)) return [];

  const out = [];
  for (const p of providers) {
    for (const e of (p?.events ?? [])) {
      const rawStatus = e.stage || e.sub_status || e.description;
      if (!rawStatus) continue; // sem status → não é uma leitura útil
      const location = typeof e.location === 'string' && e.location
        ? e.location
        : (e.address && (e.address.city || e.address.country)) || null;
      out.push({
        raw_status:        String(rawStatus),
        carrier_timestamp: e.time_iso || e.time_utc || new Date().toISOString(),
        location:          location || null,
        description:       e.description || null,
      });
    }
  }
  return out;
}

const Track17Client = {
  name: '17TRACK',

  /**
   * Consulta o histórico real de um número no 17TRACK.
   *
   * Mantém o MESMO contrato do simulador para o tracking.service:
   *   - httpCode 200 → sucesso (mesmo que 0 eventos);
   *   - httpCode !== 200 → falha da transportadora (não marca como consultado).
   *
   * @param {string} _carrier  ignorado: o 17TRACK auto-deteta a transportadora
   * @param {string} trackingCode
   * @returns {Promise<{ httpCode: number|null, events: object[], message: string }>}
   */
  async fetchEvents(_carrier, trackingCode) {
    const number = String(trackingCode).trim();

    // Erro de configuração (não transitório): surge distinto, não é "retry".
    if (!apiKey()) throw new Track17NotConfiguredError();

    try {
      let res = await post17('/gettrackinfo', [{ number, auto_detection: true }]);

      // HTTP não-2xx → falha (retry no próximo ciclo).
      if (res.httpStatus < 200 || res.httpStatus >= 300) {
        return { httpCode: res.httpStatus, events: [], message: `17TRACK HTTP ${res.httpStatus}.` };
      }
      // Erro lógico da API (code !== 0).
      if (res.json && typeof res.json.code === 'number' && res.json.code !== 0) {
        return { httpCode: 502, events: [], message: `17TRACK code ${res.json.code}.` };
      }

      // Número ainda não registado → registar e repetir uma vez.
      if (!acceptedFor(res.json, number) && wasRejected(res.json, number)) {
        await post17('/register', [{ number, auto_detection: true }]);
        res = await post17('/gettrackinfo', [{ number, auto_detection: true }]);
        if (res.httpStatus < 200 || res.httpStatus >= 300) {
          return { httpCode: res.httpStatus, events: [], message: `17TRACK HTTP ${res.httpStatus} (após registo).` };
        }
      }

      const accepted = acceptedFor(res.json, number);
      const events = accepted ? extractEvents(accepted) : [];
      return { httpCode: 200, events, message: `${events.length} evento(s) (17TRACK).` };
    } catch (err) {
      // Rede/timeout: tratado como indisponibilidade da transportadora.
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      return { httpCode: 503, events: [], message: `17TRACK indisponível: ${reason}.` };
    }
  },
};

/** true quando há API key configurada (modo real ativo). */
function isConfigured() {
  return Boolean(apiKey());
}

module.exports = {
  Track17Client,
  Track17NotConfiguredError,
  isConfigured,
  // exportados para teste
  extractEvents,
  acceptedFor,
  wasRejected,
};
