/**
 * @file fcm.client.js
 * @description Adaptador para o Firebase Cloud Messaging.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 / § 6 (Canal: FCM)
 *
 * ⚠️  ESTADO ACTUAL: O FCM REAL NÃO ESTÁ LIGADO.
 * Não há credenciais de service account do Firebase neste repositório e nenhuma
 * chamada sai para a Internet. Nenhum push chega a um telemóvel. O que existe é:
 *
 *   1. `SimulatedFcm` — implementação determinística para desenvolvimento e
 *      testes. O desfecho depende do prefixo do token de dispositivo, o que
 *      torna os testes reprodutíveis sem mocks frágeis.
 *   2. A costura onde o SDK real entra (`firebase-admin`).
 *
 * Ao ligar o FCM real:
 *   - `npm i firebase-admin` e inicializar com as credenciais de .env (spec § 4);
 *   - usar `messaging().sendEachForMulticast()` para lotes de tokens;
 *   - manter a forma do retorno, sobretudo `invalidTokens` — é o que permite
 *     limpar tokens mortos (ver nota abaixo).
 *
 * SOBRE TOKENS INVÁLIDOS:
 * O FCM responde `UNREGISTERED` / `INVALID_ARGUMENT` quando a app foi desinstalada
 * ou o token rodou. Esses tokens têm de ser apagados, senão a base enche-se de
 * destinos mortos e a taxa de entrega degrada-se silenciosamente.
 */
'use strict';

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

/**
 * Seleciona o adaptador.
 * Hoje devolve sempre o simulador — o SDK real entra aqui.
 *
 * @returns {typeof SimulatedFcm}
 */
function getFcmClient() {
  return SimulatedFcm;
}

/** true quando nenhum FCM real está configurado — exposto no /health. */
function isSimulated() {
  return true;
}

module.exports = {
  SimulatedFcm,
  getFcmClient,
  isSimulated,
  EmptyTokenListError,
};
