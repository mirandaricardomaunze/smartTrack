/**
 * @file pg.repository.js
 * @description Camada de acesso a dados do routes-service.
 *
 * Single Responsibility: ÚNICO arquivo que faz queries no banco deste serviço.
 *
 * Arquitetura: Repository Pattern.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Stack — PostgreSQL 15+)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.3 (timestamps UTC — timestamptz)
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
 * Mapeia uma row do PostgreSQL → shape de Rota.
 * @param {object} row
 * @returns {object}
 */
function rowToRoute(row) {
  return {
    id:           row.id,
    driver_id:    row.driver_id,
    stops:        row.stops ?? [],
    status:       row.status,
    distance_km:  row.distance_km !== null ? Number(row.distance_km) : null,
    optimized_at: toIso(row.optimized_at),
    created_at:   toIso(row.created_at),
    updated_at:   toIso(row.updated_at),
  };
}

// ─── Repositório ──────────────────────────────────────────────────────────────

const RouteRepository = {
  /**
   * @returns {Promise<object[]>}
   */
  async findAll() {
    const { rows } = await pool.query('SELECT * FROM routes ORDER BY created_at DESC');
    return rows.map(rowToRoute);
  },

  /**
   * @param {string} id
   * @returns {Promise<object|undefined>}
   */
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM routes WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? rowToRoute(rows[0]) : undefined;
  },

  /**
   * @param {string} driverId
   * @returns {Promise<object[]>}
   */
  async findByDriver(driverId) {
    const { rows } = await pool.query(
      'SELECT * FROM routes WHERE driver_id = $1 ORDER BY created_at DESC',
      [driverId],
    );
    return rows.map(rowToRoute);
  },

  /**
   * Rota ativa de um motorista — só pode haver uma em andamento de cada vez.
   * @param {string} driverId
   * @returns {Promise<object|undefined>}
   */
  async findActiveByDriver(driverId) {
    const { rows } = await pool.query(
      `SELECT * FROM routes
        WHERE driver_id = $1 AND status IN ('PLANEJADA', 'EM_ANDAMENTO')
        ORDER BY created_at DESC
        LIMIT 1`,
      [driverId],
    );
    return rows[0] ? rowToRoute(rows[0]) : undefined;
  },

  /**
   * @param {object} route
   * @returns {Promise<object>}
   */
  async create(route) {
    const { rows } = await pool.query(
      `INSERT INTO routes (id, driver_id, stops, status, distance_km, optimized_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        route.id,
        route.driver_id,
        JSON.stringify(route.stops),
        route.status,
        route.distance_km,
        route.optimized_at,
        route.created_at,
        route.updated_at,
      ],
    );
    return rowToRoute(rows[0]);
  },

  /**
   * @param {object} route
   * @returns {Promise<object|undefined>}
   */
  async update(route) {
    const { rows } = await pool.query(
      `UPDATE routes SET
         stops        = $1,
         status       = $2,
         distance_km  = $3,
         optimized_at = $4,
         updated_at   = $5
       WHERE id = $6
       RETURNING *`,
      [
        JSON.stringify(route.stops),
        route.status,
        route.distance_km,
        route.optimized_at,
        route.updated_at,
        route.id,
      ],
    );
    return rows[0] ? rowToRoute(rows[0]) : undefined;
  },

  /**
   * Contagens por status — consumido pelo painel admin.
   * @returns {Promise<{planned: number, in_progress: number, completed: number, cancelled: number}>}
   */
  async getStats() {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'PLANEJADA')    AS planned,
        COUNT(*) FILTER (WHERE status = 'EM_ANDAMENTO') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'CONCLUIDA')    AS completed,
        COUNT(*) FILTER (WHERE status = 'CANCELADA')    AS cancelled
      FROM routes
    `);

    const row = rows[0] ?? {};
    return {
      planned:     Number(row.planned     ?? 0),
      in_progress: Number(row.in_progress ?? 0),
      completed:   Number(row.completed   ?? 0),
      cancelled:   Number(row.cancelled   ?? 0),
    };
  },
};

module.exports = { RouteRepository, rowToRoute };
