/**
 * @file gateway.client.js
 * @description Adaptador para os gateways de pagamento.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md § regra 1
 *   "Never call the gateway without an idempotency_key set in the request header."
 *
 * ⚠️  ESTADO ACTUAL: NENHUM GATEWAY REAL ESTÁ LIGADO.
 * Não há credenciais de Mercado Pago, Stripe ou PagSeguro neste repositório e
 * nenhuma chamada sai para a Internet. O que existe aqui é:
 *
 *   1. `SimulatedGateway` — implementação determinística para desenvolvimento e
 *      testes. NÃO cobra dinheiro nenhum. O comportamento é escolhido pelo valor
 *      do pedido (ver `decideOutcome`), o que torna os testes reprodutíveis.
 *   2. A costura (`GatewayClient`) onde os adaptadores reais entram, já com a
 *      chave de idempotência obrigatória no contrato.
 *
 * Ao ligar um gateway real:
 *   - implementar `charge`/`refund` com o SDK respectivo;
 *   - enviar `idempotencyKey` no header exigido pelo fornecedor
 *     (Stripe: `Idempotency-Key`; Mercado Pago: `X-Idempotency-Key`);
 *   - ler as credenciais de .env, nunca hardcoded (spec § 4);
 *   - manter a forma do retorno para não mexer no caso de uso.
 */
'use strict';

/**
 * @typedef {object} ChargeRequest
 * @property {string} idempotencyKey Obrigatória — protege contra cobrança dupla
 * @property {string} orderId
 * @property {number} value Centavos inteiros
 * @property {string} gateway
 */

/**
 * @typedef {object} ChargeResponse
 * @property {number|null} httpCode Código do gateway; null em erro de rede/timeout
 * @property {string|null} transactionId Preenchido apenas em sucesso
 * @property {string} message
 */

class MissingIdempotencyKeyError extends Error {
  constructor() {
    super('Chamada ao gateway sem idempotency_key — proibido pela regra 1 da skill.');
    this.name = 'MissingIdempotencyKeyError';
    this.statusCode = 500;
  }
}

/**
 * Gateway simulado, determinístico.
 *
 * O resultado depende do valor em centavos, para que os testes possam exercitar
 * cada ramo sem mocks frágeis:
 *   - termina em 02 → 402 Payment Required (falha definitiva, não retentar)
 *   - termina em 22 → 422 Unprocessable  (falha definitiva, não retentar)
 *   - termina em 03 → 503 Service Unavailable (retentável)
 *   - termina em 99 → erro de rede (httpCode null, retentável)
 *   - restantes    → 200 sucesso
 */
const SimulatedGateway = {
  name: 'SIMULATED',

  /**
   * @param {ChargeRequest} req
   * @returns {Promise<ChargeResponse>}
   */
  async charge(req) {
    if (!req.idempotencyKey) throw new MissingIdempotencyKeyError();

    const sufixo = req.value % 100;

    if (sufixo === 2) {
      return { httpCode: 402, transactionId: null, message: 'Fundos insuficientes (simulado).' };
    }
    if (sufixo === 22) {
      return { httpCode: 422, transactionId: null, message: 'Dados de pagamento inválidos (simulado).' };
    }
    if (sufixo === 3) {
      return { httpCode: 503, transactionId: null, message: 'Gateway indisponível (simulado).' };
    }
    if (sufixo === 99) {
      return { httpCode: null, transactionId: null, message: 'Timeout de rede (simulado).' };
    }

    // A transação é derivada da chave de idempotência: repetir a mesma chave
    // devolve o mesmo transactionId, tal como um gateway real faria.
    return {
      httpCode: 200,
      transactionId: `sim-tx-${Buffer.from(req.idempotencyKey).toString('base64url').slice(0, 24)}`,
      message: 'Cobrança aprovada (simulado).',
    };
  },

  /**
   * @param {{ idempotencyKey: string, transactionId: string }} req
   * @returns {Promise<ChargeResponse>}
   */
  async refund(req) {
    if (!req.idempotencyKey) throw new MissingIdempotencyKeyError();

    return {
      httpCode: 200,
      transactionId: `sim-refund-${req.transactionId}`,
      message: 'Estorno aprovado (simulado).',
    };
  },
};

/**
 * Seleciona o adaptador.
 * Hoje devolve sempre o simulador — os adaptadores reais entram aqui.
 *
 * @param {string} _gateway MERCADO_PAGO | STRIPE | PAGSEGURO
 * @returns {typeof SimulatedGateway}
 */
function getGatewayClient(_gateway) {
  return SimulatedGateway;
}

/** true quando nenhum gateway real está configurado — exposto no /health. */
function isSimulated() {
  return true;
}

module.exports = {
  SimulatedGateway,
  getGatewayClient,
  isSimulated,
  MissingIdempotencyKeyError,
};
