/**
 * @file pg.repository.js
 * @description Camada de acesso a dados do orders-service.
 *
 * Single Responsibility: ÚNICO arquivo que faz queries no banco deste serviço.
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md
 */
'use strict';

const pool = require('./db');

/**
 * @param {Date|string} v
 * @returns {string}
 */
function toIso(v) {
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * @param {object} row
 * @returns {object}
 */
function rowToOrder(row) {
  return {
    id:             row.id,
    tracking_code:  row.tracking_code,
    client_id:      row.client_id,
    current_status: row.current_status,
    driver_id:      row.driver_id ?? null,
    created_at:     toIso(row.created_at),
    updated_at:     toIso(row.updated_at),
  };
}

const OrderRepository = {
  /**
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? rowToOrder(rows[0]) : undefined;
  },

  /**
   * @param {string} code
   * @returns {Promise<object|undefined>}
   */
  async findByCode(code) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE tracking_code = $1 LIMIT 1', [code]);
    return rows[0] ? rowToOrder(rows[0]) : undefined;
  },

  /**
   * O evento mais recente do servidor para um pedido — o que a resolução de
   * conflitos usa como concorrente.
   *
   * `server_timestamp` prefere o `device_timestamp` do evento quando existe, e
   * só cai no `created_at` (relógio do servidor) na ausência dele. Assim, quando
   * o estado atual veio de um dispositivo, a comparação da skill (device local vs
   * server) fica relógio-de-dispositivo contra relógio-de-dispositivo, em vez de
   * misturar dois relógios diferentes.
   *
   * @param {string} orderId
   * @returns {Promise<{status: string, server_timestamp: string}|null>}
   */
  async latestServerEvent(orderId) {
    const { rows } = await pool.query(
      `SELECT status, COALESCE(device_timestamp, created_at) AS server_timestamp
         FROM order_events
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [orderId],
    );
    if (!rows[0]) return null;
    return { status: rows[0].status, server_timestamp: toIso(rows[0].server_timestamp) };
  },

  /**
   * Aplica um evento: acrescenta à timeline e atualiza o status do pedido.
   * Numa única transação — a timeline e o status nunca divergem.
   *
   * @param {object} evento
   * @returns {Promise<object>} pedido atualizado
   */
  async applyEvent(evento) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO order_events (id, order_id, status, description, event_origin, device_timestamp, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [
          evento.id, evento.order_id, evento.status,
          evento.description ?? null, evento.event_origin ?? 'DRIVER',
          evento.device_timestamp ?? null,
        ],
      );

      const { rows } = await client.query(
        `UPDATE orders SET current_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [evento.status, evento.order_id],
      );

      await client.query('COMMIT');
      return rows[0] ? rowToOrder(rows[0]) : undefined;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Regista um evento como processado. Devolve false se a chave já existia —
   * é assim que o sync se mantém idempotente perante reenvios (regra 5).
   *
   * @param {{ dedupe_key: string, order_id: string, correlation_id?: string }} dto
   * @returns {Promise<boolean>} true se registou agora, false se já existia
   */
  async markProcessed(dto) {
    const { rowCount } = await pool.query(
      `INSERT INTO processed_events (dedupe_key, order_id, correlation_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [dto.dedupe_key, dto.order_id, dto.correlation_id ?? null],
    );
    return rowCount > 0;
  },

  /**
   * @param {string} dedupeKey
   * @returns {Promise<boolean>}
   */
  async wasProcessed(dedupeKey) {
    const { rows } = await pool.query(
      'SELECT 1 FROM processed_events WHERE dedupe_key = $1 LIMIT 1',
      [dedupeKey],
    );
    return rows.length > 0;
  },

  /**
   * Grava uma entrada no conflict_log (skill regra 4).
   *
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async logConflict(entry) {
    await pool.query(
      `INSERT INTO conflict_log (id, order_id, event_type, local_value, server_value, resolution, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.id, entry.order_id, entry.event_type,
        JSON.stringify(entry.local_value), JSON.stringify(entry.server_value),
        entry.resolution, entry.reason,
      ],
    );
  },

  /**
   * @param {string} orderId
   * @returns {Promise<object[]>}
   */
  async conflictsForOrder(orderId) {
    const { rows } = await pool.query(
      'SELECT * FROM conflict_log WHERE order_id = $1 ORDER BY resolved_at DESC',
      [orderId],
    );
    return rows.map((r) => ({
      ...r,
      resolved_at: toIso(r.resolved_at),
    }));
  },

  // ── Utilitários para os testes de integração povoarem dados ────────────────
  /**
   * @param {object} order
   * @returns {Promise<object>}
   */
  async createOrder(order) {
    const { rows } = await pool.query(
      `INSERT INTO orders (id, tracking_code, client_id, current_status, driver_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET current_status = EXCLUDED.current_status, updated_at = NOW()
       RETURNING *`,
      [order.id, order.tracking_code, order.client_id, order.current_status ?? 'created', order.driver_id ?? null],
    );
    return rowToOrder(rows[0]);
  },
};

module.exports = { OrderRepository, rowToOrder };
