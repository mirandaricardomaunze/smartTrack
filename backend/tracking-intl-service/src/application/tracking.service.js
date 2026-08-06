/**
 * @file tracking.service.js
 * @description Casos de uso do tracking-intl-service.
 *
 * Single Responsibility: lógica de negócio — não conhece HTTP nem SQL.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 8.3
 *
 * O ciclo é: consultar a transportadora → normalizar via StatusMapper →
 * deduplicar → persistir só o que é novo → desativar o acompanhamento quando a
 * encomenda chega a estado final.
 */
'use strict';

const { TrackingRepository } = require('../infrastructure/pg.repository');
const { getCarrierClient, isSimulated } = require('../infrastructure/carrier.client');

const { StatusMapper, OrderStatus } = require('../domain/status-mapper');

const {
  MissingRequiredFieldError,
  TrackingNotFoundError,
  createTrackingEvent,
  dedupeBatch,
  sortNewestFirst,
  currentStatus,
} = require('../domain/tracking-event');

/** Estados a partir dos quais não há mais nada a consultar. */
const ESTADOS_FINAIS = Object.freeze([
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
]);

/**
 * @returns {string}
 */
function generateEventId() {
  const stamp  = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `trk-${stamp}-${random}`;
}

// ─── Costura de dependências ──────────────────────────────────────────────────

/** Mesma abordagem dos outros serviços — ver payments-service. */
const DEFAULT_PORTS = Object.freeze({
  repo:       TrackingRepository,
  getCarrier: getCarrierClient,
});

let ports = { ...DEFAULT_PORTS };

/** @param {object} overrides */
function configurePorts(overrides) {
  ports = { ...ports, ...overrides };
}

/** Repõe a infraestrutura real. */
function resetPorts() {
  ports = { ...DEFAULT_PORTS };
}

// ─── Casos de uso ─────────────────────────────────────────────────────────────

/**
 * Passa um código a ser acompanhado pelo polling.
 *
 * @param {{ tracking_code: string, carrier: string }} dto
 * @returns {Promise<object>}
 */
async function trackShipment(dto) {
  if (!dto || !dto.tracking_code) throw new MissingRequiredFieldError('tracking_code');
  if (!dto.carrier)               throw new MissingRequiredFieldError('carrier');

  if (!StatusMapper.isKnownCarrier(dto.carrier)) {
    throw new MissingRequiredFieldError(
      `carrier (conhecidos: ${StatusMapper.knownCarriers().join(', ')})`,
    );
  }

  const registado = await ports.repo.trackShipment({
    tracking_code: dto.tracking_code.trim().toUpperCase(),
    carrier:       dto.carrier,
  });

  console.info(`[audit] Rastreio ${registado.tracking_code} (${dto.carrier}) em acompanhamento.`);
  return registado;
}

/**
 * Histórico normalizado de uma encomenda.
 *
 * @param {string} trackingCode
 * @returns {Promise<object>}
 */
async function getTracking(trackingCode) {
  if (!trackingCode) throw new MissingRequiredFieldError('tracking_code');

  const code    = trackingCode.trim().toUpperCase();
  const eventos = await ports.repo.findByCode(code);

  if (eventos.length === 0) throw new TrackingNotFoundError(code);

  return {
    tracking_code:  code,
    carrier:        eventos[0].carrier,
    current_status: currentStatus(eventos),
    events:         sortNewestFirst(eventos),
  };
}

/**
 * Consulta a transportadora e persiste apenas o que for novo.
 *
 * @param {{ tracking_code: string, carrier: string }} dto
 * @returns {Promise<object>} relatório da sincronização
 */
async function pollShipment(dto) {
  if (!dto || !dto.tracking_code) throw new MissingRequiredFieldError('tracking_code');
  if (!dto.carrier)               throw new MissingRequiredFieldError('carrier');

  const code   = dto.tracking_code.trim().toUpperCase();
  const client = ports.getCarrier(dto.carrier);

  const resposta = await client.fetchEvents(dto.carrier, code);

  // Falha da transportadora não é falha nossa: não marcamos como consultado,
  // para que o próximo ciclo tente de novo.
  if (resposta.httpCode !== 200) {
    console.warn(`[audit] Polling de ${code} falhou (HTTP ${resposta.httpCode}): ${resposta.message}`);
    return {
      tracking_code: code,
      polled:        false,
      new_events:    0,
      current_status: null,
      message:       resposta.message,
    };
  }

  // Normalização e deduplicação acontecem antes de tocar no banco.
  const normalizados = resposta.events.map((e) =>
    createTrackingEvent(generateEventId(), {
      tracking_code:     code,
      carrier:           dto.carrier,
      raw_status:        e.raw_status,
      carrier_timestamp: e.carrier_timestamp,
      location:          e.location,
      description:       e.description,
    }),
  );

  const inseridos = await ports.repo.insertMany(dedupeBatch(normalizados));

  const estadoAtual = currentStatus(normalizados);
  const finalizado  = estadoAtual !== null && ESTADOS_FINAIS.includes(estadoAtual);

  await ports.repo.markPolled(code, finalizado);

  if (inseridos.length > 0) {
    console.info(
      `[audit] Polling de ${code}: ${inseridos.length} evento(s) novo(s), estado ${estadoAtual}.`,
    );
  }

  return {
    tracking_code:  code,
    polled:         true,
    new_events:     inseridos.length,
    current_status: estadoAtual,
    finished:       finalizado,
    message:        resposta.message,
  };
}

/**
 * Um ciclo completo de polling sobre os códigos ativos.
 *
 * Spec § 6: o rastreio internacional é por polling, não por webhook — as
 * transportadoras não nos notificam.
 *
 * @param {number} [limite]
 * @returns {Promise<object>} relatório agregado
 */
async function runPollingCycle(limite = 100) {
  const codigos = await ports.repo.findCodesToPoll(limite);

  const relatorios = [];
  let novos = 0;
  let falhas = 0;

  for (const { tracking_code, carrier } of codigos) {
    try {
      const r = await pollShipment({ tracking_code, carrier });
      relatorios.push(r);
      novos += r.new_events;
      if (!r.polled) falhas++;
    } catch (err) {
      // Um código problemático não pode parar o ciclo inteiro.
      console.error(`[tracking] Erro ao consultar ${tracking_code}:`, err.message);
      falhas++;
    }
  }

  console.info(
    `[audit] Ciclo de polling: ${codigos.length} código(s), ${novos} evento(s) novo(s), ${falhas} falha(s).`,
  );

  return {
    checked:    codigos.length,
    new_events: novos,
    failures:   falhas,
    reports:    relatorios,
  };
}

/** @returns {Promise<object>} */
async function getStats() {
  return ports.repo.getStats();
}

/**
 * Lista os envios em acompanhamento (com status atual e nº de eventos).
 *
 * @param {number} [limite]
 * @returns {Promise<object[]>}
 */
async function listShipments(limite = 100) {
  return ports.repo.listShipments(limite);
}

/**
 * Transportadoras com mapeamento conhecido (para o formulário de registo).
 *
 * @returns {string[]}
 */
function listCarriers() {
  return StatusMapper.knownCarriers();
}

/**
 * Modo do provedor de rastreio: real (17TRACK com key) ou simulado (fallback).
 *
 * @returns {{ provider: string, simulated: boolean }}
 */
function getProviderInfo() {
  const simulated = isSimulated();
  return { provider: simulated ? 'SIMULATED' : '17TRACK', simulated };
}

module.exports = {
  trackShipment,
  getTracking,
  pollShipment,
  runPollingCycle,
  getStats,
  listShipments,
  listCarriers,
  getProviderInfo,
  generateEventId,
  configurePorts,
  resetPorts,
  DEFAULT_PORTS,
  ESTADOS_FINAIS,
  MissingRequiredFieldError,
  TrackingNotFoundError,
};
