/**
 * @file operations.service.js
 * @description Dashboard operacional — indicadores agregados e fila de exceções.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.39
 *
 * PORQUÊ EXISTE: o painel carregava a primeira página de encomendas e contava
 * sobre ela no navegador. Numa empresa com mais de 200 encomendas, os
 * indicadores descreviam uma amostra e apresentavam-se como o retrato da
 * operação. Um número errado com ar de autoridade é pior do que número nenhum.
 *
 * Duas regras estruturam o módulo:
 *
 *   1. **Contar é trabalho da base.** Nada aqui percorre listas de encomendas em
 *      JavaScript. As contagens são `COUNT(*) FILTER (...)` sobre a empresa
 *      inteira, num só ida à base.
 *
 *   2. **Só entra o que exige uma decisão.** Uma encomenda `in_transit` normal
 *      não é uma exceção — é o percurso a correr bem. Entra a que ficou parada
 *      à espera de uma pessoa. Encher a lista com estados normais faz o urgente
 *      desaparecer debaixo do trivial, que é o mesmo que não ter lista.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');

/** Dias no armazém a partir dos quais a carga conta como parada. */
const STALE_WAREHOUSE_DAYS = Number(process.env.OPS_STALE_WAREHOUSE_DAYS) || 7;

/** Dias em trânsito a partir dos quais ou se perdeu, ou ninguém deu entrada. */
const STALE_TRANSIT_DAYS = Number(process.env.OPS_STALE_TRANSIT_DAYS) || 3;

/** Teto de linhas por espécie — a fila é para agir, não para arquivar. */
const MAX_PER_KIND = 50;

/**
 * Peso de cada espécie de exceção. PURA.
 *
 * Quanto mais perto do cliente final, mais alto: um reagendamento vencido
 * significa alguém que ficou à espera num dia que já passou — destrói mais
 * confiança do que uma caixa parada no armazém, que ninguém viu.
 */
const KIND_WEIGHT = Object.freeze({
  overdue_reschedule:     100,
  failed_without_decision: 90,
  transfer_missing_items:  70,
  stale_in_transit:        60,
  credit_limit_exceeded:   50,
  stale_in_warehouse:      40,
});

/**
 * Severidade de uma exceção. PURA.
 *
 * Espécie mais antiguidade: o peso da espécie manda, e o tempo parado desempata
 * e agrava. Sem o tempo, dez insucessos do mesmo dia apareciam pela ordem em que
 * a base os devolveu; sem a espécie, uma caixa esquecida há um mês passava à
 * frente de um cliente que ficou à espera ontem.
 *
 * @param {{ kind: string, age_days?: number }} exc
 * @returns {number}
 */
function severity(exc) {
  const base = KIND_WEIGHT[exc?.kind] ?? 10;
  const dias = Math.max(0, Number(exc?.age_days) || 0);
  // O tempo agrava, mas nunca ao ponto de uma espécie leve saltar por cima de
  // uma grave: o teto de 30 mantém a ordem das espécies legível.
  return base + Math.min(dias, 30);
}

/**
 * Ordena a fila do mais urgente para o menos. PURA.
 * @param {object[]} exceptions
 * @returns {object[]} Nova lista; a original não é alterada.
 */
function rankExceptions(exceptions) {
  return [...(exceptions ?? [])]
    .map((e) => ({ ...e, severity: severity(e) }))
    .sort((a, b) => b.severity - a.severity);
}

/** Cláusula de empresa para uma consulta sem outro WHERE. PURA-ish (lê o contexto). */
function companyFilter(params, alias = '') {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  return ` AND ${alias ? `${alias}.` : ''}company_id = $${params.length}`;
}

/**
 * Indicadores da operação, contados na base.
 *
 * Um só `SELECT` com `FILTER`: são seis contagens sobre a mesma tabela, e
 * seis consultas separadas custariam seis varreduras para responder à mesma
 * pergunta.
 *
 * @returns {Promise<object>}
 */
async function getSummary() {
  const params = [];
  const filtro = companyFilter(params);

  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                                                        AS total,
      COUNT(*) FILTER (WHERE current_status = 'delivered')                            AS delivered,
      COUNT(*) FILTER (WHERE current_status = 'failed')                               AS failed,
      COUNT(*) FILTER (WHERE current_status = 'returned')                             AS returned,
      COUNT(*) FILTER (WHERE current_status = 'at_warehouse')                         AS at_warehouse,
      COUNT(*) FILTER (WHERE current_status IN ('in_transit','out_for_delivery'))     AS moving,
      COUNT(*) FILTER (WHERE current_status NOT IN ('delivered','cancelled','returned')) AS open,
      COUNT(*) FILTER (WHERE cod_status = 'pending')                                  AS cod_pending,
      COALESCE(SUM(cod_amount) FILTER (WHERE cod_status = 'collected'), 0)            AS cod_collected_cents,
      -- Receita RECONHECIDA: só o que foi entregue. Somar o que está a caminho
      -- seria contar dinheiro que ainda pode voltar como devolução.
      COALESCE(SUM(value) FILTER (WHERE current_status = 'delivered'), 0)             AS revenue_cents
    FROM orders
    WHERE TRUE${filtro}
  `, params);

  const r = rows[0];
  const entregues = Number(r.delivered);
  const falhadas  = Number(r.failed) + Number(r.returned);

  const driverParams = [];
  const driverFiltro = companyFilter(driverParams);
  const { rows: frota } = await pool.query(`
    SELECT
      COUNT(*)                                            AS total,
      COUNT(*) FILTER (WHERE current_status = 'available') AS available,
      COUNT(*) FILTER (WHERE current_status = 'on_route')  AS on_route
    FROM drivers
    WHERE TRUE${driverFiltro}
  `, driverParams);

  return {
    orders: {
      total:        Number(r.total),
      open:         Number(r.open),
      delivered:    entregues,
      failed:       Number(r.failed),
      returned:     Number(r.returned),
      at_warehouse: Number(r.at_warehouse),
      moving:       Number(r.moving),
      // Taxa sobre o que já terminou, não sobre o total: contar as que ainda
      // estão a caminho como insucesso dava uma taxa que melhora sozinha com o
      // tempo, sem ninguém fazer nada.
      success_rate_pct: entregues + falhadas === 0
        ? null
        : Math.round((entregues / (entregues + falhadas)) * 1000) / 10,
      revenue_cents: Number(r.revenue_cents),
    },
    cod: {
      pending_orders:      Number(r.cod_pending),
      collected_cents:     Number(r.cod_collected_cents),
    },
    fleet: {
      total:     Number(frota[0].total),
      available: Number(frota[0].available),
      on_route:  Number(frota[0].on_route),
    },
    thresholds: {
      stale_warehouse_days: STALE_WAREHOUSE_DAYS,
      stale_transit_days:   STALE_TRANSIT_DAYS,
    },
  };
}

/**
 * A fila do que está à espera de uma pessoa.
 *
 * @returns {Promise<{ exceptions: object[], counts: object }>}
 */
async function getExceptions() {
  const exceptions = [];

  // ── Insucesso sem decisão ────────────────────────────────────────────────
  // `next_attempt_on IS NULL AND return_info IS NULL` é o que distingue "falhou
  // e alguém já tratou" de "falhou e está parado": foi o § 3.37 que tornou esta
  // pergunta respondível.
  {
    const params = [];
    const filtro = companyFilter(params);
    const { rows } = await pool.query(`
      SELECT id, tracking_code, delivery_attempts,
             EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS age_days
        FROM orders
       WHERE current_status = 'failed'
         AND next_attempt_on IS NULL
         AND return_info IS NULL${filtro}
       ORDER BY updated_at ASC
       LIMIT ${MAX_PER_KIND}
    `, params);

    for (const row of rows) {
      exceptions.push({
        kind: 'failed_without_decision',
        entity_id: row.id,
        label: row.tracking_code,
        age_days: Math.floor(Number(row.age_days)),
        detail: `Insucesso há ${Math.floor(Number(row.age_days))} dia(s) sem reagendamento nem devolução`
          + ` (${row.delivery_attempts} tentativa(s))`,
      });
    }
  }

  // ── Reagendamento vencido ────────────────────────────────────────────────
  {
    const params = [];
    const filtro = companyFilter(params);
    const { rows } = await pool.query(`
      SELECT id, tracking_code, next_attempt_on,
             (CURRENT_DATE - next_attempt_on) AS days_late
        FROM orders
       WHERE next_attempt_on IS NOT NULL
         AND next_attempt_on < CURRENT_DATE
         AND current_status NOT IN ('delivered', 'cancelled', 'returned')${filtro}
       ORDER BY next_attempt_on ASC
       LIMIT ${MAX_PER_KIND}
    `, params);

    for (const row of rows) {
      exceptions.push({
        kind: 'overdue_reschedule',
        entity_id: row.id,
        label: row.tracking_code,
        age_days: Number(row.days_late),
        detail: `Nova tentativa combinada para ${String(row.next_attempt_on).slice(0, 10)} — ${row.days_late} dia(s) em atraso`,
      });
    }
  }

  // ── Parada no armazém ────────────────────────────────────────────────────
  {
    const params = [];
    const filtro = companyFilter(params);
    const { rows } = await pool.query(`
      SELECT id, tracking_code,
             EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS age_days
        FROM orders
       WHERE current_status = 'at_warehouse'
         AND updated_at < NOW() - INTERVAL '${STALE_WAREHOUSE_DAYS} days'${filtro}
       ORDER BY updated_at ASC
       LIMIT ${MAX_PER_KIND}
    `, params);

    for (const row of rows) {
      exceptions.push({
        kind: 'stale_in_warehouse',
        entity_id: row.id,
        label: row.tracking_code,
        age_days: Math.floor(Number(row.age_days)),
        detail: `Parada no armazém há ${Math.floor(Number(row.age_days))} dia(s)`,
      });
    }
  }

  // ── Em trânsito há demasiado tempo ───────────────────────────────────────
  {
    const params = [];
    const filtro = companyFilter(params);
    const { rows } = await pool.query(`
      SELECT id, tracking_code,
             EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS age_days
        FROM orders
       WHERE current_status = 'in_transit'
         AND updated_at < NOW() - INTERVAL '${STALE_TRANSIT_DAYS} days'${filtro}
       ORDER BY updated_at ASC
       LIMIT ${MAX_PER_KIND}
    `, params);

    for (const row of rows) {
      exceptions.push({
        kind: 'stale_in_transit',
        entity_id: row.id,
        label: row.tracking_code,
        age_days: Math.floor(Number(row.age_days)),
        detail: `Em trânsito há ${Math.floor(Number(row.age_days))} dia(s) sem dar entrada em lado nenhum`,
      });
    }
  }

  // ── Transferências com encomendas em falta ───────────────────────────────
  {
    const params = [];
    const filtro = companyFilter(params, 't');
    const { rows } = await pool.query(`
      SELECT t.id, t.code, COUNT(i.id) AS missing,
             EXTRACT(EPOCH FROM (NOW() - t.received_at)) / 86400 AS age_days
        FROM warehouse_transfers t
        JOIN warehouse_transfer_items i ON i.transfer_id = t.id AND i.status = 'missing'
       WHERE t.status = 'received'${filtro}
       GROUP BY t.id, t.code, t.received_at
       ORDER BY t.received_at ASC
       LIMIT ${MAX_PER_KIND}
    `, params);

    for (const row of rows) {
      exceptions.push({
        kind: 'transfer_missing_items',
        entity_id: row.id,
        label: row.code,
        age_days: Math.floor(Number(row.age_days ?? 0)),
        detail: `${row.missing} encomenda(s) do manifesto não chegaram`,
      });
    }
  }

  // ── Clientes acima do limite de crédito ──────────────────────────────────
  // Quem atende precisa de saber ANTES de o cliente telefonar a perguntar
  // porque é que a encomenda foi recusada (§ 3.35).
  {
    const params = [];
    const filtro = companyFilter(params, 'c');
    const { rows } = await pool.query(`
      SELECT c.client_ref_id, c.code, c.credit_limit_cents,
             COALESCE(SUM(i.total_cents) FILTER (WHERE i.doc_type IN ('FT','FR') AND i.status = 'issued'), 0)
               - COALESCE(SUM(i.total_cents) FILTER (WHERE i.doc_type = 'NC' AND i.status <> 'void'), 0) AS outstanding
        FROM client_contracts c
        LEFT JOIN invoices i ON i.client_ref_id = c.client_ref_id
       WHERE c.status = 'active' AND c.credit_limit_cents > 0${filtro}
       GROUP BY c.client_ref_id, c.code, c.credit_limit_cents
      HAVING COALESCE(SUM(i.total_cents) FILTER (WHERE i.doc_type IN ('FT','FR') AND i.status = 'issued'), 0)
             - COALESCE(SUM(i.total_cents) FILTER (WHERE i.doc_type = 'NC' AND i.status <> 'void'), 0)
             > c.credit_limit_cents
       LIMIT ${MAX_PER_KIND}
    `, params);

    for (const row of rows) {
      exceptions.push({
        kind: 'credit_limit_exceeded',
        entity_id: row.client_ref_id,
        label: row.code,
        age_days: 0,
        detail: `${(Number(row.outstanding) / 100).toFixed(2)} MZN em dívida `
          + `contra um limite de ${(Number(row.credit_limit_cents) / 100).toFixed(2)} MZN`,
      });
    }
  }

  const ordenadas = rankExceptions(exceptions);
  const counts = ordenadas.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});

  return { exceptions: ordenadas, counts, total: ordenadas.length };
}

module.exports = {
  // Puros
  severity,
  rankExceptions,
  KIND_WEIGHT,
  // Casos de uso
  getSummary,
  getExceptions,
  // Constantes
  STALE_WAREHOUSE_DAYS,
  STALE_TRANSIT_DAYS,
};
