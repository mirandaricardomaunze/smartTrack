/**
 * @file notification.entity.js
 * @description Entidade de domínio Notificação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3 (Notificações Push)
 *   - "Notificações push segmentadas por perfil, configuráveis por tipo de evento."
 *   - "Preferências de notificação por usuário (ligar/desligar por categoria)."
 *   - "Canal: Firebase Cloud Messaging (FCM)."
 *
 * REGRAS DE DOMÍNIO:
 * - Toda mudança de status passa por `isValidNotificationTransition()`.
 * - Uma notificação suprimida por preferência NÃO é uma falha — é um desfecho
 *   legítimo e distinto, com o seu próprio estado (SUPPRESSED).
 * - Funções puras: nunca mutam o argumento, devolvem novo objeto.
 */
'use strict';

/**
 * Categorias de notificação — a unidade que o utilizador liga e desliga.
 * `roles` define a segmentação por perfil exigida pela spec § 3.3.
 */
const NotificationCategory = Object.freeze({
  ORDER_STATUS: 'ORDER_STATUS',
  DESTINATION_REQUEST: 'DESTINATION_REQUEST',
  PAYMENT: 'PAYMENT',
  ROUTE_ASSIGNED: 'ROUTE_ASSIGNED',
  DELIVERY_ISSUE: 'DELIVERY_ISSUE',
});

/**
 * Metadados por categoria.
 *
 * `critical: true` marca categorias que o utilizador NÃO pode desligar. São
 * aquelas em que o silêncio causa dano real: o pedido fica em hold se o cliente
 * não confirmar o destino (spec § 8.2), e o motorista não pode perder a
 * atribuição de uma rota. As restantes são livremente configuráveis.
 */
const CATEGORY_META = Object.freeze({
  [NotificationCategory.ORDER_STATUS]: Object.freeze({
    label:    'Mudanças de status do pedido',
    roles:    Object.freeze(['CLIENT']),
    critical: false,
  }),
  [NotificationCategory.DESTINATION_REQUEST]: Object.freeze({
    label:    'Pedido de confirmação de destino',
    roles:    Object.freeze(['CLIENT']),
    critical: true, // spec § 8.2 — sem resposta, o pedido fica em hold
  }),
  [NotificationCategory.PAYMENT]: Object.freeze({
    label:    'Pagamentos e cobranças',
    roles:    Object.freeze(['CLIENT']),
    critical: false,
  }),
  [NotificationCategory.ROUTE_ASSIGNED]: Object.freeze({
    label:    'Atribuição de rota',
    roles:    Object.freeze(['DRIVER']),
    critical: true, // o motorista não pode perder a sua rota do dia
  }),
  [NotificationCategory.DELIVERY_ISSUE]: Object.freeze({
    label:    'Insucessos e ocorrências',
    roles:    Object.freeze(['CLIENT', 'DRIVER', 'SUPPORT']),
    critical: false,
  }),
});

const NotificationStatus = Object.freeze({
  PENDING:    'pending',
  SENT:       'sent',
  FAILED:     'failed',
  /** Não enviada porque o utilizador desligou a categoria — não é erro. */
  SUPPRESSED: 'suppressed',
});

const VALID_NOTIFICATION_TRANSITIONS = Object.freeze({
  [NotificationStatus.PENDING]:    [
    NotificationStatus.SENT,
    NotificationStatus.FAILED,
    NotificationStatus.SUPPRESSED,
  ],
  [NotificationStatus.SENT]:       [],
  [NotificationStatus.FAILED]:     [NotificationStatus.SENT], // retentativa
  [NotificationStatus.SUPPRESSED]: [],
});

// ─── Erros tipados ────────────────────────────────────────────────────────────

class InvalidNotificationTransitionError extends Error {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    super(`Transição de notificação inválida: ${from} → ${to}`);
    this.name = 'InvalidNotificationTransitionError';
    this.statusCode = 409;
  }
}

class MissingRequiredFieldError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Campo obrigatório em falta: ${field}`);
    this.name = 'MissingRequiredFieldError';
    this.statusCode = 400;
  }
}

class UnknownCategoryError extends Error {
  /** @param {string} category */
  constructor(category) {
    super(
      `Categoria desconhecida: "${category}". ` +
      `Esperada uma de: ${Object.keys(CATEGORY_META).join(', ')}.`,
    );
    this.name = 'UnknownCategoryError';
    this.statusCode = 400;
  }
}

class NotificationNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Notificação não encontrada: ${id}`);
    this.name = 'NotificationNotFoundError';
    this.statusCode = 404;
  }
}

// ─── Funções de domínio puras ────────────────────────────────────────────────

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidNotificationTransition(from, to) {
  const allowed = VALID_NOTIFICATION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * @param {string} category
 * @returns {boolean}
 */
function isKnownCategory(category) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_META, category);
}

/**
 * A categoria aplica-se a este perfil? (segmentação da spec § 3.3)
 *
 * @param {string} category
 * @param {string} role
 * @returns {boolean}
 */
function categoryAppliesToRole(category, role) {
  if (!isKnownCategory(category)) throw new UnknownCategoryError(category);
  return CATEGORY_META[category].roles.includes(role);
}

/**
 * @param {string} category
 * @returns {boolean}
 */
function isCriticalCategory(category) {
  if (!isKnownCategory(category)) throw new UnknownCategoryError(category);
  return CATEGORY_META[category].critical;
}

/**
 * Cria uma notificação com status PENDING.
 *
 * @param {string} id
 * @param {{
 *   user_id: string,
 *   role: string,
 *   category: string,
 *   title: string,
 *   body: string,
 *   data?: object
 * }} dto
 * @returns {object} Notificação
 */
function createNotificationEntity(id, dto) {
  if (!dto.user_id)  throw new MissingRequiredFieldError('user_id');
  if (!dto.role)     throw new MissingRequiredFieldError('role');
  if (!dto.category) throw new MissingRequiredFieldError('category');
  if (!dto.title)    throw new MissingRequiredFieldError('title');
  if (!dto.body)     throw new MissingRequiredFieldError('body');

  if (!isKnownCategory(dto.category)) throw new UnknownCategoryError(dto.category);

  const now = new Date().toISOString();

  return {
    id,
    user_id:  dto.user_id,
    role:     dto.role,
    category: dto.category,
    title:    dto.title,
    body:     dto.body,
    /** Payload livre entregue ao app (ex.: { orderId, trackingCode }). */
    data:     dto.data ?? {},
    status:   NotificationStatus.PENDING,
    /** Quantos tokens receberam de facto — preenchido ao enviar. */
    delivered_count: 0,
    failure_reason:  null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Aplica uma transição de status.
 * Devolve novo objeto — não muta o original.
 *
 * @param {object} notification
 * @param {string} newStatus
 * @param {{ delivered_count?: number, failure_reason?: string }} [extras]
 * @returns {object}
 */
function applyNotificationTransition(notification, newStatus, extras = {}) {
  if (!isValidNotificationTransition(notification.status, newStatus)) {
    throw new InvalidNotificationTransitionError(notification.status, newStatus);
  }

  return {
    ...notification,
    status:          newStatus,
    delivered_count: extras.delivered_count ?? notification.delivered_count,
    failure_reason:  extras.failure_reason ?? null,
    updated_at:      new Date().toISOString(),
  };
}

module.exports = {
  NotificationCategory,
  CATEGORY_META,
  NotificationStatus,
  VALID_NOTIFICATION_TRANSITIONS,
  InvalidNotificationTransitionError,
  MissingRequiredFieldError,
  UnknownCategoryError,
  NotificationNotFoundError,
  isValidNotificationTransition,
  isKnownCategory,
  categoryAppliesToRole,
  isCriticalCategory,
  createNotificationEntity,
  applyNotificationTransition,
};
