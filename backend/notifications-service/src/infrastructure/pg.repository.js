/**
 * @file pg.repository.js
 * @description Camada de acesso a dados do notifications-service.
 *
 * Single Responsibility: ÚNICO arquivo que faz queries no banco deste serviço.
 *
 * Arquitetura: Repository Pattern.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Stack — PostgreSQL 15+)
 *
 * Três agregados:
 *   - notifications  — histórico de envios
 *   - device_tokens  — tokens FCM por utilizador
 *   - preferences    — preferências por utilizador
 */
'use strict';

const pool = require('./db');
// Multiempresa (spec § 2.4): partilha o MESMO AsyncLocalStorage do gateway (mesmo
// processo → módulo em cache). Sem contexto (poller/testes) → sem filtro.
const { readCompanyId, writeCompanyId } = require('../../../api-gateway/src/infrastructure/tenant-context');

/** ` WHERE company_id = $n` (ou '') quando há empresa no contexto. */
function companyWhere(params) {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  return ` WHERE company_id = $${params.length}`;
}

/** ` AND company_id = $n` (ou '') para juntar a um WHERE existente. */
function companyClause(params) {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  return ` AND company_id = $${params.length}`;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * @param {Date|string} value
 * @returns {string}
 */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * @param {object} row
 * @returns {object}
 */
function rowToNotification(row) {
  return {
    id:              row.id,
    user_id:         row.user_id,
    role:            row.role,
    category:        row.category,
    title:           row.title,
    body:            row.body,
    data:            row.data ?? {},
    status:          row.status,
    delivered_count: Number(row.delivered_count),
    failure_reason:  row.failure_reason ?? null,
    created_at:      toIso(row.created_at),
    updated_at:      toIso(row.updated_at),
  };
}

// ─── Notificações ─────────────────────────────────────────────────────────────

const NotificationRepository = {
  /**
   * @param {{ user_id?: string, limit?: number }} [filtros]
   * @returns {Promise<object[]>}
   */
  async findAll(filtros = {}) {
    const limite = Math.min(Number(filtros.limit) || 100, 500);

    if (filtros.user_id) {
      const params = [filtros.user_id];
      const cc = companyClause(params);
      params.push(limite);
      const { rows } = await pool.query(
        `SELECT * FROM notifications WHERE user_id = $1${cc} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToNotification);
    }

    const params = [];
    const cw = companyWhere(params);
    params.push(limite);
    const { rows } = await pool.query(
      `SELECT * FROM notifications${cw} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToNotification);
  },

  /**
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM notifications WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? rowToNotification(rows[0]) : undefined;
  },

  /**
   * @param {object} notification
   * @returns {Promise<object>}
   */
  async create(notification) {
    const { rows } = await pool.query(
      `INSERT INTO notifications (
         id, user_id, role, category, title, body, data,
         status, delivered_count, failure_reason, created_at, updated_at, company_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        notification.id,
        notification.user_id,
        notification.role,
        notification.category,
        notification.title,
        notification.body,
        JSON.stringify(notification.data ?? {}),
        notification.status,
        notification.delivered_count,
        notification.failure_reason,
        notification.created_at,
        notification.updated_at,
        notification.company_id ?? writeCompanyId(),
      ],
    );
    return rowToNotification(rows[0]);
  },

  /**
   * @param {object} notification
   * @returns {Promise<object|undefined>}
   */
  async update(notification) {
    const { rows } = await pool.query(
      `UPDATE notifications SET
         status          = $1,
         delivered_count = $2,
         failure_reason  = $3,
         updated_at      = $4
       WHERE id = $5
       RETURNING *`,
      [
        notification.status,
        notification.delivered_count,
        notification.failure_reason,
        notification.updated_at,
        notification.id,
      ],
    );
    return rows[0] ? rowToNotification(rows[0]) : undefined;
  },

  /**
   * @returns {Promise<object>}
   */
  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')       AS sent,
        COUNT(*) FILTER (WHERE status = 'failed')     AS failed,
        COUNT(*) FILTER (WHERE status = 'suppressed') AS suppressed,
        COUNT(*) FILTER (WHERE status = 'pending')    AS pending
      FROM notifications${companyWhere(params)}
    `, params);

    const row = rows[0] ?? {};
    return {
      sent:       Number(row.sent       ?? 0),
      failed:     Number(row.failed     ?? 0),
      suppressed: Number(row.suppressed ?? 0),
      pending:    Number(row.pending    ?? 0),
    };
  },
};

// ─── Tokens de dispositivo ────────────────────────────────────────────────────

const DeviceTokenRepository = {
  /**
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async findByUser(userId) {
    const { rows } = await pool.query(
      'SELECT token FROM device_tokens WHERE user_id = $1',
      [userId],
    );
    return rows.map((r) => r.token);
  },

  /**
   * Regista um token. Idempotente: registar o mesmo token duas vezes só
   * atualiza a data — a app reenvia o token a cada arranque.
   *
   * @param {{ user_id: string, token: string, platform?: string }} dto
   * @returns {Promise<object>}
   */
  async register(dto) {
    const { rows } = await pool.query(
      `INSERT INTO device_tokens (token, user_id, platform, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = EXCLUDED.platform,
             updated_at = NOW()
       RETURNING *`,
      [dto.token, dto.user_id, dto.platform ?? 'unknown'],
    );
    return rows[0];
  },

  /**
   * @param {string} token
   * @returns {Promise<boolean>} true se algo foi removido
   */
  async unregister(token) {
    const { rowCount } = await pool.query('DELETE FROM device_tokens WHERE token = $1', [token]);
    return rowCount > 0;
  },

  /**
   * Remove tokens que o FCM reportou como inválidos.
   * Sem isto, a base enche-se de destinos mortos.
   *
   * @param {string[]} tokens
   * @returns {Promise<number>} quantos foram removidos
   */
  async removeMany(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return 0;

    const { rowCount } = await pool.query(
      'DELETE FROM device_tokens WHERE token = ANY($1)',
      [tokens],
    );
    return rowCount;
  },
};

// ─── Preferências ─────────────────────────────────────────────────────────────

const PreferenceRepository = {
  /**
   * @param {string} userId
   * @returns {Promise<object|null>} null quando o utilizador nunca gravou nada
   */
  async findByUser(userId) {
    const { rows } = await pool.query(
      'SELECT categories FROM preferences WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    return rows[0] ? rows[0].categories : null;
  },

  /**
   * @param {string} userId
   * @param {object} categories
   * @returns {Promise<object>}
   */
  async upsert(userId, categories) {
    const { rows } = await pool.query(
      `INSERT INTO preferences (user_id, categories, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET categories = EXCLUDED.categories,
             updated_at = NOW()
       RETURNING categories`,
      [userId, JSON.stringify(categories)],
    );
    return rows[0].categories;
  },
};

// ─── OutboundMessageRepository (SMS/email — auditoria) ────────────────────────

function rowToOutbound(row) {
  return {
    id:                  row.id,
    channel:             row.channel,
    recipient:           row.recipient,
    subject:             row.subject ?? undefined,
    body:                row.body,
    status:              row.status,
    provider:            row.provider,
    provider_message_id: row.provider_message_id ?? undefined,
    order_id:            row.order_id ?? undefined,
    tracking_code:       row.tracking_code ?? undefined,
    error:               row.error ?? undefined,
    created_at:          row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

const OutboundMessageRepository = {
  /**
   * @param {object} message
   * @returns {Promise<object>}
   */
  async create(message) {
    const { rows } = await pool.query(`
      INSERT INTO outbound_messages (
        id, channel, recipient, subject, body, status, provider,
        provider_message_id, order_id, tracking_code, error, created_at, company_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      message.id,
      message.channel,
      message.recipient,
      message.subject ?? null,
      message.body,
      message.status,
      message.provider,
      message.provider_message_id ?? null,
      message.order_id ?? null,
      message.tracking_code ?? null,
      message.error ?? null,
      message.created_at,
      message.company_id ?? writeCompanyId(),
    ]);
    return rowToOutbound(rows[0]);
  },

  /**
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async findAll(limit = 100) {
    const params = [];
    const cw = companyWhere(params);
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM outbound_messages${cw} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToOutbound);
  },

  /** @returns {Promise<{ sms: number; email: number; sent: number; failed: number; simulated: number }>} */
  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE channel = 'sms')        AS sms,
        COUNT(*) FILTER (WHERE channel = 'email')      AS email,
        COUNT(*) FILTER (WHERE status = 'sent')        AS sent,
        COUNT(*) FILTER (WHERE status = 'failed')      AS failed,
        COUNT(*) FILTER (WHERE status = 'simulated')   AS simulated
      FROM outbound_messages${companyWhere(params)}
    `, params);
    const r = rows[0] ?? {};
    return {
      sms:       Number(r.sms ?? 0),
      email:     Number(r.email ?? 0),
      sent:      Number(r.sent ?? 0),
      failed:    Number(r.failed ?? 0),
      simulated: Number(r.simulated ?? 0),
    };
  },
};

module.exports = {
  NotificationRepository,
  DeviceTokenRepository,
  PreferenceRepository,
  OutboundMessageRepository,
  rowToNotification,
  rowToOutbound,
};
