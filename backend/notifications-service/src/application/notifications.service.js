/**
 * @file notifications.service.js
 * @description Casos de uso do notifications-service.
 *
 * Single Responsibility: lógica de negócio — não conhece HTTP nem SQL.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 (Notificações Push)
 *
 * A decisão de enviar ou suprimir vive em domain/preferences.js; aqui só se
 * orquestra: resolver preferências → decidir → buscar tokens → enviar → limpar
 * tokens mortos → registar o desfecho.
 */
'use strict';

const {
  NotificationRepository,
  DeviceTokenRepository,
  PreferenceRepository,
} = require('../infrastructure/pg.repository');

const { getFcmClient } = require('../infrastructure/fcm.client');

const {
  NotificationStatus,
  NotificationNotFoundError,
  MissingRequiredFieldError,
  UnknownCategoryError,
  InvalidNotificationTransitionError,
  createNotificationEntity,
  applyNotificationTransition,
} = require('../domain/notification.entity');

const {
  shouldSend,
  normalizePreferences,
  listPreferencesForRole,
  DecisionReason,
} = require('../domain/preferences');

/**
 * @returns {string}
 */
function generateNotificationId() {
  const stamp  = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `notif-${stamp}-${random}`;
}

// ─── Costura de dependências ──────────────────────────────────────────────────

/**
 * Portas do serviço — mesma abordagem do payments-service. Os defaults são a
 * infraestrutura real; os testes trocam-nas por duplos via `configurePorts`.
 */
const DEFAULT_PORTS = Object.freeze({
  notifications: NotificationRepository,
  tokens:        DeviceTokenRepository,
  preferences:   PreferenceRepository,
  getFcm:        getFcmClient,
});

let ports = { ...DEFAULT_PORTS };

/**
 * @param {object} overrides
 */
function configurePorts(overrides) {
  ports = { ...ports, ...overrides };
}

/** Repõe a infraestrutura real. */
function resetPorts() {
  ports = { ...DEFAULT_PORTS };
}

// ─── Consultas ────────────────────────────────────────────────────────────────

/**
 * @param {{ user_id?: string, limit?: number }} [filtros]
 * @returns {Promise<object[]>}
 */
async function listNotifications(filtros = {}) {
  return ports.notifications.findAll(filtros);
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getNotification(id) {
  const n = await ports.notifications.findById(id);
  if (!n) throw new NotificationNotFoundError(id);
  return n;
}

/** @returns {Promise<object>} */
async function getStats() {
  return ports.notifications.getStats();
}

// ─── Preferências ─────────────────────────────────────────────────────────────

/**
 * Preferências de um utilizador, prontas para o ecrã de definições.
 *
 * @param {string} userId
 * @param {string} role
 * @returns {Promise<object>}
 */
async function getPreferences(userId, role) {
  if (!userId) throw new MissingRequiredFieldError('user_id');
  if (!role)   throw new MissingRequiredFieldError('role');

  const guardadas = await ports.preferences.findByUser(userId);

  return {
    user_id:    userId,
    role,
    categories: listPreferencesForRole(role, guardadas),
  };
}

/**
 * Atualiza preferências. Categorias desconhecidas são descartadas em silêncio
 * (ver normalizePreferences) — um cliente antigo não deve partir por enviar uma
 * chave que já não existe.
 *
 * @param {string} userId
 * @param {object} categories
 * @returns {Promise<object>}
 */
async function updatePreferences(userId, categories) {
  if (!userId) throw new MissingRequiredFieldError('user_id');
  if (!categories || typeof categories !== 'object') {
    throw new MissingRequiredFieldError('categories');
  }

  const normalizadas = normalizePreferences(categories);
  const guardadas    = await ports.preferences.upsert(userId, normalizadas);

  console.info(`[audit] Preferências atualizadas para ${userId}.`);
  return guardadas;
}

// ─── Tokens de dispositivo ────────────────────────────────────────────────────

/**
 * @param {{ user_id: string, token: string, platform?: string }} dto
 * @returns {Promise<object>}
 */
async function registerDevice(dto) {
  if (!dto || !dto.user_id) throw new MissingRequiredFieldError('user_id');
  if (!dto.token)           throw new MissingRequiredFieldError('token');

  const registado = await ports.tokens.register(dto);
  console.info(`[audit] Dispositivo registado para ${dto.user_id} (${dto.platform ?? 'unknown'}).`);
  return registado;
}

/**
 * @param {string} token
 * @returns {Promise<{ removed: boolean }>}
 */
async function unregisterDevice(token) {
  if (!token) throw new MissingRequiredFieldError('token');
  return { removed: await ports.tokens.unregister(token) };
}

// ─── Envio ────────────────────────────────────────────────────────────────────

/**
 * Envia uma notificação push.
 *
 * Fluxo:
 *   1. Cria o registo (PENDING) — mesmo que venha a ser suprimido, fica histórico.
 *   2. Resolve as preferências e decide (domain/preferences.shouldSend).
 *   3. Suprimida → SUPPRESSED com o motivo. Não é falha.
 *   4. Sem tokens → FAILED (o utilizador não tem app instalada).
 *   5. Envia via FCM; remove os tokens que o FCM disser estarem inválidos.
 *   6. SENT ou FAILED conforme o resultado.
 *
 * @param {{
 *   user_id: string, role: string, category: string,
 *   title: string, body: string, data?: object
 * }} dto
 * @returns {Promise<object>} Notificação no estado final, com `decision`
 */
async function sendNotification(dto) {
  // A entidade valida os obrigatórios e a categoria.
  const notificacao = createNotificationEntity(generateNotificationId(), dto ?? {});

  let registo = await ports.notifications.create(notificacao);

  // ── 2. Decidir ──────────────────────────────────────────────────────────────
  const guardadas = await ports.preferences.findByUser(dto.user_id);
  const decisao   = shouldSend({ category: dto.category, role: dto.role }, guardadas);

  // ── 3. Suprimida ────────────────────────────────────────────────────────────
  if (!decisao.allowed) {
    registo = await ports.notifications.update(
      applyNotificationTransition(registo, NotificationStatus.SUPPRESSED, {
        failure_reason: decisao.reason,
      }),
    );

    console.info(
      `[audit] Notificação ${registo.id} suprimida para ${dto.user_id}: ${decisao.reason}.`,
    );
    return { ...registo, decision: decisao };
  }

  // ── 4. Sem destinos ─────────────────────────────────────────────────────────
  const tokens = await ports.tokens.findByUser(dto.user_id);

  if (!tokens || tokens.length === 0) {
    registo = await ports.notifications.update(
      applyNotificationTransition(registo, NotificationStatus.FAILED, {
        failure_reason: 'Nenhum dispositivo registado para este utilizador.',
      }),
    );
    return { ...registo, decision: decisao };
  }

  // ── 5. Enviar ───────────────────────────────────────────────────────────────
  const fcm = ports.getFcm();

  const resposta = await fcm.send({
    tokens,
    title: dto.title,
    body:  dto.body,
    data:  dto.data ?? {},
  });

  // Limpar tokens mortos antes de decidir o desfecho — mesmo que o envio falhe,
  // um token que o FCM diz estar inválido nunca mais serve.
  if (resposta.invalidTokens && resposta.invalidTokens.length > 0) {
    const removidos = await ports.tokens.removeMany(resposta.invalidTokens);
    console.info(`[audit] ${removidos} token(s) inválido(s) removidos após envio.`);
  }

  // ── 6. Desfecho ─────────────────────────────────────────────────────────────
  const entregou = resposta.successCount > 0;

  registo = await ports.notifications.update(
    applyNotificationTransition(
      registo,
      entregou ? NotificationStatus.SENT : NotificationStatus.FAILED,
      {
        delivered_count: resposta.successCount,
        failure_reason:  entregou ? null : resposta.message,
      },
    ),
  );

  console.info(
    `[audit] Notificação ${registo.id} (${dto.category}) → ${registo.status}: ${resposta.message}`,
  );

  return { ...registo, decision: decisao };
}

module.exports = {
  listNotifications,
  getNotification,
  getStats,
  getPreferences,
  updatePreferences,
  registerDevice,
  unregisterDevice,
  sendNotification,
  generateNotificationId,
  configurePorts,
  resetPorts,
  DEFAULT_PORTS,
  DecisionReason,
  NotificationNotFoundError,
  MissingRequiredFieldError,
  UnknownCategoryError,
  InvalidNotificationTransitionError,
};
