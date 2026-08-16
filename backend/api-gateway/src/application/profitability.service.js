/**
 * @file profitability.service.js
 * @description Rentabilidade por pedido, rota, cliente e viatura.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.40
 *
 * A REGRA QUE GOVERNA O MÓDULO: um custo que não se mede não se inventa. Um
 * relatório de margem que assume um custo por quilómetro produz números
 * confiantes que vão orientar decisões de preço; se o número for inventado, a
 * decisão fica pior do que a que se tomava a olho, porque agora tem a autoridade
 * de um relatório.
 *
 * Daí três categorias, sempre declaradas:
 *
 *   - **medido** — o combustível. Entre dois abastecimentos de depósito cheio
 *     sabe-se o custo e a distância pelo conta-quilómetros. É a única parcela de
 *     que o sistema já tem matéria-prima.
 *   - **configurado** — desgaste por km e motorista por rota, com default ZERO.
 *     A margem começa por mostrar só o que é real e ganha rigor à medida que a
 *     empresa preenche o que sabe. Um default plausível seria pior: ninguém o
 *     mudava e toda a gente acreditaria nele.
 *   - **desconhecido** — salários rateados, amortização, seguros, estrutura. O
 *     relatório diz que a margem é ANTES disso, e não finge.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');
const { queryBounded, mergeCoverage } = require('../infrastructure/bounded-query');

/**
 * Teto das rotas consideradas (§ 3.51).
 *
 * O custo de uma rota depende do combustível medido entre abastecimentos, o que
 * obriga a percorrer os abastecimentos de cada viatura — não é uma soma que a
 * base faça sozinha. O teto fica e passa a vir dito: uma margem calculada sobre
 * parte da operação e apresentada como o todo é a decisão de preço errada com
 * cara de relatório.
 */
const ROUTE_CEILING = 500;

/** Teto dos pedidos entregues considerados no relatório por pedido. */
const ORDER_CEILING = 500;

/** Desgaste e manutenção por km. Zero até a empresa o preencher. */
const UPKEEP_CENTS_PER_KM = Number(process.env.FLEET_UPKEEP_CENTS_PER_KM) || 0;

/** Custo de motorista por rota. Zero até a empresa o preencher. */
const DRIVER_COST_PER_ROUTE_CENTS = Number(process.env.FLEET_DRIVER_COST_PER_ROUTE_CENTS) || 0;

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Custo de combustível por km, medido entre abastecimentos. PURA.
 *
 * Só conta o intervalo entre dois **depósitos cheios**: num abastecimento
 * parcial não se sabe quanto restava no depósito, e dividir o custo pela
 * distância daria um número que parece medido e não é. O custo do primeiro
 * abastecimento também não entra — encheu um depósito que percorreu quilómetros
 * que ninguém registou.
 *
 * @param {Array<{ odometer_km: number, cost_cents: number, full_tank: boolean, fuel_date: string }>} fills
 * @returns {{ fuel_cents_per_km: number|null, source: 'measured'|'unknown', km_measured: number }}
 */
function fuelCostPerKm(fills) {
  // Ordenado por DATA e não por conta-quilómetros. Ordenar pelo conta-quilómetros
  // assumiria que ele é sempre a verdade e transformaria qualquer erro de
  // digitação num intervalo com ar de válido — que é exatamente o número
  // confiante e errado que este módulo existe para evitar. Por data, um
  // conta-quilómetros que anda para trás fica visível e o intervalo é descartado.
  // Comparado pelo VALOR temporal e não pelo texto: o driver devolve `DATE`
  // como `Date`, e `String(new Date(...))` dá "Sat Aug 01 2026 ..." — ordenar
  // essas cadeias é ordenar por dia da semana. Foi assim que 10 de agosto
  // apareceu antes de 1 de agosto e o intervalo saiu negativo.
  const instante = (f) => {
    const t = new Date(f?.fuel_date).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const cheios = [...(fills ?? [])]
    .filter((f) => f?.full_tank !== false)
    .sort((a, b) => instante(a) - instante(b) || Number(a.odometer_km) - Number(b.odometer_km));

  if (cheios.length < 2) {
    return { fuel_cents_per_km: null, source: 'unknown', km_measured: 0 };
  }

  let km = 0;
  let custo = 0;
  for (let i = 1; i < cheios.length; i += 1) {
    const percorridos = Number(cheios[i].odometer_km) - Number(cheios[i - 1].odometer_km);
    // Conta-quilómetros que anda para trás é erro de digitação; ignorar o
    // intervalo é melhor do que produzir um custo negativo que envenena a média.
    if (!Number.isFinite(percorridos) || percorridos <= 0) continue;
    km += percorridos;
    custo += Math.max(0, Number(cheios[i].cost_cents) || 0);
  }

  if (km === 0) return { fuel_cents_per_km: null, source: 'unknown', km_measured: 0 };
  return {
    fuel_cents_per_km: Math.round((custo / km) * 100) / 100,
    source: 'measured',
    km_measured: km,
  };
}

/**
 * Custo total de uma rota. PURA.
 *
 * @param {{ distance_km?: number, stops?: unknown[] }} route
 * @param {{ fuel_cents_per_km: number|null }} vehicleCost
 * @param {{ upkeep_cents_per_km?: number, driver_cost_per_route_cents?: number }} [model]
 * @returns {{ total_cents: number, fuel_cents: number, upkeep_cents: number, driver_cents: number, fuel_known: boolean }}
 */
function routeCost(route, vehicleCost, model = {}) {
  const km = Math.max(0, Number(route?.distance_km) || 0);
  const upkeepRate = Number(model.upkeep_cents_per_km ?? UPKEEP_CENTS_PER_KM) || 0;
  const driver = Number(model.driver_cost_per_route_cents ?? DRIVER_COST_PER_ROUTE_CENTS) || 0;

  const fuelRate = vehicleCost?.fuel_cents_per_km;
  const fuel_known = Number.isFinite(Number(fuelRate)) && Number(fuelRate) > 0;

  // Combustível desconhecido conta ZERO e a bandeira diz que faltou. Estimá-lo
  // daria uma margem que parece completa e não é.
  const fuel_cents   = fuel_known ? Math.round(km * Number(fuelRate)) : 0;
  const upkeep_cents = Math.round(km * upkeepRate);
  const driver_cents = driver;

  return {
    total_cents: fuel_cents + upkeep_cents + driver_cents,
    fuel_cents,
    upkeep_cents,
    driver_cents,
    fuel_known,
  };
}

/**
 * Reparte o custo da rota pelas paradas. PURA.
 *
 * Repartição IGUAL. Ponderar por distância parece mais justo e não é
 * sustentável: guarda-se a distância TOTAL da rota, não a de cada perna, e
 * inventar a repartição por linha reta daria um número com aparência de precisão
 * e sem base.
 *
 * O último cêntimo vai para a última parada, para a soma das partes bater
 * exatamente com o total — sem isso, um relatório por cliente e outro por rota
 * dariam totais diferentes e ninguém saberia qual acreditar.
 *
 * @param {number} totalCents
 * @param {number} stopCount
 * @returns {number[]}
 */
function splitCostPerStop(totalCents, stopCount) {
  const n = Math.max(0, Math.floor(Number(stopCount) || 0));
  if (n === 0) return [];

  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const base = Math.floor(total / n);
  const partes = new Array(n).fill(base);
  partes[n - 1] += total - base * n;
  return partes;
}

/**
 * Margem a partir de receita e custo. PURA.
 *
 * `margin_pct` é `null` quando não há receita — dividir por zero daria
 * `Infinity`, que num ecrã aparece como um número absurdo.
 *
 * @param {number} revenueCents
 * @param {number} costCents
 * @param {boolean} [costKnown]
 * @returns {object}
 */
function margin(revenueCents, costCents, costKnown = true) {
  const receita = Math.max(0, Math.round(Number(revenueCents) || 0));
  const custo   = Math.max(0, Math.round(Number(costCents) || 0));
  const lucro   = receita - custo;

  // Nenhum custo medido não dá uma margem de 100% — não dá margem nenhuma. Com
  // o custo parcialmente conhecido a margem ainda informa (está sobreavaliada, e
  // o `cost_known` diz porquê); com custo zero e desconhecido, é aritmética
  // sobre o vazio, e um "100%" num ecrã de gestão sobrevive a qualquer asterisco.
  const semCustoNenhum = custo === 0 && !costKnown;

  return {
    revenue_cents: receita,
    cost_cents:    custo,
    profit_cents:  lucro,
    margin_pct:    receita === 0 || semCustoNenhum
      ? null
      : Math.round((lucro / receita) * 1000) / 10,
    // Sem isto, uma margem de 40% com o combustível por medir seria
    // indistinguível de uma margem de 40% real.
    cost_known:    Boolean(costKnown),
  };
}

/**
 * Descreve o que entrou no cálculo e o que ficou de fora. PURA.
 *
 * Uma margem de 40% com o combustível desconhecido não é uma margem de 40% — é
 * uma margem por cima, e quem lê tem de o ver sem ter de perguntar.
 *
 * @param {{ measured: number, total: number }} vehicles
 * @param {object} model
 * @returns {object}
 */
function costCoverage(vehicles, model = {}) {
  const upkeep = Number(model.upkeep_cents_per_km ?? UPKEEP_CENTS_PER_KM) || 0;
  const driver = Number(model.driver_cost_per_route_cents ?? DRIVER_COST_PER_ROUTE_CENTS) || 0;

  const emFalta = [];
  if (vehicles.measured < vehicles.total) emFalta.push('combustível de algumas viaturas');
  if (upkeep === 0) emFalta.push('manutenção e desgaste');
  if (driver === 0) emFalta.push('custo de motorista');
  emFalta.push('salários rateados, amortização, seguros e estrutura');

  return {
    fuel: {
      source: 'measured',
      vehicles_with_data: vehicles.measured,
      vehicles_total: vehicles.total,
    },
    upkeep_cents_per_km: { value: upkeep, source: upkeep > 0 ? 'configured' : 'not_configured' },
    driver_cost_per_route_cents: { value: driver, source: driver > 0 ? 'configured' : 'not_configured' },
    excluded: emFalta,
    // A frase que o ecrã mostra por cima da tabela.
    caveat: `Margem ANTES de: ${emFalta.join(', ')}.`,
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
 * Custo por km de cada viatura, medido dos abastecimentos.
 * @returns {Promise<Map<string, object>>} Indexado pela MATRÍCULA.
 */
async function getVehicleCosts() {
  const params = [];
  const filtro = companyFilter(params, 'f');
  const { rows } = await pool.query(`
    SELECT v.plate, f.vehicle_id, f.odometer_km, f.cost_cents, f.full_tank, f.fuel_date
      FROM fleet_fuel_entries f
      JOIN fleet_vehicles v ON v.id = f.vehicle_id
     WHERE TRUE${filtro}
     ORDER BY f.vehicle_id, f.odometer_km
  `, params);

  const porMatricula = new Map();
  for (const row of rows) {
    if (!porMatricula.has(row.plate)) porMatricula.set(row.plate, []);
    porMatricula.get(row.plate).push(row);
  }

  const custos = new Map();
  for (const [plate, fills] of porMatricula) {
    custos.set(plate, { plate, ...fuelCostPerKm(fills) });
  }
  return custos;
}

/**
 * Rentabilidade por rota, e o custo por parada que dela deriva.
 *
 * @param {{ from?: string, to?: string }} [opts]
 */
async function getRouteProfitability(opts = {}) {
  const custosPorMatricula = await getVehicleCosts();

  const params = [];
  const clauses = [];
  const cid = readCompanyId();
  if (cid) { params.push(cid); clauses.push(`r.company_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); clauses.push(`r.created_at >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   clauses.push(`r.created_at < $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows, coverage } = await queryBounded(`
    SELECT r.id, r.driver_id, r.distance_km, r.stops, d.name AS driver_name, d.vehicle
      FROM routes r
      LEFT JOIN drivers d ON d.id = r.driver_id
      ${where}
     ORDER BY r.created_at DESC
  `, params, ROUTE_CEILING);

  const rotas = [];
  for (const row of rows) {
    const matricula = row.vehicle?.plate;
    const custoViatura = custosPorMatricula.get(matricula) ?? { fuel_cents_per_km: null, source: 'unknown' };
    const stops = Array.isArray(row.stops) ? row.stops : [];
    const custo = routeCost({ distance_km: row.distance_km, stops }, custoViatura);

    // Receita da rota: a soma do valor das encomendas que ela levou.
    const ids = stops.map((s) => s?.order_id).filter(Boolean);
    let receita = 0;
    if (ids.length > 0) {
      const p = [ids];
      const filtro = companyFilter(p);
      const { rows: enc } = await pool.query(
        `SELECT COALESCE(SUM(value), 0) AS receita FROM orders WHERE id = ANY($1::text[])${filtro}`,
        p,
      );
      receita = Number(enc[0].receita);
    }

    rotas.push({
      route_id: row.id,
      driver_id: row.driver_id,
      driver_name: row.driver_name,
      plate: matricula ?? null,
      distance_km: Number(row.distance_km) || 0,
      stops: stops.length,
      cost_breakdown: custo,
      ...margin(receita, custo.total_cents, custo.fuel_known),
    });
  }

  return {
    routes: rotas,
    cost_coverage: coverageFor(custosPorMatricula),
    // Quantas rotas entraram na conta (§ 3.51). Distinto de `cost_coverage`,
    // que diz que PARCELAS de custo entraram na margem (§ 3.40).
    coverage,
  };
}

/**
 * Rentabilidade por pedido: a parte do custo da sua rota mais a sua receita.
 *
 * @param {{ from?: string, to?: string }} [opts]
 */
async function getOrderProfitability(opts = {}) {
  const { routes, cost_coverage, coverage: coberturaRotas } = await getRouteProfitability(opts);

  // Custo por parada, derivado da repartição igual (ver `splitCostPerStop`).
  const custoPorPedido = new Map();
  const rotaDoPedido = new Map();
  for (const rota of routes) {
    const p = [rota.route_id];
    const { rows } = await pool.query('SELECT stops FROM routes WHERE id = $1', p);
    const stops = Array.isArray(rows[0]?.stops) ? rows[0].stops : [];
    const partes = splitCostPerStop(rota.cost_breakdown.total_cents, stops.length);
    stops.forEach((s, i) => {
      if (!s?.order_id) return;
      custoPorPedido.set(s.order_id, partes[i]);
      rotaDoPedido.set(s.order_id, rota.route_id);
    });
  }

  const params = [];
  const clauses = [];
  const cid = readCompanyId();
  if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
  if (opts.from) { params.push(opts.from); clauses.push(`created_at >= $${params.length}`); }
  if (opts.to)   { params.push(opts.to);   clauses.push(`created_at < $${params.length}`); }
  clauses.push(`current_status = 'delivered'`);

  // Teto próprio, e dito: a lista de pedidos entregues cresce mais depressa do
  // que a de rotas, e uma delas trunca antes da outra.
  const { rows, coverage: coberturaPedidos } = await queryBounded(`
    SELECT id, tracking_code, client_id, client_ref_id, value
      FROM orders
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC
  `, params, ORDER_CEILING);

  const orders = rows.map((row) => {
    const custo = custoPorPedido.get(row.id);
    // Sem rota, o transporte não foi acompanhado pelo sistema. Dizê-lo é a
    // resposta certa; apresentar margem de 100% seria mentir.
    const conhecido = custo !== undefined;
    return {
      order_id: row.id,
      tracking_code: row.tracking_code,
      client: row.client_id,
      client_ref_id: row.client_ref_id,
      route_id: rotaDoPedido.get(row.id) ?? null,
      ...margin(row.value, custo ?? 0, conhecido),
    };
  });

  // As duas consultas truncam de forma independente — a lista de pedidos
  // entregues cresce mais depressa do que a de rotas.
  return { orders, cost_coverage, coverage: mergeCoverage(coberturaRotas, coberturaPedidos) };
}

/** Agrega a rentabilidade dos pedidos por cliente. */
async function getClientProfitability(opts = {}) {
  const { orders, cost_coverage, coverage } = await getOrderProfitability(opts);

  const porCliente = new Map();
  for (const o of orders) {
    const chave = o.client_ref_id ?? o.client;
    const atual = porCliente.get(chave) ?? {
      client: o.client, client_ref_id: o.client_ref_id,
      orders: 0, revenue_cents: 0, cost_cents: 0, orders_without_cost: 0,
    };
    atual.orders += 1;
    atual.revenue_cents += o.revenue_cents;
    atual.cost_cents += o.cost_cents;
    if (!o.cost_known) atual.orders_without_cost += 1;
    porCliente.set(chave, atual);
  }

  const clients = [...porCliente.values()]
    .map((c) => ({
      ...c,
      ...margin(c.revenue_cents, c.cost_cents, c.orders_without_cost === 0),
    }))
    .sort((a, b) => b.profit_cents - a.profit_cents);

  return { clients, cost_coverage, coverage };
}

/** Agrega a rentabilidade das rotas por viatura. */
async function getVehicleProfitability(opts = {}) {
  const { routes, cost_coverage, coverage: coberturaRotas } = await getRouteProfitability(opts);

  const porMatricula = new Map();
  for (const r of routes) {
    const chave = r.plate ?? 'sem viatura';
    const atual = porMatricula.get(chave) ?? {
      plate: chave, routes: 0, distance_km: 0, revenue_cents: 0, cost_cents: 0, fuel_known: true,
    };
    atual.routes += 1;
    atual.distance_km += r.distance_km;
    atual.revenue_cents += r.revenue_cents;
    atual.cost_cents += r.cost_cents;
    if (!r.cost_breakdown.fuel_known) atual.fuel_known = false;
    porMatricula.set(chave, atual);
  }

  const vehicles = [...porMatricula.values()]
    .map((v) => ({ ...v, ...margin(v.revenue_cents, v.cost_cents, v.fuel_known) }))
    .sort((a, b) => b.profit_cents - a.profit_cents);

  return { vehicles, cost_coverage, coverage: coberturaRotas };
}

/** @param {Map<string, object>} custos */
function coverageFor(custos) {
  const total = custos.size;
  const medidas = [...custos.values()].filter((c) => c.source === 'measured').length;
  return costCoverage({ measured: medidas, total });
}

module.exports = {
  // Puros
  fuelCostPerKm,
  routeCost,
  splitCostPerStop,
  margin,
  costCoverage,
  // Leitura
  getVehicleCosts,
  getRouteProfitability,
  getOrderProfitability,
  getClientProfitability,
  getVehicleProfitability,
  // Constantes
  ROUTE_CEILING,
  ORDER_CEILING,
  UPKEEP_CENTS_PER_KM,
  DRIVER_COST_PER_ROUTE_CENTS,
};
