/**
 * @file carrier.client.js
 * @description Adaptador para as APIs das transportadoras internacionais.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Rastreio internacional)
 *
 * MODO DE OPERAÇÃO (decidido em runtime por `getCarrierClient`):
 *   - `TRACK17_API_KEY` definido  → cliente REAL 17TRACK (track17.client.js),
 *     que faz chamadas reais à API e auto-deteta a transportadora.
 *   - Sem key                     → `SimulatedCarrier` (fallback de dev/testes),
 *     históricos determinísticos derivados do código. Emite aviso: não são dados
 *     reais.
 *
 * A normalização (raw → status canônico) é SEMPRE do StatusMapper, nunca aqui.
 */
'use strict';

const { Track17Client, isConfigured: track17Configured } = require('./track17.client');

class UnsupportedCarrierError extends Error {
  /** @param {string} carrier */
  constructor(carrier) {
    super(`Transportadora não suportada: ${carrier}`);
    this.name = 'UnsupportedCarrierError';
    this.statusCode = 400;
  }
}

/**
 * @typedef {object} RawCarrierEvent
 * @property {string} raw_status Valor tal como a transportadora o devolve
 * @property {string} carrier_timestamp ISO8601
 * @property {string} [location]
 * @property {string} [description]
 */

/**
 * Históricos simulados por transportadora.
 * Cada entrada é um percurso plausível, do mais antigo para o mais recente.
 */
const PERCURSOS = Object.freeze({
  '17TRACK': [
    { raw_status: 'Picked up',            location: 'Shenzhen, CN',  description: 'Encomenda recolhida' },
    { raw_status: 'In Transit',           location: 'Hong Kong',     description: 'Em trânsito internacional' },
    { raw_status: 'Arrived at warehouse', location: 'Maputo, MZ',    description: 'Chegada ao hub nacional' },
    { raw_status: 'Out for Delivery',     location: 'Maputo, MZ',    description: 'Saiu para entrega' },
  ],
  'CAINIAO': [
    { raw_status: 'PACKAGE_ARRIVED',    location: 'Guangzhou, CN', description: 'Pacote no centro' },
    { raw_status: 'PACKAGE_DELIVERING', location: 'Maputo, MZ',    description: 'Em distribuição' },
    { raw_status: 'SIGN_IN',            location: 'Maputo, MZ',    description: 'Assinado pelo destinatário' },
  ],
  'CORREIOS_BR': [
    { raw_status: 'Objeto em transferência - por favor aguarde', location: 'São Paulo, BR' },
    { raw_status: 'Objeto saiu para entrega ao destinatário',    location: 'São Paulo, BR' },
  ],
});

/**
 * Transportadora simulada, determinística.
 *
 * Quantos eventos devolve depende do código de rastreio, para que os testes
 * possam exercitar percursos parciais sem mocks:
 *   - termina em `-ERR` → erro da API (503)
 *   - termina em `-EMPTY` → sem eventos ainda
 *   - restantes → tantos eventos quantos o último dígito do código (mín. 1)
 */
const SimulatedCarrier = {
  name: 'SIMULATED',

  /**
   * @param {string} carrier
   * @param {string} trackingCode
   * @returns {Promise<{ httpCode: number|null, events: RawCarrierEvent[], message: string }>}
   */
  async fetchEvents(carrier, trackingCode) {
    const percurso = PERCURSOS[carrier];
    if (!percurso) throw new UnsupportedCarrierError(carrier);

    if (trackingCode.endsWith('-ERR')) {
      return { httpCode: 503, events: [], message: 'API da transportadora indisponível (simulado).' };
    }
    if (trackingCode.endsWith('-EMPTY')) {
      return { httpCode: 200, events: [], message: 'Sem eventos para este código (simulado).' };
    }

    const digitos = trackingCode.replace(/\D/g, '');
    const ultimo  = digitos.length > 0 ? Number(digitos[digitos.length - 1]) : 1;
    const quantos = Math.min(Math.max(ultimo, 1), percurso.length);

    // Timestamps determinísticos: espaçados de 1 dia, o mais antigo primeiro.
    const base = Date.parse('2026-07-01T08:00:00.000Z');

    const events = percurso.slice(0, quantos).map((e, i) => ({
      ...e,
      carrier_timestamp: new Date(base + i * 86_400_000).toISOString(),
    }));

    return { httpCode: 200, events, message: `${events.length} evento(s) (simulado).` };
  },
};

let _warnedSimulated = false;

/**
 * Seleciona o cliente da transportadora.
 *
 * Com `TRACK17_API_KEY` definido, devolve o cliente REAL do 17TRACK (agregador,
 * auto-deteção). Sem key, cai no simulador determinístico e avisa uma vez.
 *
 * @param {string} _carrier
 * @returns {typeof SimulatedCarrier | typeof Track17Client}
 */
function getCarrierClient(_carrier) {
  if (track17Configured()) {
    return Track17Client;
  }
  if (!_warnedSimulated) {
    console.warn('[carrier] SEM TRACK17_API_KEY — a usar o simulador (dados NÃO reais). Defina a key para rastreio real.');
    _warnedSimulated = true;
  }
  return SimulatedCarrier;
}

/** true quando nenhuma transportadora real está configurada — exposto no /health. */
function isSimulated() {
  return !track17Configured();
}

module.exports = {
  SimulatedCarrier,
  getCarrierClient,
  isSimulated,
  UnsupportedCarrierError,
  PERCURSOS,
};
