/**
 * @file conflict-resolver.js
 * @description Resolução de conflitos de sincronização offline.
 *
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md § Conflict Resolution Rules
 *
 * REGRA CENTRAL DA SKILL: "Conflict resolution must always be logged to
 * conflict_log. Silent discards are forbidden." Este módulo apenas DECIDE — a
 * gravação no log é responsabilidade de quem o chama, mas a decisão nunca é
 * silenciosa: devolve sempre a resolução e o motivo.
 *
 * Tabela de resolução (skill):
 *   STATUS_UPDATE, timestamps diferentes → LOCAL_WINS se device > server; senão SERVER_WINS
 *   STATUS_UPDATE, dois DELIVERED         → SERVER_WINS (servidor é autoritativo na entrega)
 *   LOCATION                              → LOCAL_WINS (a leitura GPS mais recente é sempre melhor)
 *   PHOTO / SIGNATURE                     → manter ambos (anexos separados)
 *
 * Este ficheiro é lógica pura, sem I/O — é onde um erro se traduz em perder a
 * atualização de um motorista ou sobrepor o estado autoritativo do servidor.
 */
'use strict';

/** Tipos de evento que o app do motorista produz offline. */
const EventType = Object.freeze({
  STATUS_UPDATE: 'STATUS_UPDATE',
  LOCATION:      'LOCATION',
  PHOTO_CAPTURE: 'PHOTO_CAPTURE',
  SIGNATURE:     'SIGNATURE',
});

/** Resoluções possíveis — os valores gravados em conflict_log.resolution. */
const Resolution = Object.freeze({
  LOCAL_WINS:  'LOCAL_WINS',
  SERVER_WINS: 'SERVER_WINS',
  KEEP_BOTH:   'KEEP_BOTH',
  /** Não há evento do servidor a competir — o evento local aplica-se sem conflito. */
  NO_CONFLICT: 'NO_CONFLICT',
});

/** Status canônico de entrega — o servidor é sempre autoritativo sobre este. */
const DELIVERED = 'delivered';

/**
 * @typedef {object} SyncEvent
 * @property {string} order_id
 * @property {string} event_type
 * @property {object} payload
 * @property {string} device_timestamp ISO8601
 * @property {string} [correlation_id]
 */

/**
 * @typedef {object} ServerEvent
 * @property {string} order_id
 * @property {string} event_type
 * @property {string} [new_status] Status canônico atual no servidor
 * @property {string} server_timestamp ISO8601
 */

/**
 * @typedef {object} Decision
 * @property {string} resolution Um valor de Resolution
 * @property {boolean} apply true se o evento local deve ser aplicado
 * @property {string} reason Explicação legível — nunca vazia
 */

/**
 * Decide o desfecho de um evento local perante o estado do servidor.
 *
 * @param {SyncEvent} local
 * @param {ServerEvent|null} server Evento do servidor em competição, ou null
 * @returns {Decision}
 */
function resolveConflict(local, server) {
  // Sem evento concorrente, não há conflito — aplica-se.
  if (!server) {
    return {
      resolution: Resolution.NO_CONFLICT,
      apply:      true,
      reason:     'Sem evento concorrente no servidor.',
    };
  }

  // ── LOCATION → a leitura mais recente é sempre a melhor ──────────────────────
  if (local.event_type === EventType.LOCATION) {
    return {
      resolution: Resolution.LOCAL_WINS,
      apply:      true,
      reason:     'LOCATION: a leitura GPS local mais recente prevalece.',
    };
  }

  // ── PHOTO / SIGNATURE → manter ambos, sem sobreposição ───────────────────────
  if (local.event_type === EventType.PHOTO_CAPTURE || local.event_type === EventType.SIGNATURE) {
    return {
      resolution: Resolution.KEEP_BOTH,
      apply:      true,
      reason:     `${local.event_type}: anexos preservados como registos separados.`,
    };
  }

  // ── STATUS_UPDATE ────────────────────────────────────────────────────────────
  if (local.event_type === EventType.STATUS_UPDATE) {
    // Regra especial: entrega. O servidor é autoritativo — se ele já marcou
    // DELIVERED, nenhuma atualização local a desfaz.
    if (server.new_status === DELIVERED) {
      return {
        resolution: Resolution.SERVER_WINS,
        apply:      false,
        reason:     'STATUS_UPDATE: servidor já registou a entrega (autoritativo).',
      };
    }

    // Regra geral: ganha o timestamp mais recente.
    const localMs  = Date.parse(local.device_timestamp);
    const serverMs = Date.parse(server.server_timestamp);

    // Timestamp local inválido não pode ganhar sobre o servidor.
    if (Number.isNaN(localMs)) {
      return {
        resolution: Resolution.SERVER_WINS,
        apply:      false,
        reason:     'STATUS_UPDATE: device_timestamp inválido — servidor prevalece.',
      };
    }

    if (localMs > serverMs) {
      return {
        resolution: Resolution.LOCAL_WINS,
        apply:      true,
        reason:     'STATUS_UPDATE: evento local é mais recente que o do servidor.',
      };
    }

    return {
      resolution: Resolution.SERVER_WINS,
      apply:      false,
      reason:     'STATUS_UPDATE: evento do servidor é igual ou mais recente.',
    };
  }

  // Tipo desconhecido: não aplicar, mas registar — nunca descartar em silêncio.
  return {
    resolution: Resolution.SERVER_WINS,
    apply:      false,
    reason:     `Tipo de evento desconhecido "${local.event_type}" — evento local não aplicado.`,
  };
}

/**
 * Uma resolução deve ir para o conflict_log?
 * NO_CONFLICT não é conflito; tudo o resto é auditável.
 *
 * @param {Decision} decision
 * @returns {boolean}
 */
function isConflict(decision) {
  return decision.resolution !== Resolution.NO_CONFLICT;
}

module.exports = {
  EventType,
  Resolution,
  DELIVERED,
  resolveConflict,
  isConflict,
};
