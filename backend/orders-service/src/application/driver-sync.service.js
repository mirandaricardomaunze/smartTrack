/**
 * @file driver-sync.service.js
 * @description Sincronização de eventos offline do app do motorista.
 *
 * Single Responsibility: lógica de negócio — não conhece HTTP nem SQL.
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 8.1
 *
 * Cada evento do lote passa por quatro portões, por esta ordem:
 *   1. Idempotência — já processado? (regra 5) → salta
 *   2. Pedido existe? → salta
 *   3. Resolução de conflitos (regra 4) → decide e SEMPRE regista se houver conflito
 *   4. Transição válida? → aplica ou salta
 *
 * O lote inteiro é ordenado por device_timestamp ASC antes de começar (regra 2):
 * aplicar um "entregue" antes de um "coletado" mais antigo deixaria o estado errado.
 */
'use strict';

const { randomUUID } = require('node:crypto');

const { OrderRepository } = require('../infrastructure/pg.repository');

const {
  MissingRequiredFieldError,
  toCanonicalStatus,
  buildDedupeKey,
  validateSyncEvent,
  sortChronological,
} = require('../domain/sync-event');

const {
  EventType,
  resolveConflict,
  isConflict,
} = require('../domain/conflict-resolver');

const { isValidTransition } = require('./order-status-rules');

/** Máximo de eventos por lote (skill regra 3). */
const MAX_BATCH_SIZE = 50;

// ─── Costura de dependências ──────────────────────────────────────────────────

const DEFAULT_PORTS = Object.freeze({ repo: OrderRepository, applyFinalStatus: null });
let ports = { ...DEFAULT_PORTS };

/** @param {object} overrides */
function configurePorts(overrides) {
  ports = { ...ports, ...overrides };
}

/** Repõe a infraestrutura real. */
function resetPorts() {
  ports = { ...DEFAULT_PORTS };
}

/**
 * @param {string} orderId
 * @returns {Promise<object[]>}
 */
async function getConflicts(orderId) {
  return ports.repo.conflictsForOrder(orderId);
}

/**
 * Processa um lote de eventos offline.
 *
 * @param {{ driver_id: string, sync_session_id: string, events: object[] }} batch
 * @returns {Promise<object>} relatório do sync
 */
async function syncDriverEvents(batch) {
  if (!batch || !Array.isArray(batch.events)) {
    throw new MissingRequiredFieldError('events');
  }
  if (batch.events.length > MAX_BATCH_SIZE) {
    throw new MissingRequiredFieldError(
      `events (máximo ${MAX_BATCH_SIZE} por lote, recebidos ${batch.events.length})`,
    );
  }

  batch.events.forEach(validateSyncEvent);

  // Regra 2: processar por device_timestamp ASC.
  const ordenados = sortChronological(batch.events);

  const resultado = {
    driver_id:       batch.driver_id ?? null,
    sync_session_id: batch.sync_session_id ?? null,
    applied:         0,
    skipped:         0,
    duplicates:      0,
    conflicts:       0,
    details:         [],
  };

  for (const evt of ordenados) {
    const detalhe = await processEvent(evt, batch.driver_id);
    resultado.details.push(detalhe);

    if (detalhe.outcome === 'applied')    resultado.applied++;
    if (detalhe.outcome === 'duplicate')  resultado.duplicates++;
    if (detalhe.outcome === 'skipped')    resultado.skipped++;
    if (detalhe.conflict)                 resultado.conflicts++;
  }

  console.info(
    `[audit] Sync ${batch.sync_session_id ?? '?'}: ${resultado.applied} aplicado(s), ` +
    `${resultado.duplicates} duplicado(s), ${resultado.skipped} saltado(s), ` +
    `${resultado.conflicts} conflito(s).`,
  );

  return resultado;
}

/**
 * Processa um único evento pelos quatro portões.
 *
 * @param {object} evt
 * @returns {Promise<object>} detalhe
 */
async function processEvent(evt, driverId) {
  const correlationId = evt.correlation_id ?? null;
  const dedupeKey     = buildDedupeKey(evt);

  // ── Portão 1: idempotência ───────────────────────────────────────────────────
  if (await ports.repo.wasProcessed(dedupeKey)) {
    return { correlation_id: correlationId, outcome: 'duplicate', conflict: false, reason: 'Evento já sincronizado.' };
  }

  // ── Portão 2: o pedido existe? ───────────────────────────────────────────────
  const order = (await ports.repo.findById(evt.order_id)) ?? (await ports.repo.findByCode(evt.order_id));
  if (!order) {
    // Marca como processado à mesma: reenviar não vai magicamente encontrar o pedido.
    await ports.repo.markProcessed({ dedupe_key: dedupeKey, order_id: evt.order_id, correlation_id: correlationId });
    return { correlation_id: correlationId, outcome: 'skipped', conflict: false, reason: 'Pedido não encontrado.' };
  }

  // ── Portão 3: resolução de conflitos ─────────────────────────────────────────
  // Só STATUS_UPDATE disputa o estado autoritativo do pedido. LOCATION, PHOTO e
  // SIGNATURE não têm concorrente persistido — aplicam-se sem conflito.
  //
  // ESCOLHA DE AUDITORIA: o conflict_log só regista quando o evento do motorista
  // é DESCARTADO (SERVER_WINS). É essa a informação que operações precisa —
  // "o que capturámos offline e não aplicámos, e porquê". Progressão normal
  // (evento local mais recente) aplica-se sem poluir o log. Isto cumpre a regra
  // 4 da skill onde ela importa: nenhum descarte é silencioso.
  const novoStatus = evt.event_type === EventType.STATUS_UPDATE
    ? toCanonicalStatus(evt.payload?.new_status)
    : null;

  if (evt.event_type === EventType.STATUS_UPDATE) {
    const serverEvent = await ports.repo.latestServerEvent(order.id);

    const decisao = resolveConflict(
      { order_id: order.id, event_type: evt.event_type, payload: evt.payload, device_timestamp: evt.device_timestamp },
      serverEvent && {
        order_id:         order.id,
        event_type:       evt.event_type,
        new_status:       serverEvent.status,
        server_timestamp: serverEvent.server_timestamp,
      },
    );

    // Evento local perdeu para o servidor: regista o descarte e sai.
    if (isConflict(decisao) && !decisao.apply) {
      await ports.repo.logConflict({
        id:           randomUUID(),
        order_id:     order.id,
        event_type:   evt.event_type,
        local_value:  { status: novoStatus, payload: evt.payload, device_timestamp: evt.device_timestamp },
        server_value: serverEvent ?? {},
        resolution:   decisao.resolution,
        reason:       decisao.reason,
      });

      await ports.repo.markProcessed({ dedupe_key: dedupeKey, order_id: order.id, correlation_id: correlationId });
      return {
        correlation_id: correlationId,
        outcome:        'skipped',
        conflict:       true,
        resolution:     decisao.resolution,
        reason:         decisao.reason,
      };
    }
  }

  // ── Portão 4: transição de status (só para STATUS_UPDATE) ─────────────────────
  if (evt.event_type === EventType.STATUS_UPDATE) {
    if (!novoStatus) {
      await ports.repo.markProcessed({ dedupe_key: dedupeKey, order_id: order.id, correlation_id: correlationId });
      return {
        correlation_id: correlationId,
        outcome:        'skipped',
        conflict:       false,
        reason:         `Status não reconhecido: "${evt.payload?.new_status}".`,
      };
    }

    if (!isValidTransition(order.current_status, novoStatus)) {
      await ports.repo.markProcessed({ dedupe_key: dedupeKey, order_id: order.id, correlation_id: correlationId });
      return {
        correlation_id: correlationId,
        outcome:        'skipped',
        conflict:       false,
        reason:         `Transição inválida: ${order.current_status} → ${novoStatus}.`,
      };
    }

    // Entrega/insucesso offline percorrem exatamente os mesmos casos de uso do
    // fluxo online para preservar POD, OTP, COD e cadeia de auditoria.
    if (ports.applyFinalStatus && (novoStatus === 'delivered' || novoStatus === 'failed')) {
      await ports.applyFinalStatus({
        orderId: order.id,
        newStatus: novoStatus,
        payload: evt.payload ?? {},
        driverId,
        deviceId: evt.device_id,
        deviceTimestamp: evt.device_timestamp,
      });
      await ports.repo.markProcessed({ dedupe_key: dedupeKey, order_id: order.id, correlation_id: correlationId });
      return { correlation_id: correlationId, outcome: 'applied', conflict: false, new_status: novoStatus };
    }

    await ports.repo.applyEvent({
      id:               randomUUID(),
      order_id:         order.id,
      status:           novoStatus,
      description:      evt.payload?.notes ?? 'Atualizado pelo app do motorista',
      event_origin:     'DRIVER',
      device_timestamp: evt.device_timestamp,
    });
  }
  // LOCATION / PHOTO / SIGNATURE: aceites e registados como processados, mas não
  // alteram o status. (A persistência de anexos é trabalho separado.)

  await ports.repo.markProcessed({ dedupe_key: dedupeKey, order_id: order.id, correlation_id: correlationId });

  return {
    correlation_id: correlationId,
    outcome:        'applied',
    conflict:       false,
    new_status:     novoStatus,
  };
}

module.exports = {
  MAX_BATCH_SIZE,
  syncDriverEvents,
  getConflicts,
  configurePorts,
  resetPorts,
  DEFAULT_PORTS,
  MissingRequiredFieldError,
};
