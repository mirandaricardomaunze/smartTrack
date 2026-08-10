/**
 * @file exports.service.js
 * @description Exportação dos relatórios para Excel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * CADA EXPORTAÇÃO REUTILIZA O CASO DE USO DO RELATÓRIO em vez de repetir a
 * consulta. Dois caminhos para o mesmo número acabariam a divergir, e o ficheiro
 * exportado é justamente o que sai da empresa e vai ser discutido numa reunião —
 * é o pior sítio para descobrir que não bate certo com o ecrã.
 *
 * VALORES EM METICAIS, não em centavos: o sistema guarda centavos porque é a
 * única forma de somar dinheiro sem erro, mas a folha recebe o que a pessoa vai
 * somar. Obrigar quem abre a dividir por cem seria devolver, por outra via, o
 * problema do CSV que isto veio resolver.
 */
'use strict';

const { buildXlsx } = require('../infrastructure/xlsx');

/** Centavos → meticais, com duas casas. PURA. */
function mzn(cents) {
  return Math.round(Number(cents ?? 0)) / 100;
}

/**
 * Percentagem para a folha. PURA.
 *
 * `null` fica célula vazia e não zero: em todos os relatórios desta fase, `null`
 * significa "sem amostra", e escrever 0 seria afirmar um resultado que ninguém
 * mediu.
 */
function pct(valor) {
  return valor === null || valor === undefined ? null : Number(valor);
}

// ─── Construtores de folha (puros) ───────────────────────────────────────────

/**
 * Rentabilidade: uma folha por dimensão, mais a cobertura de custos.
 *
 * A cobertura vai NO FICHEIRO e não só no ecrã: a folha vai circular por email
 * sem o contexto do painel, e uma margem sem a ressalva do que ficou de fora é
 * exatamente o número confiante e errado que o § 3.40 existe para evitar.
 *
 * @param {object} dados
 * @returns {Array<object>}
 */
function profitabilitySheets(dados) {
  const { clients = [], routes = [], vehicles = [], cost_coverage } = dados;

  return [
    {
      name: 'Clientes',
      columns: [
        { header: 'Cliente', width: 34 },
        { header: 'Entregas', width: 12 },
        { header: 'Receita (MZN)', width: 16 },
        { header: 'Custo (MZN)', width: 16 },
        { header: 'Lucro (MZN)', width: 16 },
        { header: 'Margem (%)', width: 13 },
        { header: 'Custo completo', width: 16 },
      ],
      rows: clients.map((c) => [
        c.client, c.orders, mzn(c.revenue_cents), mzn(c.cost_cents),
        mzn(c.profit_cents), pct(c.margin_pct), c.cost_known ? 'sim' : 'não',
      ]),
    },
    {
      name: 'Rotas',
      columns: [
        { header: 'Rota', width: 26 },
        { header: 'Motorista', width: 26 },
        { header: 'Matrícula', width: 14 },
        { header: 'Km', width: 10 },
        { header: 'Receita (MZN)', width: 16 },
        { header: 'Custo (MZN)', width: 16 },
        { header: 'Margem (%)', width: 13 },
      ],
      rows: routes.map((r) => [
        r.route_id, r.driver_name ?? null, r.plate, Number(r.distance_km ?? 0),
        mzn(r.revenue_cents), mzn(r.cost_cents), pct(r.margin_pct),
      ]),
    },
    {
      name: 'Viaturas',
      columns: [
        { header: 'Matrícula', width: 16 },
        { header: 'Rotas', width: 10 },
        { header: 'Km', width: 12 },
        { header: 'Receita (MZN)', width: 16 },
        { header: 'Custo (MZN)', width: 16 },
        { header: 'Margem (%)', width: 13 },
      ],
      rows: vehicles.map((v) => [
        v.plate, v.routes, Number(v.distance_km ?? 0),
        mzn(v.revenue_cents), mzn(v.cost_cents), pct(v.margin_pct),
      ]),
    },
    {
      name: 'Cobertura de custos',
      columns: [{ header: 'Item', width: 40 }, { header: 'Estado', width: 60 }],
      rows: cost_coverage ? [
        ['Ressalva', cost_coverage.caveat],
        ['Viaturas com combustível medido',
          `${cost_coverage.fuel.vehicles_with_data} de ${cost_coverage.fuel.vehicles_total}`],
        ['Manutenção por km', cost_coverage.upkeep_cents_per_km.source === 'configured'
          ? `${mzn(cost_coverage.upkeep_cents_per_km.value)} MZN/km` : 'não configurada'],
        ['Custo de motorista por rota', cost_coverage.driver_cost_per_route_cents.source === 'configured'
          ? `${mzn(cost_coverage.driver_cost_per_route_cents.value)} MZN` : 'não configurado'],
        ...cost_coverage.excluded.map((e) => ['Fora da margem', e]),
      ] : [],
    },
  ];
}

/** Contas a receber: carteira por cliente com os escalões de antiguidade. */
function receivablesSheets(dados) {
  const { clients = [], totals } = dados;

  return [
    {
      name: 'Contas a receber',
      columns: [
        { header: 'Cliente', width: 34 },
        { header: 'Faturas em aberto', width: 18 },
        { header: 'Por vencer', width: 15 },
        { header: '1-30 dias', width: 13 },
        { header: '31-60 dias', width: 13 },
        { header: '61-90 dias', width: 13 },
        { header: '+90 dias', width: 13 },
        { header: 'Sem prazo', width: 13 },
        { header: 'Saldo (MZN)', width: 16 },
        { header: 'Mais vencida (dias)', width: 20 },
      ],
      rows: clients.map((c) => [
        c.client_name, c.open_invoices,
        mzn(c.buckets.corrente), mzn(c.buckets.d1_30), mzn(c.buckets.d31_60),
        mzn(c.buckets.d61_90), mzn(c.buckets.d90_mais), mzn(c.buckets.sem_prazo),
        mzn(c.balance_cents), c.oldest_days_overdue,
      ]),
    },
    {
      name: 'Total',
      columns: [{ header: 'Escalão', width: 24 }, { header: 'Valor (MZN)', width: 16 }],
      rows: totals ? [
        ['Por vencer', mzn(totals.buckets.corrente)],
        ['1-30 dias', mzn(totals.buckets.d1_30)],
        ['31-60 dias', mzn(totals.buckets.d31_60)],
        ['61-90 dias', mzn(totals.buckets.d61_90)],
        ['+90 dias', mzn(totals.buckets.d90_mais)],
        ['Sem prazo acordado', mzn(totals.buckets.sem_prazo)],
        ['TOTAL', mzn(totals.balance_cents)],
      ] : [],
    },
  ];
}

/** Desempenho dos motoristas. Sem amostra fica célula vazia, não zero. */
function driverPerformanceSheets(dados) {
  const { drivers = [] } = dados;

  return [{
    name: 'Desempenho',
    columns: [
      { header: 'Motorista', width: 30 },
      { header: 'Entregas', width: 12 },
      { header: 'Insucessos', width: 13 },
      { header: 'Devolvidas', width: 13 },
      { header: 'Sucesso (%)', width: 14 },
      { header: 'À primeira (%)', width: 16 },
      { header: 'Pontualidade (%)', width: 18 },
      { header: 'Amostra', width: 11 },
      { header: 'COD por acertar (MZN)', width: 22 },
    ],
    rows: drivers.map((d) => [
      d.driver_name, d.deliveries, d.failures, d.returns,
      pct(d.success_rate_pct), pct(d.first_attempt_rate_pct), pct(d.punctuality_pct),
      d.sample_size, mzn(d.unsettled_cod_cents),
    ]),
  }];
}

/** Ocorrências abertas e o seu prazo. */
function incidentsSheets(lista) {
  return [{
    name: 'Ocorrências',
    columns: [
      { header: 'Código', width: 18 },
      { header: 'Espécie', width: 20 },
      { header: 'Prioridade', width: 13 },
      { header: 'Estado', width: 13 },
      { header: 'Título', width: 40 },
      { header: 'Rastreio', width: 18 },
      { header: 'Aberta em', width: 22 },
      { header: 'Prazo', width: 22 },
      { header: 'Fora do prazo', width: 15 },
    ],
    rows: (lista ?? []).map((o) => [
      o.code, o.kind, o.priority, o.status, o.title, o.tracking_code,
      o.opened_at, o.due_at, o.overdue ? 'sim' : 'não',
    ]),
  }];
}

// ─── Casos de uso ────────────────────────────────────────────────────────────

/**
 * Gera o ficheiro pedido.
 *
 * @param {string} report
 * @param {{ from?: string, to?: string }} [opts]
 * @returns {Promise<{ filename: string, buffer: Buffer }>}
 */
async function exportReport(report, opts = {}) {
  const hoje = new Date().toISOString().slice(0, 10);

  switch (report) {
    case 'rentabilidade': {
      const profitability = require('./profitability.service');
      const [clientes, rotas, viaturas] = await Promise.all([
        profitability.getClientProfitability(opts),
        profitability.getRouteProfitability(opts),
        profitability.getVehicleProfitability(opts),
      ]);
      return {
        filename: `rentabilidade-${hoje}.xlsx`,
        buffer: buildXlsx(profitabilitySheets({
          clients: clientes.clients,
          routes: rotas.routes,
          vehicles: viaturas.vehicles,
          cost_coverage: clientes.cost_coverage,
        })),
      };
    }

    case 'contas-a-receber': {
      const receivables = require('./receivables.service');
      return {
        filename: `contas-a-receber-${hoje}.xlsx`,
        buffer: buildXlsx(receivablesSheets(await receivables.getReceivables())),
      };
    }

    case 'desempenho': {
      const perf = require('./driver-performance.service');
      return {
        filename: `desempenho-motoristas-${hoje}.xlsx`,
        buffer: buildXlsx(driverPerformanceSheets(await perf.getDriversPerformance(opts))),
      };
    }

    case 'ocorrencias': {
      const incidents = require('./incidents.service');
      return {
        filename: `ocorrencias-${hoje}.xlsx`,
        buffer: buildXlsx(incidentsSheets(await incidents.listIncidents())),
      };
    }

    default:
      throw Object.assign(new Error(`Relatório desconhecido: ${report}`), { statusCode: 400 });
  }
}

module.exports = {
  exportReport,
  // Puros — exportados para teste
  mzn,
  pct,
  profitabilitySheets,
  receivablesSheets,
  driverPerformanceSheets,
  incidentsSheets,
};
