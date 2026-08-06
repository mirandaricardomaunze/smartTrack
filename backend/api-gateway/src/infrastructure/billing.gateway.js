/**
 * @file billing.gateway.js
 * @description Adaptador de cobrança da SUBSCRIÇÃO (plataforma → empresa).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * ESTADO ACTUAL: NENHUM GATEWAY REAL ESTÁ LIGADO. Não existem credenciais de
 * M-Pesa (Vodacom) nem eMola (Movitel) neste repositório e nenhuma chamada sai
 * para a Internet. O que existe é:
 *
 *   1. `SimulatedBillingGateway` — determinístico, para desenvolvimento e testes.
 *      NÃO cobra dinheiro nenhum. O resultado é escolhido pelo número de telemóvel
 *      (ver `charge`), o que torna as duas vias — aprovada e recusada — reprodutíveis.
 *   2. A costura onde o adaptador real entra, já com a chave de idempotência
 *      obrigatória no contrato (proteção contra cobrança dupla).
 *
 * Ao ligar um gateway real: implementar `charge` com o SDK do fornecedor, enviar
 * a `idempotencyKey` no header exigido, ler credenciais de `.env` (nunca
 * hardcoded, spec § 4) e manter a forma do retorno para não mexer no caso de uso.
 *
 * A confirmação MANUAL (transferência bancária validada pelo SUPERADMIN) não
 * passa por aqui — vive em `subscriptions.service.markInvoicePaid`.
 */
'use strict';

/** Métodos de pagamento aceites na cobrança da subscrição. */
const BillingMethod = Object.freeze({
  MPESA:  'mpesa',
  EMOLA:  'emola',
  MANUAL: 'manual_transfer',
});

class MissingIdempotencyKeyError extends Error {
  constructor() {
    super('Cobrança sem chave de idempotência — proibido (risco de cobrança dupla).');
    this.name = 'MissingIdempotencyKeyError';
    this.statusCode = 500;
  }
}

/** Normaliza um número moçambicano: mantém apenas dígitos. */
function normalizeMsisdn(msisdn) {
  return String(msisdn ?? '').replace(/\D/g, '');
}

/**
 * Valida um número de telemóvel moçambicano (84/85 Vodacom, 86/87 Movitel,
 * 82/83 Tmcel), com ou sem indicativo 258.
 * @param {string} msisdn
 * @returns {boolean}
 */
function isValidMsisdn(msisdn) {
  const digits = normalizeMsisdn(msisdn);
  const local = digits.startsWith('258') ? digits.slice(3) : digits;
  return /^8[2-7]\d{7}$/.test(local);
}

/**
 * Gateway simulado, determinístico.
 *
 * O resultado depende do último dígito do número, para que ambas as vias possam
 * ser demonstradas e testadas sem mocks frágeis:
 *   - termina em 0 → recusado (saldo insuficiente) — falha definitiva
 *   - termina em 9 → indisponível — falha temporária, pode retentar
 *   - restantes    → aprovado
 */
const SimulatedBillingGateway = {
  name: 'SIMULATED',

  /**
   * @param {{ idempotencyKey: string, method: string, msisdn: string, amountCents: number, reference: string }} req
   * @returns {Promise<{ approved: boolean, retryable: boolean, transactionId: string|null, message: string }>}
   */
  async charge(req) {
    if (!req.idempotencyKey) throw new MissingIdempotencyKeyError();

    const digits = normalizeMsisdn(req.msisdn);
    const last = digits.slice(-1);

    if (last === '0') {
      return { approved: false, retryable: false, transactionId: null, message: 'Saldo insuficiente na carteira móvel (simulado).' };
    }
    if (last === '9') {
      return { approved: false, retryable: true, transactionId: null, message: 'Operadora temporariamente indisponível (simulado).' };
    }

    // A transação deriva da chave de idempotência: repetir a mesma chave devolve
    // o mesmo id, tal como um gateway real faria.
    const suffix = Buffer.from(req.idempotencyKey).toString('base64url').slice(0, 18).toUpperCase();
    return {
      approved: true,
      retryable: false,
      transactionId: `${String(req.method || 'sim').toUpperCase()}-${suffix}`,
      message: 'Pagamento confirmado (simulado).',
    };
  },
};

/**
 * Seleciona o adaptador de cobrança. Hoje devolve sempre o simulador.
 * @param {string} _method mpesa | emola
 */
function getBillingGateway(_method) {
  return SimulatedBillingGateway;
}

/** true enquanto nenhum gateway real estiver configurado — exposto na API. */
function isSimulated() {
  return true;
}

module.exports = {
  BillingMethod,
  SimulatedBillingGateway,
  getBillingGateway,
  isSimulated,
  isValidMsisdn,
  normalizeMsisdn,
  MissingIdempotencyKeyError,
};
