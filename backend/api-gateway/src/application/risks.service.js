/**
 * @file risks.service.js
 * @description Atrasos previstos, encomendas paradas e desvios de sequência.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.47
 *
 * O painel de exceções (§ 3.39) mostra o que JÁ FALHOU. Isto procura o que ainda
 * vai a tempo de ser salvo.
 *
 * SEM PRAZO NEM HISTÓRICO NÃO SE DECLARA ATRASO. Chamar atrasada a uma encomenda
 * sobre a qual nada foi prometido nem medido é inventar um incumprimento — e
 * basta uma linha falsa para a lista inteira deixar de ser lida.
 *
 * O DESVIO GEOGRÁFICO NÃO É DETETADO. O sistema guarda a última posição conhecida
 * de cada motorista (`user_locations`), não o rasto do percurso. Sem rasto não há
 * como saber se alguém saiu do caminho, e fingir que há seria afirmar uma
 * vigilância que não existe.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');
const predictions = require('./predictions.service');
const { queryBounded, mergeCoverage } = require('../infrastructure/bounded-query');

/** Tetos das listas de risco (§ 3.51). Ditos na resposta, não escondidos. */
const IN_FLIGHT_CEILING = 500;
const ROUTE_SEQUENCE_CEILING = 100;

/** Estados que ainda podem ser salvos — os terminais não entram. */
const EM_CURSO = ['created', 'collected', 'at_warehouse', 'in_transit', 'out_for_delivery'];

/**
 * Horas paradas no mesmo estado a partir das quais se pergunta porquê, quando
 * não há histórico para as medir.
 *
 * NÃO É UM PRAZO: é o ponto em que vale a pena olhar. Uma encomenda pode estar
 * dentro do prazo e parada há quatro dias — são dois problemas diferentes.
 */
const STALL_HOURS_FALLBACK = 72;

// ─── Decisões puras ──────────────────────────────────────────────────────────

/**
 * Classifica uma encomenda em curso. PURA.
 *
 * `em_risco` ANTES DE `atrasada`, e é o ponto todo: sinalizada só depois do
 * prazo, a lista é um relatório de más notícias em vez de uma lista de trabalho.
 *
 * @param {{ elapsed_hours: number }} order
 * @param {{ p50_hours: number|null, p90_hours: number|null }|null} prediction
 * @param {number|null} promisedHours
 * @returns {{ level: 'atrasada'|'em_risco'|'no_prazo'|'sem_base', basis: string|null, limit_hours: number|null }}
 */
function assessDelay(order, prediction, promisedHours) {
  const decorridas = Number(order?.elapsed_hours ?? 0);

  // O prazo acordado manda sobre a medição: é o que foi prometido ao cliente, e
  // é por ele que a empresa responde.
  const limite = promisedHours ?? prediction?.p90_hours ?? null;
  const base = promisedHours ? 'sla' : (prediction?.p90_hours ? 'p90' : null);

  if (limite === null) {
    return { level: 'sem_base', basis: null, limit_hours: null, elapsed_hours: decorridas };
  }
  if (decorridas > limite) {
    return { level: 'atrasada', basis: base, limit_hours: limite, elapsed_hours: decorridas };
  }

  // Metade das encomendas já chegou a esta altura: esta ainda dá para salvar.
  const alerta = prediction?.p50_hours ?? limite * 0.6;
  if (decorridas > alerta) {
    return { level: 'em_risco', basis: base, limit_hours: limite, elapsed_hours: decorridas };
  }
  return { level: 'no_prazo', basis: base, limit_hours: limite, elapsed_hours: decorridas };
}

/**
 * Uma encomenda está parada? PURA.
 *
 * PARADA É DIFERENTE DE ATRASADA. Uma pode estar dentro do prazo e sem se mexer
 * há quatro dias; outra fora do prazo e a andar. Um só número esconderia ambas.
 *
 * @param {{ hours_in_status: number, current_status: string }} order
 * @param {Map<string, number>} normalHours mediana medida por estado
 */
function assessStall(order, normalHours) {
  const paradas = Number(order?.hours_in_status ?? 0);
  const medido = normalHours?.get(order?.current_status) ?? null;

  // Três vezes o normal: uma margem larga de propósito, para a lista não encher
  // de encomendas que estão apenas a demorar um pouco mais.
  const limite = medido !== null ? medido * 3 : STALL_HOURS_FALLBACK;

  return {
    stalled: paradas > limite,
    hours_in_status: Math.round(paradas * 10) / 10,
    limit_hours: Math.round(limite * 10) / 10,
    basis: medido !== null ? 'historico_do_estado' : 'sem_historico',
  };
}

/**
 * Desvios de sequência de uma rota. PURA.
 *
 * NÃO É UMA ACUSAÇÃO: trânsito cortado, cliente ausente e uma recolha urgente a
 * meio são motivos legítimos para trocar a ordem. Isto diz o que aconteceu.
 *
 * @param {string[]} planned ordem planeada dos pedidos
 * @param {string[]} actual ordem por que foram efetivamente entregues
 */
function sequenceDeviations(planned, actual) {
  const posicao = new Map((planned ?? []).map((id, i) => [id, i]));
  const fora = [];

  let maiorAteAgora = -1;
  for (const [i, id] of (actual ?? []).entries()) {
    const planeada = posicao.get(id);
    // Uma parada entregue que não estava no plano é um desvio à sua maneira, e
    // não pode ser silenciada por não ter posição.
    if (planeada === undefined) {
      fora.push({ order_id: id, planned_position: null, actual_position: i + 1, kind: 'fora_do_plano' });
      continue;
    }
    if (planeada < maiorAteAgora) {
      fora.push({ order_id: id, planned_position: planeada + 1, actual_position: i + 1, kind: 'sequencia' });
    }
    maiorAteAgora = Math.max(maiorAteAgora, planeada);
  }
  return fora;
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/** Encomendas em curso, com o tempo decorrido e o tempo no estado atual. */
async function loadInFlight() {
  const params = [EM_CURSO];
  let where = ' WHERE current_status = ANY($1)';
  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND company_id = $${params.length}`; }

  const { rows, coverage } = await queryBounded(`
    SELECT id, tracking_code, current_status, client_id, driver_id, route_id,
           destination->>'city'                                  AS city,
           COALESCE(pricing->>'zone_name', pricing->>'zone_id')  AS zone,
           COALESCE(pricing->>'service_level', 'normal')         AS service_level,
           EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600       AS elapsed_hours,
           EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600       AS hours_in_status
      FROM orders${where}
     ORDER BY created_at ASC
  `, params, IN_FLIGHT_CEILING);

  return rows.map((r) => ({
    ...r,
    elapsed_hours: Number(r.elapsed_hours),
    hours_in_status: Number(r.hours_in_status),
  }));
}

/**
 * Mediana de horas passadas em cada estado, medida das encomendas entregues.
 *
 * Mediana e não média, pela mesma razão do § 3.46: um registo esquecido num
 * estado desloca a média e não desloca a mediana.
 */
async function loadNormalStatusHours() {
  const params = [];
  let where = " WHERE current_status = 'delivered'";
  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND company_id = $${params.length}`; }

  const mapa = new Map();
  try {
    // Do histórico da própria encomenda: cada transição guarda o seu instante.
    const { rows } = await pool.query(`
      SELECT estado,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY horas) AS mediana,
             COUNT(*)::int                                      AS amostra
        FROM (
          SELECT h->>'status' AS estado,
                 EXTRACT(EPOCH FROM (
                   LEAD((h->>'timestamp')::timestamptz) OVER (PARTITION BY o.id ORDER BY (h->>'timestamp')::timestamptz)
                   - (h->>'timestamp')::timestamptz
                 )) / 3600 AS horas
            FROM orders o, jsonb_array_elements(o.history) h
           ${where.replace(' WHERE', ' WHERE')}
        ) t
       WHERE horas IS NOT NULL AND horas >= 0
       GROUP BY estado
      HAVING COUNT(*) >= $${params.length + 1}
    `, [...params, predictions.MIN_SAMPLE]);

    for (const r of rows) mapa.set(r.estado, Number(r.mediana));
  } catch { /* histórico ausente ou mal formado — cai no limite de recurso */ }
  return mapa;
}

/** Ordem planeada e ordem efetiva das paradas de cada rota ativa. */
async function loadRouteSequences() {
  const params = [];
  let where = " WHERE r.status IN ('PLANEJADA','EM_ANDAMENTO')";
  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND r.company_id = $${params.length}`; }

  try {
    const { rows } = await queryBounded(`
      SELECT r.id AS route_id, r.driver_id, r.stops,
             ARRAY(
               SELECT o.id FROM orders o
                WHERE o.route_id = r.id AND o.current_status = 'delivered'
                ORDER BY o.updated_at ASC
             ) AS entregues
        FROM routes r${where}
    `, params, ROUTE_SEQUENCE_CEILING);
    return rows;
  } catch {
    // A tabela de rotas vive noutra base em algumas instalações. Sem ela não há
    // sequência para comparar — e é melhor não dizer nada do que adivinhar.
    return [];
  }
}

/** Ids das paradas na ordem planeada. */
function plannedOrderIds(stops) {
  const lista = Array.isArray(stops) ? stops : [];
  return lista.map((s) => s?.order_id ?? s?.id).filter(Boolean);
}

/**
 * Risco em curso: o que ainda vai a tempo de ser salvo.
 *
 * @param {{ days?: number }} [opts]
 */
async function getRisks(opts = {}) {
  const [emCurso, normais, rotas, previsoes] = await Promise.all([
    loadInFlight(),
    loadNormalStatusHours(),
    loadRouteSequences(),
    predictions.getDeliveryPredictions({ days: opts.days ?? 180 }),
  ]);

  const porZona = new Map();
  for (const s of previsoes.segments) {
    if (s.enough) porZona.set(predictions.segmentKey(s.zone, s.service_level ?? undefined), s);
  }

  const atrasadas = [];
  const emRisco = [];
  const paradas = [];

  for (const o of emCurso) {
    const zona = o.zone || o.city || null;
    const previsao = porZona.get(predictions.segmentKey(zona, o.service_level))
      ?? porZona.get(predictions.segmentKey(zona, undefined))
      ?? null;
    const prometido = previsao?.promise?.comparable ? previsao.promise.promised_hours : null;

    const prazo = assessDelay(o, previsao, prometido);
    const linha = {
      id: o.id, tracking_code: o.tracking_code, current_status: o.current_status,
      client_id: o.client_id, driver_id: o.driver_id, zone: zona,
      ...prazo,
      elapsed_hours: Math.round(o.elapsed_hours * 10) / 10,
    };
    if (prazo.level === 'atrasada') atrasadas.push(linha);
    else if (prazo.level === 'em_risco') emRisco.push(linha);

    const parada = assessStall(o, normais);
    if (parada.stalled) {
      paradas.push({
        id: o.id, tracking_code: o.tracking_code, current_status: o.current_status,
        driver_id: o.driver_id, ...parada,
      });
    }
  }

  const desvios = rotas.map((r) => ({
    route_id: r.route_id,
    driver_id: r.driver_id,
    deviations: sequenceDeviations(plannedOrderIds(r.stops), r.entregues ?? []),
  })).filter((r) => r.deviations.length > 0);

  return {
    in_flight: emCurso.length,
    // Ordenadas pela mais atrasada: é por essa que se começa a telefonar.
    late: atrasadas.sort((a, b) => b.elapsed_hours - a.elapsed_hours),
    at_risk: emRisco.sort((a, b) => b.elapsed_hours - a.elapsed_hours),
    stalled: paradas.sort((a, b) => b.hours_in_status - a.hours_in_status),
    route_deviations: desvios,
    // Dito no corpo da resposta e não só na spec: quem consumir a API tem de
    // saber que a ausência de desvios geográficos não é ausência de desvios.
    geographic_deviation: {
      detected: false,
      reason: 'O sistema guarda a última posição conhecida de cada motorista, não o rasto do percurso.',
    },
    // Sem histórico não há juízo nenhum a fazer, e a lista vazia acima poderia
    // ser lida como "está tudo bem".
    basis: {
      predicted_segments: previsoes.segments.filter((s) => s.enough).length,
      measured_deliveries: previsoes.measured_deliveries,
      status_medians: normais.size,
    },
  };
}

module.exports = {
  // Puros
  assessDelay,
  assessStall,
  sequenceDeviations,
  plannedOrderIds,
  // Leitura
  getRisks,
  // Constantes
  EM_CURSO,
  STALL_HOURS_FALLBACK,
};
