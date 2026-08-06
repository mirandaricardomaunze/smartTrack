/**
 * @file tracking-event.js
 * @description Entidade EventoRastreio — um acontecimento normalizado no
 * percurso de uma encomenda internacional.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — EventoRastreio)
 *           docs/spec/especificacao-tecnica-v1.md § 8.3 (Status internacional → interno)
 *
 * REGRAS DE DOMÍNIO:
 * - O status canônico vem SEMPRE do StatusMapper — nunca do valor cru.
 * - O valor cru é preservado em `raw_status` para auditoria: quando um
 *   mapeamento estiver errado, é a única forma de descobrir porquê.
 * - Funções puras: nunca mutam o argumento.
 *
 * DEDUPLICAÇÃO:
 * O polling relê a mesma página da transportadora de minuto a minuto e devolve
 * sempre o histórico completo. Sem deduplicação, o histórico do cliente encheria
 * de repetições. A chave é determinística — ver `buildEventHash`.
 */
'use strict';

const { createHash } = require('node:crypto');
const { StatusMapper } = require('./status-mapper');

class MissingRequiredFieldError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Campo obrigatório em falta: ${field}`);
    this.name = 'MissingRequiredFieldError';
    this.statusCode = 400;
  }
}

class TrackingNotFoundError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`Rastreio não encontrado: ${code}`);
    this.name = 'TrackingNotFoundError';
    this.statusCode = 404;
  }
}

/**
 * Identidade determinística de um evento.
 *
 * Inclui o timestamp DA TRANSPORTADORA (não o nosso): dois eventos com o mesmo
 * status em momentos diferentes são acontecimentos distintos — "saiu para
 * entrega" pode repetir-se legitimamente após um insucesso. Já o mesmo status
 * no mesmo instante é sempre a mesma leitura relida.
 *
 * @param {{ tracking_code: string, carrier: string, raw_status: string, carrier_timestamp: string, location?: string }} evento
 * @returns {string} hex de 32 caracteres
 */
function buildEventHash(evento) {
  const material = [
    evento.tracking_code,
    evento.carrier,
    evento.raw_status,
    evento.carrier_timestamp,
    evento.location ?? '',
  ].join('|');

  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * Cria um EventoRastreio normalizado a partir de uma leitura crua.
 *
 * @param {string} id
 * @param {{
 *   tracking_code: string,
 *   carrier: string,
 *   raw_status: string,
 *   carrier_timestamp: string,
 *   location?: string,
 *   description?: string
 * }} dto
 * @returns {object}
 */
function createTrackingEvent(id, dto) {
  if (!dto.tracking_code)     throw new MissingRequiredFieldError('tracking_code');
  if (!dto.carrier)           throw new MissingRequiredFieldError('carrier');
  if (!dto.raw_status)        throw new MissingRequiredFieldError('raw_status');
  if (!dto.carrier_timestamp) throw new MissingRequiredFieldError('carrier_timestamp');

  // A normalização acontece aqui, uma única vez, antes de persistir.
  const canonico = StatusMapper.map(dto.carrier, dto.raw_status);

  return {
    id,
    tracking_code:     dto.tracking_code,
    carrier:           dto.carrier,
    /** Valor canônico — é este que o resto do sistema consome. */
    status:            canonico,
    /** Valor original da transportadora — só para auditoria. */
    raw_status:        dto.raw_status,
    location:          dto.location ?? null,
    description:       dto.description ?? null,
    carrier_timestamp: dto.carrier_timestamp,
    event_hash:        buildEventHash(dto),
    created_at:        new Date().toISOString(),
  };
}

/**
 * Remove repetições dentro de um lote, preservando a ordem de chegada.
 * O polling devolve o histórico completo a cada leitura.
 *
 * @param {object[]} eventos
 * @returns {object[]}
 */
function dedupeBatch(eventos) {
  const vistos = new Set();
  const unicos = [];

  for (const evento of eventos) {
    if (vistos.has(evento.event_hash)) continue;
    vistos.add(evento.event_hash);
    unicos.push(evento);
  }

  return unicos;
}

/**
 * Ordena eventos do mais recente para o mais antigo — é a ordem em que o
 * cliente espera ver o histórico.
 *
 * @param {object[]} eventos
 * @returns {object[]} novo array
 */
function sortNewestFirst(eventos) {
  return [...eventos].sort(
    (a, b) => new Date(b.carrier_timestamp).getTime() - new Date(a.carrier_timestamp).getTime(),
  );
}

/**
 * Status atual de uma encomenda: o do evento mais recente da transportadora.
 *
 * @param {object[]} eventos
 * @returns {string|null} null se não houver eventos
 */
function currentStatus(eventos) {
  if (!Array.isArray(eventos) || eventos.length === 0) return null;
  return sortNewestFirst(eventos)[0].status;
}

module.exports = {
  MissingRequiredFieldError,
  TrackingNotFoundError,
  buildEventHash,
  createTrackingEvent,
  dedupeBatch,
  sortNewestFirst,
  currentStatus,
};
