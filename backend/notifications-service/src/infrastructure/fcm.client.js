/**
 * @file fcm.client.js
 * @description Adaptador para o Firebase Cloud Messaging — simulado por default, real via ambiente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 / § 4 (credenciais só por env) / § 6
 *
 * MODO:
 *   - `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
 *     definidos → `RealFcm`, que fala com a API HTTP v1 do FCM.
 *   - Sem env → `SimulatedFcm` determinista (o desfecho depende do prefixo do
 *     token, o que torna os testes reprodutíveis sem mocks frágeis).
 *
 * PORQUÊ SEM `firebase-admin`: os outros adaptadores desta pasta (email, SMS) e o
 * 17TRACK falam HTTP directo com `fetch`. O SDK traria dezenas de megabytes de
 * dependências para fazer duas chamadas — autenticar e enviar. A autenticação é
 * o fluxo JWT-bearer de service account, que o `crypto` do Node assina sozinho.
 *
 * SOBRE TOKENS INVÁLIDOS:
 * O FCM responde `UNREGISTERED` / `INVALID_ARGUMENT` quando a app foi desinstalada
 * ou o token rodou. Esses tokens têm de ser apagados, senão a base enche-se de
 * destinos mortos e a taxa de entrega degrada-se silenciosamente. É o
 * `notifications.service` que os remove, a partir do `invalidTokens` devolvido
 * aqui — por isso ambos os adaptadores têm de o preencher com rigor.
 */
'use strict';

const crypto = require('node:crypto');

const TIMEOUT_MS = () => Number(process.env.FCM_TIMEOUT_MS) || 10_000;
/** Envios em paralelo. A API HTTP v1 é um token por pedido: não há multicast. */
const MAX_CONCURRENCY = 10;

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function projectId()   { return process.env.FIREBASE_PROJECT_ID; }
function clientEmail() { return process.env.FIREBASE_CLIENT_EMAIL; }

/**
 * A chave privada vem do .env com os `\n` escapados — um ficheiro .env não tem
 * como guardar quebras de linha reais. Sem isto, o PEM não é reconhecido.
 */
function privateKey() {
  const raw = process.env.FIREBASE_PRIVATE_KEY;
  return raw ? String(raw).replace(/\\n/g, '\n') : undefined;
}

/**
 * @typedef {object} PushRequest
 * @property {string[]} tokens Tokens de dispositivo do destinatário
 * @property {string} title
 * @property {string} body
 * @property {object} [data] Payload livre entregue à app
 */

/**
 * @typedef {object} PushResponse
 * @property {number|null} httpCode Código do FCM; null em erro de rede/timeout
 * @property {number} successCount
 * @property {number} failureCount
 * @property {string[]} invalidTokens Tokens a remover da base
 * @property {string} message
 */

class EmptyTokenListError extends Error {
  constructor() {
    super('Tentativa de envio sem nenhum token de dispositivo.');
    this.name = 'EmptyTokenListError';
    this.statusCode = 400;
  }
}

/**
 * FCM simulado, determinístico.
 *
 * O desfecho de cada token depende do seu prefixo:
 *   - `dead-`    → token inválido (a devolver para limpeza)
 *   - `fail-`    → falha transitória nesse token
 *   - `outage-`  → derruba a chamada inteira com 503 (retentável)
 *   - `timeout-` → erro de rede (httpCode null, retentável)
 *   - restantes  → entregue
 */
const SimulatedFcm = {
  name: 'SIMULATED',

  /**
   * @param {PushRequest} req
   * @returns {Promise<PushResponse>}
   */
  async send(req) {
    if (!Array.isArray(req.tokens) || req.tokens.length === 0) {
      throw new EmptyTokenListError();
    }

    if (req.tokens.some((t) => t.startsWith('outage-'))) {
      return {
        httpCode: 503,
        successCount: 0,
        failureCount: req.tokens.length,
        invalidTokens: [],
        message: 'FCM indisponível (simulado).',
      };
    }

    if (req.tokens.some((t) => t.startsWith('timeout-'))) {
      return {
        httpCode: null,
        successCount: 0,
        failureCount: req.tokens.length,
        invalidTokens: [],
        message: 'Timeout de rede (simulado).',
      };
    }

    const invalidos = req.tokens.filter((t) => t.startsWith('dead-'));
    const falhados  = req.tokens.filter((t) => t.startsWith('fail-'));
    const entregues = req.tokens.filter(
      (t) => !t.startsWith('dead-') && !t.startsWith('fail-'),
    );

    return {
      httpCode: 200,
      successCount: entregues.length,
      failureCount: invalidos.length + falhados.length,
      invalidTokens: invalidos,
      message: `Entregue a ${entregues.length}/${req.tokens.length} dispositivo(s) (simulado).`,
    };
  },
};

// ─── FCM real (HTTP v1) ──────────────────────────────────────────────────────

/** base64url sem padding, como o JWT exige. */
function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * JWT assinado com a chave da service account. PURA (dado um relógio).
 *
 * @param {number} nowSeconds
 * @returns {string}
 */
function buildAssertion(nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss:   clientEmail(),
    scope: FCM_SCOPE,
    aud:   OAUTH_TOKEN_URL,
    iat:   nowSeconds,
    exp:   nowSeconds + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(privateKey());
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * Cache do access token. Vale uma hora; pedir um novo a cada push seria uma ida
 * extra à rede por notificação. Renovamos 5 minutos antes de expirar, para uma
 * chamada nunca apanhar o token a morrer a meio.
 */
let cachedToken = { value: null, expiresAt: 0 };

/** Esquece o token em cache. Existe para os testes — e para o rollover de credenciais. */
function resetAccessToken() {
  cachedToken = { value: null, expiresAt: 0 };
}

/**
 * @returns {Promise<string>} access token OAuth2
 * @throws quando as credenciais são recusadas — é erro de configuração, não de rede.
 */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.value && cachedToken.expiresAt > now + 300) return cachedToken.value;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  buildAssertion(now),
  });

  const res = await fetch(OAUTH_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
    signal:  AbortSignal.timeout(TIMEOUT_MS()),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Credenciais do Firebase recusadas (${data.error ?? `HTTP ${res.status}`}).`);
  }

  cachedToken = { value: data.access_token, expiresAt: now + (Number(data.expires_in) || 3600) };
  return cachedToken.value;
}

/**
 * Um token é irrecuperável? Só nesse caso vai para `invalidTokens` e é apagado.
 *
 * A distinção importa: um 503 é o FCM a estar em baixo e o token continua bom;
 * apagá-lo por causa disso seria perder o dispositivo por uma falha passageira.
 *
 * @param {number} status
 * @param {object} payload corpo de erro do FCM
 */
function isDeadToken(status, payload) {
  if (status === 404) return true; // UNREGISTERED — app desinstalada ou token rodado
  if (status !== 400) return false;
  const reason = payload?.error?.details?.find((d) => d.errorCode)?.errorCode
    ?? payload?.error?.status;
  return reason === 'UNREGISTERED' || reason === 'INVALID_ARGUMENT';
}

/** Envia para um token. Nunca lança: o desfecho é sempre classificado. */
async function sendToToken(accessToken, token, req) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId()}/messages:send`;
  const message = {
    token,
    notification: { title: req.title, body: req.body },
    // O FCM só aceita strings em `data`; qualquer outra coisa é recusada com 400.
    ...(req.data ? { data: Object.fromEntries(Object.entries(req.data).map(([k, v]) => [k, String(v)])) } : {}),
  };

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body:    JSON.stringify({ message }),
      signal:  AbortSignal.timeout(TIMEOUT_MS()),
    });
    if (res.ok) return { ok: true, token, status: res.status };

    const payload = await res.json().catch(() => ({}));
    return { ok: false, token, status: res.status, dead: isDeadToken(res.status, payload) };
  } catch (err) {
    // Rede caída ou timeout: falha retentável, o token continua válido.
    return { ok: false, token, status: null, dead: false, networkError: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

const RealFcm = {
  name: 'FCM',

  /**
   * @param {PushRequest} req
   * @returns {Promise<PushResponse>}
   */
  async send(req) {
    if (!Array.isArray(req.tokens) || req.tokens.length === 0) {
      throw new EmptyTokenListError();
    }

    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (err) {
      // Sem token não há envio nenhum. Não marcamos dispositivos como inválidos:
      // o problema é nosso, não deles.
      return {
        httpCode: null,
        successCount: 0,
        failureCount: req.tokens.length,
        invalidTokens: [],
        message: `FCM indisponível: ${err.message}`,
      };
    }

    const results = [];
    for (let i = 0; i < req.tokens.length; i += MAX_CONCURRENCY) {
      const lote = req.tokens.slice(i, i + MAX_CONCURRENCY);
      results.push(...await Promise.all(lote.map((token) => sendToToken(accessToken, token, req))));
    }

    const entregues = results.filter((r) => r.ok);
    const invalidos = results.filter((r) => r.dead).map((r) => r.token);
    const httpCode  = entregues.length > 0 ? 200 : (results.find((r) => r.status !== null)?.status ?? null);

    return {
      httpCode,
      successCount:  entregues.length,
      failureCount:  results.length - entregues.length,
      invalidTokens: invalidos,
      message: `Entregue a ${entregues.length}/${results.length} dispositivo(s).`
        + (invalidos.length ? ` ${invalidos.length} token(s) a remover.` : ''),
    };
  },
};

/** true quando nenhum FCM real está configurado — exposto no /health. */
function isSimulated() {
  return !(projectId() && clientEmail() && privateKey());
}

/**
 * Seleciona o adaptador conforme o ambiente.
 * @returns {typeof SimulatedFcm | typeof RealFcm}
 */
function getFcmClient() {
  return isSimulated() ? SimulatedFcm : RealFcm;
}

module.exports = {
  SimulatedFcm,
  RealFcm,
  getFcmClient,
  isSimulated,
  resetAccessToken,
  buildAssertion,
  isDeadToken,
  EmptyTokenListError,
};
