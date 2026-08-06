/**
 * @file pg.repository.js
 * @description Camada de acesso a dados do tracking-intl-service.
 *
 * Single Responsibility: ÚNICO arquivo que faz queries no banco deste serviço.
 * Arquitetura: Repository Pattern.
 */
'use strict';

const pool = require('./db');
// Multiempresa (spec § 2.4): partilha o AsyncLocalStorage do gateway (mesmo processo).
// O poller corre sem contexto → sem filtro (vê todas as empresas).
const { readCompanyId, writeCompanyId } = require('../../../api-gateway/src/infrastructure/tenant-context');

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
function rowToEvent(row) {
  return {
    id:                row.id,
    tracking_code:     row.tracking_code,
    carrier:           row.carrier,
    status:            row.status,
    raw_status:        row.raw_status,
    location:          row.location ?? null,
    description:       row.description ?? null,
    carrier_timestamp: toIso(row.carrier_timestamp),
    event_hash:        row.event_hash,
    created_at:        toIso(row.created_at),
  };
}

const TrackingRepository = {
  /**
   * @param {string} trackingCode
   * @returns {Promise<object[]>} do mais recente para o mais antigo
   */
  async findByCode(trackingCode) {
    const { rows } = await pool.query(
      'SELECT * FROM tracking_events WHERE tracking_code = $1 ORDER BY carrier_timestamp DESC',
      [trackingCode],
    );
    return rows.map(rowToEvent);
  },

  /**
   * Insere apenas os eventos que ainda não existem.
   *
   * O `ON CONFLICT DO NOTHING` sobre `event_hash` é a defesa estrutural contra
   * duplicação: mesmo que dois ciclos de polling corram em simultâneo, o banco
   * garante que cada leitura entra uma só vez.
   *
   * @param {object[]} eventos
   * @returns {Promise<object[]>} apenas os efetivamente inseridos
   */
  async insertMany(eventos) {
    if (!Array.isArray(eventos) || eventos.length === 0) return [];

    const inseridos = [];

    for (const e of eventos) {
      const { rows } = await pool.query(
        `INSERT INTO tracking_events (
           id, tracking_code, carrier, status, raw_status,
           location, description, carrier_timestamp, event_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (event_hash) DO NOTHING
         RETURNING *`,
        [
          e.id, e.tracking_code, e.carrier, e.status, e.raw_status,
          e.location, e.description, e.carrier_timestamp, e.event_hash, e.created_at,
        ],
      );

      if (rows[0]) inseridos.push(rowToEvent(rows[0]));
    }

    return inseridos;
  },

  /**
   * Códigos que devem ser consultados no próximo ciclo de polling.
   * Exclui os que já chegaram a um estado final.
   *
   * @param {number} [limite]
   * @returns {Promise<{tracking_code: string, carrier: string}[]>}
   */
  async findCodesToPoll(limite = 100) {
    const { rows } = await pool.query(
      `SELECT tracking_code, carrier
         FROM tracked_shipments
        WHERE active = TRUE
        ORDER BY last_polled_at ASC NULLS FIRST
        LIMIT $1`,
      [limite],
    );
    return rows;
  },

  /**
   * Regista um código para acompanhamento. Idempotente.
   *
   * @param {{ tracking_code: string, carrier: string }} dto
   * @returns {Promise<object>}
   */
  async trackShipment(dto) {
    // A empresa é fixada na criação; em conflito NÃO é alterada (um código pertence
    // a uma empresa).
    const { rows } = await pool.query(
      `INSERT INTO tracked_shipments (tracking_code, carrier, active, company_id, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3, NOW(), NOW())
       ON CONFLICT (tracking_code) DO UPDATE
         SET carrier = EXCLUDED.carrier,
             active = TRUE,
             updated_at = NOW()
       RETURNING *`,
      [dto.tracking_code, dto.carrier, dto.company_id ?? writeCompanyId()],
    );
    return rows[0];
  },

  /**
   * Marca o momento da última consulta e, se o estado for final, desativa o
   * acompanhamento — não faz sentido continuar a consultar uma encomenda entregue.
   *
   * @param {string} trackingCode
   * @param {boolean} finalizado
   * @returns {Promise<void>}
   */
  async markPolled(trackingCode, finalizado) {
    await pool.query(
      `UPDATE tracked_shipments
          SET last_polled_at = NOW(),
              active = $2,
              updated_at = NOW()
        WHERE tracking_code = $1`,
      [trackingCode, !finalizado],
    );
  },

  /**
   * Lista os envios rastreados com o status atual (evento mais recente) e a
   * contagem de eventos, dos mais recentemente atualizados para os mais antigos.
   *
   * @param {number} [limite]
   * @returns {Promise<object[]>}
   */
  async listShipments(limite = 100) {
    const params = [];
    const cid = readCompanyId();
    const where = cid ? (params.push(cid), `WHERE s.company_id = $${params.length}`) : '';
    params.push(limite);
    const { rows } = await pool.query(
      `SELECT
         s.tracking_code,
         s.carrier,
         s.active,
         s.last_polled_at,
         s.created_at,
         s.updated_at,
         (SELECT e.status
            FROM tracking_events e
           WHERE e.tracking_code = s.tracking_code
           ORDER BY e.carrier_timestamp DESC
           LIMIT 1)                                                      AS current_status,
         (SELECT COUNT(*) FROM tracking_events e
           WHERE e.tracking_code = s.tracking_code)                     AS event_count
       FROM tracked_shipments s
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      tracking_code:  row.tracking_code,
      carrier:        row.carrier,
      active:         row.active,
      last_polled_at: row.last_polled_at ? toIso(row.last_polled_at) : null,
      current_status: row.current_status ?? null,
      event_count:    Number(row.event_count ?? 0),
      created_at:     toIso(row.created_at),
      updated_at:     toIso(row.updated_at),
    }));
  },

  /**
   * @returns {Promise<object>}
   */
  async getStats() {
    const cid = readCompanyId();
    // Filtros de empresa (mesmo $1 reutilizado nas subqueries) quando há contexto.
    const params = cid ? [cid] : [];
    const sFilter = cid ? ' AND s.company_id = $1' : '';
    const sWhere  = cid ? ' WHERE company_id = $1' : '';
    const evFilter = cid
      ? ' WHERE EXISTS (SELECT 1 FROM tracked_shipments s WHERE s.tracking_code = tracking_events.tracking_code AND s.company_id = $1)'
      : '';
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tracking_events${evFilter})                          AS events,
        (SELECT COUNT(*) FROM tracked_shipments s WHERE s.active${sFilter})         AS active_shipments,
        (SELECT COUNT(*) FROM tracked_shipments s WHERE NOT s.active${sFilter})     AS finished_shipments,
        (SELECT COUNT(DISTINCT carrier) FROM tracked_shipments${sWhere})            AS carriers
    `, params);

    const row = rows[0] ?? {};
    return {
      events:             Number(row.events             ?? 0),
      active_shipments:   Number(row.active_shipments   ?? 0),
      finished_shipments: Number(row.finished_shipments ?? 0),
      carriers:           Number(row.carriers           ?? 0),
    };
  },
};

module.exports = { TrackingRepository, rowToEvent };
