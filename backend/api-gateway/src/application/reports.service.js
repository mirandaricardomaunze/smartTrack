/**
 * @file reports.service.js
 * @description Relatórios e analytics operacionais.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.8 (Relatórios) / § 3.4 (Métricas)
 *
 * As funções `compute*` são PURAS (recebem pedidos/motoristas e devolvem números);
 * os use cases carregam os dados via repositórios. Valores em centavos (MZN).
 */
'use strict';

const { OrderRepository, DriverRepository } = require('../infrastructure/pg.repository');

/** Ordem canónica de estados para a distribuição. */
const STATUS_ORDER = [
  'created', 'collected', 'in_transit', 'at_warehouse',
  'awaiting_destination', 'out_for_delivery', 'delivered', 'failed', 'cancelled',
];

const DELIVERED = 'delivered';
const FAILED = 'failed';
const CANCELLED = 'cancelled';
const CASH = 'CASH';

/** @param {object} order @returns {string|null} timestamp ISO do evento `delivered` */
function deliveredTimestamp(order) {
  const evt = (order.history ?? []).find((h) => h.status === DELIVERED);
  return evt?.timestamp ?? null;
}

/** @param {string} iso @returns {string} 'YYYY-MM-DD' */
function dayKey(iso) {
  return String(iso).slice(0, 10);
}

/** Arredonda para 1 casa. */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * KPIs agregados sobre um conjunto de pedidos.
 * @param {object[]} orders
 * @returns {object}
 */
function computeOverview(orders) {
  const total = orders.length;
  let delivered = 0, failed = 0, cancelled = 0, active = 0;
  let totalValue = 0, codCash = 0, codMobile = 0;
  let deliverySum = 0, deliveredWithMetric = 0, within48h = 0;

  for (const o of orders) {
    totalValue += Number(o.value ?? 0);
    if (o.cod) {
      const amt = Number(o.cod.amount ?? 0);
      if (o.cod.method === CASH) codCash += amt; else codMobile += amt;
    }
    if (o.current_status === DELIVERED) {
      delivered += 1;
      const dts = deliveredTimestamp(o);
      if (dts && o.created_at) {
        const hours = (Date.parse(dts) - Date.parse(o.created_at)) / 3_600_000;
        if (Number.isFinite(hours) && hours >= 0) {
          deliverySum += hours;
          deliveredWithMetric += 1;
          if (hours <= 48) within48h += 1;
        }
      }
    } else if (o.current_status === FAILED) {
      failed += 1;
    } else if (o.current_status === CANCELLED) {
      cancelled += 1;
    } else {
      active += 1;
    }
  }

  const attempts = delivered + failed;
  return {
    total,
    delivered,
    active,
    failed,
    cancelled,
    success_rate_pct: attempts > 0 ? round1((delivered / attempts) * 100) : 0,
    avg_delivery_hours: deliveredWithMetric > 0 ? round1(deliverySum / deliveredWithMetric) : 0,
    within_48h_pct: deliveredWithMetric > 0 ? round1((within48h / deliveredWithMetric) * 100) : 0,
    total_value_cents: totalValue,
    cod_collected_cash_cents: codCash,
    cod_collected_mobile_cents: codMobile,
  };
}

/**
 * Série temporal (últimos `days` dias): pedidos criados e entregues por dia.
 * @param {object[]} orders
 * @param {number} days
 * @returns {Array<{ date: string; created: number; delivered: number }>}
 */
function computeVolume(orders, days = 14) {
  const n = Math.max(1, Math.min(days, 90));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const series = [];
  const index = new Map();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const row = { date: key, created: 0, delivered: 0 };
    series.push(row);
    index.set(key, row);
  }

  for (const o of orders) {
    if (o.created_at) {
      const row = index.get(dayKey(o.created_at));
      if (row) row.created += 1;
    }
    const dts = deliveredTimestamp(o);
    if (dts) {
      const row = index.get(dayKey(dts));
      if (row) row.delivered += 1;
    }
  }
  return series;
}

/**
 * Desempenho por motorista.
 * @param {object[]} orders
 * @param {object[]} drivers
 * @returns {Array<object>}
 */
function computeByDriver(orders, drivers) {
  const nameById = new Map(drivers.map((d) => [d.id, d.name]));
  const map = new Map();

  for (const o of orders) {
    if (!o.driver_id) continue;
    const e = map.get(o.driver_id) ?? { driver_id: o.driver_id, name: nameById.get(o.driver_id) ?? o.driver_id, delivered: 0, failed: 0, cod_cash_cents: 0 };
    if (o.current_status === DELIVERED) e.delivered += 1;
    if (o.current_status === FAILED) e.failed += 1;
    if (o.cod && o.cod.method === CASH) e.cod_cash_cents += Number(o.cod.amount ?? 0);
    map.set(o.driver_id, e);
  }

  return [...map.values()]
    .map((e) => {
      const attempts = e.delivered + e.failed;
      return { ...e, success_rate_pct: attempts > 0 ? round1((e.delivered / attempts) * 100) : 0 };
    })
    .sort((a, b) => b.delivered - a.delivered);
}

/**
 * Distribuição por estado atual.
 * @param {object[]} orders
 * @returns {Array<{ status: string; count: number }>}
 */
function computeStatusDistribution(orders) {
  const counts = new Map();
  for (const o of orders) counts.set(o.current_status, (counts.get(o.current_status) ?? 0) + 1);
  return STATUS_ORDER
    .filter((s) => counts.has(s))
    .map((s) => ({ status: s, count: counts.get(s) }));
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/**
 * Resumo completo para o painel de relatórios.
 * @param {{ days?: number }} [opts]
 * @returns {Promise<{ overview: object; volume: object[]; byDriver: object[]; status: object[]; generated_at: string }>}
 */
async function getSummary(opts = {}) {
  const days = Number(opts.days) || 14;
  // A janela é a que o relatório já anuncia ("últimos N dias"). Antes carregava
  // o histórico inteiro para memória e depois apresentava-o sob esse rótulo —
  // era ao mesmo tempo um problema de escala e um número que não correspondia
  // ao que a página dizia.
  const from = new Date(Date.now() - days * 86_400_000).toISOString();

  const [orders, drivers] = await Promise.all([
    OrderRepository.listSince(from),
    DriverRepository.findAll(),
  ]);

  return {
    period: { from, to: new Date().toISOString(), days },
    overview: computeOverview(orders),
    volume:   computeVolume(orders, days),
    byDriver: computeByDriver(orders, drivers),
    status:   computeStatusDistribution(orders),
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  getSummary,
  // Puras — exportadas para teste
  computeOverview,
  computeVolume,
  computeByDriver,
  computeStatusDistribution,
  deliveredTimestamp,
};
