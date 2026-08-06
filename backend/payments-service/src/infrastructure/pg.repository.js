/**
 * @file pg.repository.js
 * @description Camada de acesso a dados do payments-service.
 *
 * Single Responsibility: ÚNICO arquivo que faz queries no banco deste serviço.
 *
 * Arquitetura: Repository Pattern.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Stack — PostgreSQL 15+)
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md
 */
'use strict';

const pool = require('./db');

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * @param {Date|string} value
 * @returns {string}
 */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Mapeia uma row do PostgreSQL → shape de Pagamento.
 * `value` é NUMERIC no banco mas centavos inteiros no domínio — reconvertido aqui.
 * @param {object} row
 * @returns {object}
 */
function rowToPayment(row) {
  return {
    id:                     row.id,
    order_id:               row.order_id,
    value:                  Number(row.value),
    status:                 row.status,
    gateway:                row.gateway,
    gateway_transaction_id: row.gateway_transaction_id ?? null,
    idempotency_key:        row.idempotency_key,
    attempt_number:         Number(row.attempt_number),
    failure_reason:         row.failure_reason ?? null,
    created_at:             toIso(row.created_at),
    updated_at:             toIso(row.updated_at),
  };
}

// ─── Repositório ──────────────────────────────────────────────────────────────

const PaymentRepository = {
  /** @returns {Promise<object[]>} */
  async findAll() {
    const { rows } = await pool.query('SELECT * FROM payments ORDER BY created_at DESC');
    return rows.map(rowToPayment);
  },

  /**
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  /**
   * @param {string} orderId
   * @returns {Promise<object[]>}
   */
  async findByOrder(orderId) {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY attempt_number ASC',
      [orderId],
    );
    return rows.map(rowToPayment);
  },

  /**
   * Busca por chave de idempotência — a defesa principal contra cobrança dupla.
   * @param {string} key
   * @returns {Promise<object|undefined>}
   */
  async findByIdempotencyKey(key) {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE idempotency_key = $1 LIMIT 1',
      [key],
    );
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  /**
   * Busca pela transação do gateway — usada pelo handler de webhook
   * (skill § Webhook Handler Rules).
   * @param {string} txId
   * @returns {Promise<object|undefined>}
   */
  async findByGatewayTxId(txId) {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE gateway_transaction_id = $1 LIMIT 1',
      [txId],
    );
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  /**
   * Pagamento mais recente de um pedido — o que conta para saber se já foi pago.
   * @param {string} orderId
   * @returns {Promise<object|undefined>}
   */
  async findLatestByOrder(orderId) {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY attempt_number DESC LIMIT 1',
      [orderId],
    );
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  /**
   * @param {object} payment
   * @returns {Promise<object>}
   */
  async create(payment) {
    const { rows } = await pool.query(
      `INSERT INTO payments (
         id, order_id, value, status, gateway, gateway_transaction_id,
         idempotency_key, attempt_number, failure_reason, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        payment.id,
        payment.order_id,
        payment.value,
        payment.status,
        payment.gateway,
        payment.gateway_transaction_id,
        payment.idempotency_key,
        payment.attempt_number,
        payment.failure_reason,
        payment.created_at,
        payment.updated_at,
      ],
    );
    return rowToPayment(rows[0]);
  },

  /**
   * @param {object} payment
   * @returns {Promise<object|undefined>}
   */
  async update(payment) {
    const { rows } = await pool.query(
      `UPDATE payments SET
         status                 = $1,
         gateway_transaction_id = $2,
         idempotency_key        = $3,
         attempt_number         = $4,
         failure_reason         = $5,
         updated_at             = $6
       WHERE id = $7
       RETURNING *`,
      [
        payment.status,
        payment.gateway_transaction_id,
        payment.idempotency_key,
        payment.attempt_number,
        payment.failure_reason,
        payment.updated_at,
        payment.id,
      ],
    );
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  /**
   * Contagens por status — consumido pelo painel admin.
   * @returns {Promise<object>}
   */
  async getStats() {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'succeeded')  AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')     AS failed,
        COUNT(*) FILTER (WHERE status = 'refunded')   AS refunded,
        COALESCE(SUM(value) FILTER (WHERE status = 'succeeded'), 0) AS revenue_cents
      FROM payments
    `);

    const row = rows[0] ?? {};
    return {
      pending:       Number(row.pending    ?? 0),
      processing:    Number(row.processing ?? 0),
      succeeded:     Number(row.succeeded  ?? 0),
      failed:        Number(row.failed     ?? 0),
      refunded:      Number(row.refunded   ?? 0),
      revenue_cents: Number(row.revenue_cents ?? 0),
    };
  },

  /**
   * Pagamentos SUCCEEDED de um período — base da conciliação diária
   * (skill § regra 6).
   * @param {string} sinceIso
   * @returns {Promise<object[]>}
   */
  async findSucceededSince(sinceIso) {
    const { rows } = await pool.query(
      `SELECT * FROM payments
        WHERE status = 'succeeded' AND updated_at >= $1
        ORDER BY updated_at ASC`,
      [sinceIso],
    );
    return rows.map(rowToPayment);
  },
};

module.exports = { PaymentRepository, rowToPayment };
