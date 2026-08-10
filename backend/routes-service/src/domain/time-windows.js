/**
 * @file time-windows.js
 * @description Janelas de entrega e prioridade na ordenação das paradas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.48 (estende o § 3.2)
 *
 * O motor do § 3.2 minimiza quilómetros. Uma rota com o mínimo de quilómetros
 * entrega alegremente às 16h uma encomenda combinada para as 9h–12h — e o
 * cliente não estava lá. O que falta não é um algoritmo melhor; é dizer ao
 * algoritmo o que realmente custa.
 *
 * CHEGAR CEDO É ESPERAR; CHEGAR TARDE É FALHAR. Uma ordem alguns quilómetros
 * mais longa que cumpre as janelas é mais barata do que a mais curta que as
 * falha: a falhada volta amanhã e paga a viagem duas vezes.
 *
 * UMA JANELA IMPOSSÍVEL É REPORTADA, NUNCA VIOLADA EM SILÊNCIO. Um plano que
 * esconde o incumprimento fá-lo descobrir à porta do cliente.
 *
 * Este módulo é PURO: recebe paradas e devolve ordem. Não sabe de bases de
 * dados nem de relógios — o instante de partida entra por parâmetro para os
 * testes poderem afirmar horas.
 */
'use strict';

const { haversineKm } = require('./optimizer');

/**
 * Velocidade assumida quando não há histórico para a medir.
 *
 * Trânsito urbano de Maputo em linha reta: a distância geodésica é sempre menor
 * do que a percorrida, e por isso este número é deliberadamente baixo — serve
 * para converter quilómetros em tempo, não para descrever o velocímetro.
 */
const ASSUMED_SPEED_KMH = 18;

/** Minutos parados em cada entrega: estacionar, entregar, recolher assinatura. */
const DEFAULT_SERVICE_MINUTES = 8;

/** Ordem das prioridades. Só decide entre paradas igualmente possíveis. */
const PRIORITY_RANK = { alta: 0, normal: 1, baixa: 2 };

/**
 * Instante em milissegundos, ou null. PURA.
 */
function ms(value) {
  if (value === null || value === undefined) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Minutos de viagem entre dois pontos. PURA.
 *
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @param {number} speedKmh
 */
function travelMinutes(a, b, speedKmh) {
  const v = speedKmh > 0 ? speedKmh : ASSUMED_SPEED_KMH;
  return (haversineKm(a, b) / v) * 60;
}

/**
 * Avalia a chegada a uma parada. PURA.
 *
 * Chegar antes da janela não é um problema — é espera. Fica registada, porque
 * meia hora à porta de um cliente é meia hora que podia ter servido outro.
 *
 * @param {number} arrivalMs
 * @param {{window_start?: string, window_end?: string}} stop
 */
function evaluateArrival(arrivalMs, stop) {
  const abre = ms(stop?.window_start);
  const fecha = ms(stop?.window_end);

  if (abre !== null && arrivalMs < abre) {
    return { status: 'espera', wait_minutes: Math.round((abre - arrivalMs) / 60_000), late_minutes: 0 };
  }
  if (fecha !== null && arrivalMs > fecha) {
    return { status: 'fora_da_janela', wait_minutes: 0, late_minutes: Math.round((arrivalMs - fecha) / 60_000) };
  }
  return { status: stop?.window_start || stop?.window_end ? 'dentro_da_janela' : 'sem_janela', wait_minutes: 0, late_minutes: 0 };
}

/**
 * Escolhe a próxima parada. PURA.
 *
 * A ORDEM DA DECISÃO É A DECISÃO TODA:
 *   1. as que ainda cabem na janela, antes das que já não cabem — a prioridade
 *      não atropela a janela, porque um expresso entregue depois de a janela
 *      fechar não é uma entrega prioritária, é uma entrega falhada mais cedo;
 *   2. entre as possíveis, a janela que fecha primeiro — é a que se perde se
 *      ficar para depois;
 *   3. depois a prioridade, que só decide entre paradas igualmente possíveis;
 *   4. e só então a distância, que era o único critério antes disto.
 */
function chooseNext(atual, agoraMs, candidatas, speedKmh, serviceMinutes) {
  let melhor = null;
  let melhorChave = null;

  for (const s of candidatas) {
    const viagem = travelMinutes(atual, s, speedKmh);
    const chegada = agoraMs + viagem * 60_000;
    const aval = evaluateArrival(chegada, s);
    const fecha = ms(s.window_end);

    const chave = [
      aval.status === 'fora_da_janela' ? 1 : 0,
      fecha ?? Number.MAX_SAFE_INTEGER,
      PRIORITY_RANK[s.priority] ?? PRIORITY_RANK.normal,
      viagem,
    ];

    if (melhorChave === null || menor(chave, melhorChave)) {
      melhorChave = chave;
      melhor = { stop: s, arrivalMs: chegada, evaluation: aval, travel_minutes: viagem };
    }
  }

  if (!melhor) return null;
  const espera = melhor.evaluation.wait_minutes * 60_000;
  return {
    ...melhor,
    // A saída acontece depois de esperar pela abertura e de fazer o serviço.
    departMs: melhor.arrivalMs + espera + serviceMinutes * 60_000,
  };
}

/** Comparação lexicográfica de chaves. PURA. */
function menor(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Ordena as paradas respeitando janelas e prioridade.
 *
 * Guloso e não exaustivo, de propósito: com janelas, o problema deixa de ser
 * apenas NP-difícil e passa a ter soluções impossíveis, e uma pesquisa profunda
 * gastaria segundos para melhorar minutos. O que conta é não esconder o que
 * ficou por cumprir.
 *
 * @param {Array} stops
 * @param {{lat:number,lng:number}} origin
 * @param {{ departure_at?: string, speed_kmh?: number, service_minutes?: number, speed_basis?: string }} [opts]
 */
function orderByWindows(stops, origin, opts = {}) {
  const speedKmh = Number(opts.speed_kmh) > 0 ? Number(opts.speed_kmh) : ASSUMED_SPEED_KMH;
  const serviceMinutes = Number.isFinite(Number(opts.service_minutes))
    ? Number(opts.service_minutes) : DEFAULT_SERVICE_MINUTES;

  const partidaMs = ms(opts.departure_at) ?? Date.now();

  const restantes = [...stops];
  const ordenadas = [];
  const estimativas = [];
  const violacoes = [];

  let atual = origin;
  let agora = partidaMs;

  while (restantes.length) {
    const escolha = chooseNext(atual, agora, restantes, speedKmh, serviceMinutes);
    if (!escolha) break;

    restantes.splice(restantes.indexOf(escolha.stop), 1);
    ordenadas.push(escolha.stop);
    estimativas.push({
      order_id: escolha.stop.order_id ?? escolha.stop.id ?? null,
      arrival_at: new Date(escolha.arrivalMs).toISOString(),
      ...escolha.evaluation,
    });

    if (escolha.evaluation.status === 'fora_da_janela') {
      violacoes.push({
        order_id: escolha.stop.order_id ?? escolha.stop.id ?? null,
        window_end: escolha.stop.window_end ?? null,
        arrival_at: new Date(escolha.arrivalMs).toISOString(),
        late_minutes: escolha.evaluation.late_minutes,
      });
    }

    atual = escolha.stop;
    agora = escolha.departMs;
  }

  return {
    stops: ordenadas,
    arrival_estimates: estimativas,
    window_violations: violacoes,
    // Sem isto, uma hora estimada com uma velocidade inventada é indistinguível
    // de uma medida — e o plano é usado para prometer horas a clientes.
    speed_kmh: speedKmh,
    speed_basis: opts.speed_basis ?? (opts.speed_kmh ? 'measured' : 'assumed'),
    service_minutes: serviceMinutes,
  };
}

/** Alguma parada traz janela? Sem nenhuma, o § 3.2 continua a mandar. PURA. */
function hasWindows(stops) {
  return (stops ?? []).some((s) => s?.window_start || s?.window_end);
}

module.exports = {
  orderByWindows,
  hasWindows,
  evaluateArrival,
  travelMinutes,
  chooseNext,
  ASSUMED_SPEED_KMH,
  DEFAULT_SERVICE_MINUTES,
  PRIORITY_RANK,
};
