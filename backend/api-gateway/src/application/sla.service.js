/**
 * @file sla.service.js
 * @description SLA de entrega — prazo acordado, cumprimento e incumprimento.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 * O PRAZO É ACORDADO, NUNCA DEDUZIDO. Seria tecnicamente possível derivá-lo da
 * mediana das entregas passadas, e seria pior do que não ter nenhum: um SLA
 * medido contra o próprio desempenho anterior **nunca acusa incumprimento**,
 * porque o alvo persegue o resultado. Uma operação que piora todos os meses
 * continuaria a cumprir 100% do seu "SLA". Melhor não ter número do que ter um
 * que mente.
 *
 * O relógio conta da CRIAÇÃO da encomenda e para na ENTREGA. Uma encomenda ainda
 * a caminho e já fora do prazo está incumprida AGORA — é essa a diferença entre
 * um mapa de SLA e um relatório de autópsia.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');

/** Resultados possíveis da avaliação de uma encomenda. */
const SlaOutcome = Object.freeze({
  ON_TIME:    'cumprido',
  BREACHED:   'incumprido',
  RUNNING:    'em_curso',
  NO_TARGET:  'sem_prazo_acordado',
});

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Prazo prometido para uma encomenda, em horas. PURA.
 *
 * `null` quando a zona não tem prazo acordado para aquele nível de serviço — e
 * `null` não é zero: zero significaria "entregar imediatamente" e poria tudo em
 * incumprimento.
 *
 * @param {{ service?: string }} order
 * @param {{ sla_hours_normal?: number|null, sla_hours_express?: number|null }|null} zone
 * @returns {number|null}
 */
function targetHours(order, zone) {
  if (!zone) return null;
  const horas = order?.service === 'express' ? zone.sla_hours_express : zone.sla_hours_normal;
  const n = Number(horas);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Avalia o SLA de uma encomenda. PURA.
 *
 * @param {object} order
 * @param {object|null} zone
 * @param {string} nowIso
 * @returns {{ outcome: string, target_hours: number|null, elapsed_hours: number|null, over_by_hours: number }}
 */
function evaluateSla(order, zone, nowIso) {
  const alvo = targetHours(order, zone);
  if (alvo === null) {
    return { outcome: SlaOutcome.NO_TARGET, target_hours: null, elapsed_hours: null, over_by_hours: 0 };
  }

  const inicio = Date.parse(order?.created_at);
  if (!Number.isFinite(inicio)) {
    return { outcome: SlaOutcome.NO_TARGET, target_hours: alvo, elapsed_hours: null, over_by_hours: 0 };
  }

  // Encomendas que nunca vão ser entregues não têm SLA de entrega a cumprir:
  // uma devolvida ou cancelada é outra história, e contá-la como incumprimento
  // misturaria dois problemas com respostas diferentes.
  if (['cancelled', 'returned'].includes(order?.current_status)) {
    return { outcome: SlaOutcome.NO_TARGET, target_hours: alvo, elapsed_hours: null, over_by_hours: 0 };
  }

  const entregue = order?.current_status === 'delivered';
  const fim = entregue ? Date.parse(order?.delivered_at ?? order?.updated_at) : Date.parse(nowIso);
  if (!Number.isFinite(fim)) {
    return { outcome: SlaOutcome.NO_TARGET, target_hours: alvo, elapsed_hours: null, over_by_hours: 0 };
  }

  const decorridas = Math.max(0, (fim - inicio) / 3_600_000);
  const excedeu = decorridas > alvo;

  return {
    outcome: excedeu
      ? SlaOutcome.BREACHED
      // Ainda a caminho e dentro do prazo não é sucesso nem falha: é uma
      // pergunta ainda sem resposta, e contá-la como cumprida inflacionaria o
      // indicador com encomendas que ainda podem falhar.
      : (entregue ? SlaOutcome.ON_TIME : SlaOutcome.RUNNING),
    target_hours: alvo,
    elapsed_hours: Math.round(decorridas * 10) / 10,
    over_by_hours: excedeu ? Math.round((decorridas - alvo) * 10) / 10 : 0,
  };
}

/**
 * Resume o cumprimento de um conjunto de encomendas. PURA.
 *
 * A taxa é sobre o que já tem resposta — cumpridas mais incumpridas. Incluir as
 * que ainda estão dentro do prazo daria uma taxa que baixa sozinha à medida que
 * o dia passa, sem nada ter acontecido.
 *
 * @param {Array<{ outcome: string }>} evaluations
 * @returns {object}
 */
function summarizeSla(evaluations) {
  const contagem = { cumprido: 0, incumprido: 0, em_curso: 0, sem_prazo_acordado: 0 };
  for (const e of evaluations ?? []) {
    if (contagem[e?.outcome] !== undefined) contagem[e.outcome] += 1;
  }

  const decididas = contagem.cumprido + contagem.incumprido;
  return {
    ...contagem,
    total: (evaluations ?? []).length,
    compliance_pct: decididas === 0 ? null : Math.round((contagem.cumprido / decididas) * 1000) / 10,
    // Diz quantas ficaram fora da conta por falta de prazo acordado: uma taxa de
    // 100% sobre três encomendas de trinta não é uma taxa de 100%.
    measured: decididas,
  };
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

function companyFilter(params, alias = '') {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  return ` AND ${alias ? `${alias}.` : ''}company_id = $${params.length}`;
}

/**
 * Carrega as encomendas com o prazo da sua zona e avalia cada uma.
 *
 * A zona e o nível de serviço vêm de `orders.pricing`, gravado no orçamento
 * (§ 3.13) — é o registo do que foi acordado no momento da venda, e não a zona
 * que a tabela tem hoje.
 *
 * @param {{ from?: string, to?: string, now?: string }} [opts]
 */
async function loadEvaluations(opts = {}) {
  const agora = opts.now ?? new Date().toISOString();

  const params = [];
  const clauses = [];
  const cid = readCompanyId();
  if (cid) { params.push(cid); clauses.push(`o.company_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); clauses.push(`o.created_at >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   clauses.push(`o.created_at < $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows } = await pool.query(`
    SELECT o.id, o.tracking_code, o.current_status, o.created_at, o.updated_at,
           o.pricing ->> 'zone_code' AS zone_code,
           o.pricing ->> 'service'   AS service,
           z.sla_hours_normal, z.sla_hours_express
      FROM orders o
      LEFT JOIN pricing_zones z ON z.code = o.pricing ->> 'zone_code'
      ${where}
     ORDER BY o.created_at DESC
     LIMIT 2000
  `, params);

  return rows.map((row) => {
    const order = {
      id: row.id,
      tracking_code: row.tracking_code,
      current_status: row.current_status,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      // A entrega não tem coluna própria: `updated_at` de uma encomenda
      // `delivered` é o momento em que ficou entregue.
      delivered_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      service: row.service ?? 'normal',
      zone_code: row.zone_code,
    };
    const zone = row.zone_code
      ? { sla_hours_normal: row.sla_hours_normal, sla_hours_express: row.sla_hours_express }
      : null;

    return { ...order, ...evaluateSla(order, zone, agora) };
  });
}

/** Resumo do cumprimento no período. */
async function getSlaSummary(opts = {}) {
  const avaliadas = await loadEvaluations(opts);
  return {
    ...summarizeSla(avaliadas),
    // Sem zonas com prazo definido, o indicador não existe — e dizê-lo é mais
    // útil do que mostrar zero.
    zones_with_target: await countZonesWithTarget(),
  };
}

/** As encomendas em incumprimento, da que está há mais tempo fora do prazo. */
async function getSlaBreaches(opts = {}) {
  const avaliadas = await loadEvaluations(opts);
  return avaliadas
    .filter((a) => a.outcome === 'incumprido')
    .sort((a, b) => b.over_by_hours - a.over_by_hours)
    .slice(0, 200);
}

/** Quantas zonas ativas já têm prazo acordado. */
async function countZonesWithTarget() {
  const params = [];
  const filtro = companyFilter(params);
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE sla_hours_normal IS NOT NULL OR sla_hours_express IS NOT NULL) AS com_prazo,
           COUNT(*) AS total
      FROM pricing_zones
     WHERE active = TRUE${filtro}
  `, params);
  return { with_target: Number(rows[0].com_prazo), total: Number(rows[0].total) };
}

module.exports = {
  // Puros
  targetHours,
  evaluateSla,
  summarizeSla,
  SlaOutcome,
  // Leitura
  loadEvaluations,
  getSlaSummary,
  getSlaBreaches,
  countZonesWithTarget,
};
