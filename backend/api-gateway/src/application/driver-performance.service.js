/**
 * @file driver-performance.service.js
 * @description Desempenho dos motoristas, medido das encomendas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.43 (implementa o § 3.7)
 *
 * O QUE ESTAVA ERRADO: cada motorista nascia com `punctuality: 100`,
 * `success_rate: 100`, `customer_rating: 5` e nunca mais nada era recalculado.
 * Um motorista com dez insucessos continuava a exibir 100% de sucesso, no ecrã
 * onde se decide quem fica com as melhores rotas. Pior do que não ter indicador:
 * um número com ar de medição a dizer o contrário da realidade.
 *
 * A AVALIAÇÃO DO CLIENTE FOI REMOVIDA, não corrigida. Nunca existiu nada no
 * sistema que pedisse ao destinatário para avaliar a entrega — os 5,0 eram
 * inteiramente inventados. Recolher avaliações é uma funcionalidade por si, e
 * enquanto não existir o campo desaparece: mostrar `—` é honesto, mostrar 5,0 é
 * uma mentira que alguém vai usar para promover ou despedir.
 *
 * CALCULADO DA FONTE, NUNCA GUARDADO. Guardar os indicadores numa coluna criaria
 * um número que envelhece em silêncio, que é o defeito que isto corrige.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');
const { queryBounded } = require('../infrastructure/bounded-query');

/**
 * Teto da amostra de desempenho (§ 3.51).
 *
 * Alto de propósito: este ecrã decide quem fica com as melhores rotas, e uma
 * amostra curta dava um retrato injusto de quem trabalhou mais. Acima dele, a
 * resposta diz que truncou em vez de fingir que viu tudo.
 */
const PERFORMANCE_CEILING = 5000;

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Percentagem com uma casa, ou `null` quando não há amostra. PURA.
 *
 * `null` e não zero: uma taxa de 0% para quem começou ontem é uma acusação, e
 * uma de 100% para quem fez uma entrega é um elogio sem base.
 *
 * @param {number} parte
 * @param {number} total
 * @returns {number|null}
 */
function rate(parte, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((parte / total) * 1000) / 10;
}

/**
 * Indicadores de um motorista a partir das suas encomendas. PURA.
 *
 * @param {Array<object>} orders Encomendas ATRIBUÍDAS a este motorista.
 * @returns {object}
 */
function computePerformance(orders) {
  const lista = orders ?? [];

  const entregues = lista.filter((o) => o?.current_status === 'delivered');
  const falhadas  = lista.filter((o) => o?.current_status === 'failed');
  const devolvidas = lista.filter((o) => o?.current_status === 'returned');

  // Só o que já terminou entra no denominador: uma encomenda a caminho ainda não
  // é sucesso nem insucesso, e contá-la faria a taxa mover-se sozinha.
  const concluidas = entregues.length + falhadas.length + devolvidas.length;

  // Sucesso à primeira: entregue sem nenhum reagendamento pelo caminho. É o que
  // distingue quem resolve de quem volta lá três vezes — e é precisamente o que
  // a taxa de sucesso sozinha esconde.
  const aPrimeira = entregues.filter((o) => (Number(o?.delivery_attempts) || 0) === 0).length;

  // Pontualidade só onde existe prazo acordado (§ 3.42). Numa operação sem SLA
  // definido isto vem `null`, não 100%.
  const comPrazo = entregues.filter((o) => o?.sla_outcome === 'cumprido' || o?.sla_outcome === 'incumprido');
  const noPrazo = comPrazo.filter((o) => o.sla_outcome === 'cumprido').length;

  // COD cobrado e ainda não entregue à empresa. Não é qualidade de serviço, é
  // exposição de caixa — daí aparecer separado e nunca dentro de uma "nota".
  const codPorAcertar = lista
    .filter((o) => o?.cod_status === 'collected')
    .reduce((soma, o) => soma + (Number(o.cod_amount) || 0), 0);

  return {
    deliveries: entregues.length,
    failures: falhadas.length,
    returns: devolvidas.length,
    in_progress: lista.length - concluidas,

    success_rate_pct: rate(entregues.length, concluidas),
    first_attempt_rate_pct: rate(aPrimeira, entregues.length),
    punctuality_pct: rate(noPrazo, comPrazo.length),

    // Quantas encomendas sustentam cada taxa. Sem isto, 100% sobre uma entrega
    // é indistinguível de 100% sobre duzentas.
    sample_size: concluidas,
    punctuality_sample: comPrazo.length,

    unsettled_cod_cents: codPorAcertar,
  };
}

/**
 * Ordena o ranking. PURA.
 *
 * Quem não tem amostra fica no fim, sem julgamento: aparecer no topo por não ter
 * falhado nada seria tão errado como aparecer no fundo por não ter entregado.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
function rankDrivers(rows) {
  return [...(rows ?? [])].sort((a, b) => {
    const aTem = (a.sample_size ?? 0) > 0;
    const bTem = (b.sample_size ?? 0) > 0;
    if (aTem !== bTem) return aTem ? -1 : 1;
    if (!aTem) return 0;
    return (b.success_rate_pct ?? 0) - (a.success_rate_pct ?? 0)
      || (b.deliveries ?? 0) - (a.deliveries ?? 0);
  });
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Carrega as encomendas atribuídas, já com o resultado do SLA.
 *
 * A atribuição (`driver_id`) é o que o § 3.34 passou a escrever — sem ela, o
 * denominador destas taxas seria a operação inteira em vez do trabalho deste
 * motorista.
 *
 * @param {{ driver_id?: string, from?: string, to?: string, now?: string }} [opts]
 */
async function loadDriverOrders(opts = {}) {
  const sla = require('./sla.service');
  const agora = opts.now ?? new Date().toISOString();

  const params = [];
  const clauses = ['o.driver_id IS NOT NULL'];
  const cid = readCompanyId();
  if (cid) { params.push(cid); clauses.push(`o.company_id = $${params.length}`); }
  if (opts.driver_id) { params.push(opts.driver_id); clauses.push(`o.driver_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); clauses.push(`o.created_at >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   clauses.push(`o.created_at < $${params.length}`); }

  const { rows, coverage } = await queryBounded(`
    SELECT o.id, o.driver_id, o.current_status, o.created_at, o.updated_at,
           o.delivery_attempts, o.cod_amount, o.cod_status,
           o.pricing ->> 'zone_code' AS zone_code,
           o.pricing ->> 'service'   AS service,
           z.sla_hours_normal, z.sla_hours_express
      FROM orders o
      LEFT JOIN pricing_zones z ON z.code = o.pricing ->> 'zone_code'
     WHERE ${clauses.join(' AND ')}
  `, params, PERFORMANCE_CEILING);

  const orders = rows.map((row) => {
    const order = {
      id: row.id,
      current_status: row.current_status,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      delivered_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      service: row.service ?? 'normal',
    };
    const zone = row.zone_code
      ? { sla_hours_normal: row.sla_hours_normal, sla_hours_express: row.sla_hours_express }
      : null;

    return {
      ...row,
      delivery_attempts: Number(row.delivery_attempts) || 0,
      cod_amount: Number(row.cod_amount) || 0,
      sla_outcome: sla.evaluateSla(order, zone, agora).outcome,
    };
  });

  return { orders, coverage };
}

/** Indicadores de um motorista. */
async function getDriverPerformance(driverId, opts = {}) {
  const { orders: encomendas, coverage } = await loadDriverOrders({ ...opts, driver_id: driverId });
  return { driver_id: driverId, ...computePerformance(encomendas), coverage };
}

/** Ranking de todos os motoristas com trabalho atribuído. */
async function getDriversPerformance(opts = {}) {
  const { orders: encomendas, coverage } = await loadDriverOrders(opts);

  const porMotorista = new Map();
  for (const o of encomendas) {
    if (!porMotorista.has(o.driver_id)) porMotorista.set(o.driver_id, []);
    porMotorista.get(o.driver_id).push(o);
  }

  // Nomes dos motoristas, para o ranking não ser uma lista de identificadores.
  const params = [];
  const cid = readCompanyId();
  const filtro = cid ? ` AND company_id = $${params.push(cid)}` : '';
  const { rows: motoristas } = await pool.query(
    `SELECT id, name, current_status FROM drivers WHERE TRUE${filtro}`, params,
  );
  const nomes = new Map(motoristas.map((d) => [d.id, d]));

  const linhas = [...porMotorista.entries()].map(([driverId, lista]) => ({
    driver_id: driverId,
    driver_name: nomes.get(driverId)?.name ?? driverId,
    current_status: nomes.get(driverId)?.current_status ?? null,
    ...computePerformance(lista),
  }));

  // Motoristas sem nenhuma encomenda atribuída também aparecem, com amostra
  // zero: desaparecerem da lista faria parecer que não existem.
  for (const d of motoristas) {
    if (!porMotorista.has(d.id)) {
      linhas.push({
        driver_id: d.id, driver_name: d.name, current_status: d.current_status,
        ...computePerformance([]),
      });
    }
  }

  return { drivers: rankDrivers(linhas), coverage };
}

module.exports = {
  PERFORMANCE_CEILING,
  // Puros
  rate,
  computePerformance,
  rankDrivers,
  // Leitura
  loadDriverOrders,
  getDriverPerformance,
  getDriversPerformance,
};
