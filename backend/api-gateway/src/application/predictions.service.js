/**
 * @file predictions.service.js
 * @description Previsão do tempo de entrega, medida do histórico.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.46
 *
 * PREVÊ-SE DO QUE ACONTECEU, E SÓ DISSO. A duração de cada entrega concluída já
 * está na base; isto lê esses factos. Não há fatores inventados nem pesos
 * afinados a olho — um modelo assim daria números que ninguém consegue explicar
 * a um cliente que perguntou "porquê?".
 *
 * SEM AMOSTRA NÃO HÁ PREVISÃO. Abaixo de MIN_SAMPLE a resposta é "não sei",
 * porque um sistema que responde "24 horas" a partir de três entregas está a
 * inventar com o aspeto de quem mediu.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');

/**
 * Entregas concluídas necessárias para haver previsão.
 *
 * Vinte é o ponto a partir do qual o P90 deixa de ser decidido por uma só
 * encomenda: com dez, o nono valor É o P90, e um único dia mau passa a ser a
 * previsão que se dá a toda a gente.
 */
const MIN_SAMPLE = 20;

/** Uma entrega absurdamente longa não é apagada — é excluída de ser medida. */
const MAX_PLAUSIBLE_HOURS = 24 * 90;

// ─── Decisões puras ──────────────────────────────────────────────────────────

/**
 * Duração de uma entrega, em horas. PURA.
 *
 * DO REGISTO À ENTREGA, porque é essa a espera que o cliente vive. Medir a
 * partir da recolha daria um número melhor e responderia a outra pergunta.
 *
 * @returns {number|null} null quando não é medível
 */
function durationHours(order) {
  const inicio = Date.parse(order?.created_at ?? '');
  const fim = Date.parse(order?.delivered_at ?? '');
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return null;

  const horas = (fim - inicio) / 3_600_000;
  // Uma duração negativa é um relógio trocado, não uma entrega instantânea.
  if (horas < 0 || horas > MAX_PLAUSIBLE_HOURS) return null;
  return horas;
}

/**
 * Percentil por interpolação linear sobre valores JÁ ORDENADOS. PURA.
 *
 * Percentil e não média: uma encomenda esquecida três semanas num armazém
 * desloca a média o suficiente para a tornar inútil, e não desloca a mediana.
 *
 * @param {number[]} ordenados
 * @param {number} p entre 0 e 1
 */
function percentile(ordenados, p) {
  if (!ordenados.length) return null;
  if (ordenados.length === 1) return ordenados[0];

  const pos = (ordenados.length - 1) * p;
  const baixo = Math.floor(pos);
  const alto = Math.ceil(pos);
  if (baixo === alto) return ordenados[baixo];

  return ordenados[baixo] + (ordenados[alto] - ordenados[baixo]) * (pos - baixo);
}

/**
 * Chave do segmento: destino + nível de serviço. PURA.
 *
 * NÃO ENTRA O MOTORISTA: uma previsão que muda com o nome de quem entrega
 * transforma-se numa avaliação da pessoa, feita com uma amostra que nunca foi
 * recolhida para isso (§ 3.43).
 */
function segmentKey(zone, service) {
  return `${zone ?? 'sem-zona'}::${service ?? 'normal'}`;
}

/**
 * Resume uma lista de durações. PURA.
 *
 * @param {number[]} durations
 * @returns {{ sample_size: number, p50_hours: number|null, p90_hours: number|null, enough: boolean }}
 */
function summarize(durations) {
  const validas = (durations ?? []).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  const suficiente = validas.length >= MIN_SAMPLE;

  return {
    sample_size: validas.length,
    // Os percentis ficam a `null` sem amostra bastante, em vez de virem
    // calculados e "a usar por sua conta e risco": um número no campo é usado.
    p50_hours: suficiente ? round1(percentile(validas, 0.5)) : null,
    p90_hours: suficiente ? round1(percentile(validas, 0.9)) : null,
    enough: suficiente,
  };
}

function round1(v) {
  return v === null ? null : Math.round(v * 10) / 10;
}

/**
 * Previsão para um destino e nível de serviço. PURA.
 *
 * A ESCADA DE RECURSO PÁRA ANTES DE MENTIR: segmento exato → mesma zona,
 * qualquer nível → sem previsão. Nunca a média da empresa — aplicar a Nampula o
 * que se mediu em Maputo é uma afirmação confiante sobre uma rota que ninguém
 * percorreu.
 *
 * @param {Map<string, number[]>} porSegmento
 * @param {Map<string, number[]>} porZona
 */
function predict(porSegmento, porZona, zone, service) {
  const exato = summarize(porSegmento.get(segmentKey(zone, service)) ?? []);
  if (exato.enough) {
    return { ...exato, basis: 'segment', zone: zone ?? null, service_level: service ?? 'normal' };
  }

  const daZona = summarize(porZona.get(zone ?? 'sem-zona') ?? []);
  if (daZona.enough) {
    // Assinalado como recurso: quem lê tem de saber que o número mistura níveis
    // de serviço, e que um expresso pode ser mais rápido do que isto sugere.
    return { ...daZona, basis: 'zone', zone: zone ?? null, service_level: null };
  }

  return {
    sample_size: exato.sample_size,
    p50_hours: null,
    p90_hours: null,
    enough: false,
    basis: null,
    zone: zone ?? null,
    service_level: service ?? 'normal',
    reason: `Sem base para prever: ${exato.sample_size} de ${MIN_SAMPLE} entregas concluídas neste destino.`,
  };
}

/**
 * Compara a previsão com o prazo prometido (§ 3.42). PURA.
 *
 * É A SAÍDA MAIS VALIOSA DESTE MÓDULO: informa uma decisão de gestão em vez de
 * informar um cliente. Prometer 24 horas e entregar em 38 em nove de cada dez
 * casos é uma promessa que a operação não cumpre, e ninguém sabia.
 *
 * @param {{ p90_hours: number|null }} prediction
 * @param {number|null} promisedHours
 */
function compareToPromise(prediction, promisedHours) {
  if (!prediction?.p90_hours || !promisedHours) {
    // Sem prazo acordado não há promessa para comparar — e uma zona sem prazo
    // não incumpre nada (§ 3.42).
    return { comparable: false, keeps_promise: null, gap_hours: null };
  }

  const excesso = round1(prediction.p90_hours - promisedHours);
  return {
    comparable: true,
    keeps_promise: excesso <= 0,
    gap_hours: excesso,
    promised_hours: promisedHours,
  };
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Entregas concluídas com duração medível.
 *
 * A data de entrega vem do POD e não de `updated_at`: qualquer alteração
 * posterior ao registo — uma correção de morada, um acerto de COD — mexeria em
 * `updated_at` e encompridaria a entrega sem que nada tivesse acontecido.
 */
async function loadDeliveries({ days = 180 } = {}) {
  const params = [days];
  let where = ` WHERE current_status = 'delivered'
                  AND created_at >= NOW() - ($1 || ' days')::interval`;

  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND company_id = $${params.length}`; }

  const { rows } = await pool.query(`
    SELECT created_at,
           COALESCE(pod->>'captured_at', updated_at::text) AS delivered_at,
           destination->>'city'                            AS city,
           COALESCE(pricing->>'zone_name', pricing->>'zone_id') AS zone,
           COALESCE(pricing->>'service_level', 'normal')   AS service_level
      FROM orders${where}
  `, params);

  return rows;
}

/** Zona efetiva de uma encomenda: a da tarifação, ou a cidade do destino. */
function zoneOf(row) {
  return row.zone || row.city || null;
}

/**
 * Previsões por segmento, com a comparação ao prometido onde exista.
 *
 * @param {{ days?: number }} [opts]
 */
async function getDeliveryPredictions(opts = {}) {
  const linhas = await loadDeliveries(opts);

  const porSegmento = new Map();
  const porZona = new Map();
  for (const linha of linhas) {
    const horas = durationHours(linha);
    if (horas === null) continue;

    const zona = zoneOf(linha);
    const chave = segmentKey(zona, linha.service_level);
    if (!porSegmento.has(chave)) porSegmento.set(chave, []);
    porSegmento.get(chave).push(horas);

    const zk = zona ?? 'sem-zona';
    if (!porZona.has(zk)) porZona.set(zk, []);
    porZona.get(zk).push(horas);
  }

  const prazos = await loadPromisedHours();
  const combinacoes = new Set();
  for (const linha of linhas) combinacoes.add(segmentKey(zoneOf(linha), linha.service_level));

  const segments = [...combinacoes].map((chave) => {
    const [zona, servico] = chave.split('::');
    const zonaReal = zona === 'sem-zona' ? null : zona;
    const previsao = predict(porSegmento, porZona, zonaReal, servico);

    return {
      ...previsao,
      promise: compareToPromise(previsao, prazos.get(segmentKey(zonaReal, servico)) ?? null),
    };
  }).sort((a, b) => b.sample_size - a.sample_size);

  return {
    days: opts.days ?? 180,
    min_sample: MIN_SAMPLE,
    measured_deliveries: linhas.length,
    segments,
  };
}

/** Prazos acordados por zona e nível de serviço (§ 3.42). */
async function loadPromisedHours() {
  const params = [];
  let where = '';
  const cid = readCompanyId();
  if (cid) { params.push(cid); where = ` WHERE company_id = $${params.length}`; }

  const mapa = new Map();
  try {
    const { rows } = await pool.query(
      `SELECT name, sla_hours_normal, sla_hours_express FROM pricing_zones${where}`, params,
    );
    for (const z of rows) {
      if (z.sla_hours_normal) mapa.set(segmentKey(z.name, 'normal'), z.sla_hours_normal);
      if (z.sla_hours_express) mapa.set(segmentKey(z.name, 'express'), z.sla_hours_express);
    }
  } catch { /* sem tabela de zonas — não há promessa para comparar */ }
  return mapa;
}

/**
 * Previsão para UMA encomenda — a que o rastreio mostra ao cliente.
 *
 * Devolve `null` quando não há base. Um `null` deixa o ecrã sem a linha, que é
 * melhor do que uma linha a dizer que não se sabe: quem consulta o rastreio quer
 * saber onde está a encomenda, e um aviso de amostra insuficiente é conversa
 * interna.
 */
async function predictForOrder(order, opts = {}) {
  const { segments } = await getDeliveryPredictions(opts);
  const zona = order?.pricing?.zone_name ?? order?.destination?.city ?? null;
  const servico = order?.pricing?.service_level ?? 'normal';

  const achado = segments.find((s) => s.zone === zona && (s.service_level === servico || s.basis === 'zone'));
  return achado?.enough ? achado : null;
}

module.exports = {
  // Puros
  durationHours,
  percentile,
  segmentKey,
  summarize,
  predict,
  compareToPromise,
  // Leitura
  getDeliveryPredictions,
  predictForOrder,
  // Constantes
  MIN_SAMPLE,
  MAX_PLAUSIBLE_HOURS,
};
