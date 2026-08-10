/**
 * @file optimizer.js
 * @description Motor de otimização de rotas multi-parada.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2 (Otimização de Rotas)
 *
 * ALGORITMO:
 * Heurística em duas fases sobre distância haversine:
 *   1. Nearest Neighbour — constrói uma ordem inicial gulosa a partir da origem.
 *   2. 2-opt — remove cruzamentos invertendo sub-segmentos enquanto houver ganho.
 *
 * É uma heurística, não um ótimo global (o problema é NP-difícil). Para as
 * dezenas de paradas de uma rota urbana típica, 2-opt fica tipicamente a poucos
 * pontos percentuais do ótimo, com custo O(n²) por passagem.
 *
 * LIMITES CONHECIDOS (§ 3.2 pede também estes fatores, ainda não cobertos):
 *   - Não considera trânsito em tempo real — exige Directions API.
 *   - Usa distância geodésica, não distância de condução pela malha viária.
 * As janelas de entrega passaram a ser consideradas (§ 3.48, ),
 * mas SÓ quando as paradas as trazem: sem janelas, o caminho é o descrito acima.
 * A capacidade do veículo é verificada FORA daqui: o gateway recusa a rota
 * antes de a otimizar quando a carga não cabe no veículo do motorista
 * (§ 3.33, `application/dispatch.service.js`). Este módulo só vê paradas —
 * não conhece motoristas nem pesos.
 * Quando o Google Maps Platform for ligado (§ 6 da spec), este módulo passa a
 * ser o fallback offline.
 *
 * PARADAS SEM COORDENADAS:
 * Não são descartadas nem inventadas — são anexadas ao fim, na ordem de entrada,
 * e sinalizadas em `unoptimized_stops`. Otimizar sem coordenadas exigiria
 * geocodificação, que é responsabilidade de outro serviço.
 */
'use strict';

/** Raio médio da Terra em km — usado pelo haversine. */
const EARTH_RADIUS_KM = 6371;

/** Tetos de segurança para o 2-opt não degradar a latência da API. */
const MAX_TWO_OPT_STOPS  = 120;
const MAX_TWO_OPT_PASSES = 40;

/** Ganho mínimo (km) para aceitar uma troca — evita oscilar por ruído de float. */
const MIN_IMPROVEMENT_KM = 1e-9;

/**
 * @param {number} deg
 * @returns {number}
 */
function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Distância geodésica entre dois pontos, em km (fórmula de haversine).
 *
 * @param {{lat: number, lng: number}} a
 * @param {{lat: number, lng: number}} b
 * @returns {number} km
 */
function haversineKm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Comprimento total de um percurso que parte de `origin` e visita `stops` em ordem.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {object[]} stops
 * @returns {number} km
 */
function routeDistanceKm(origin, stops) {
  if (stops.length === 0) return 0;

  let total = haversineKm(origin, stops[0]);
  for (let i = 0; i < stops.length - 1; i++) {
    total += haversineKm(stops[i], stops[i + 1]);
  }
  return total;
}

/**
 * Fase 1 — Nearest Neighbour.
 * A cada passo escolhe a parada não visitada mais próxima da posição atual.
 *
 * @param {{lat: number, lng: number}} origin
 * @param {object[]} stops
 * @returns {object[]} nova ordem
 */
function nearestNeighbour(origin, stops) {
  const restantes = [...stops];
  const ordem     = [];
  let atual       = origin;

  while (restantes.length > 0) {
    let melhorIdx  = 0;
    let melhorDist = haversineKm(atual, restantes[0]);

    for (let i = 1; i < restantes.length; i++) {
      const d = haversineKm(atual, restantes[i]);
      if (d < melhorDist) {
        melhorDist = d;
        melhorIdx  = i;
      }
    }

    atual = restantes[melhorIdx];
    ordem.push(atual);
    restantes.splice(melhorIdx, 1);
  }

  return ordem;
}

/**
 * Fase 2 — 2-opt.
 * Inverte o sub-segmento [i..k] sempre que isso encurtar o percurso total.
 * Repete até uma passagem completa não trazer melhoria (ou atingir o teto).
 *
 * @param {{lat: number, lng: number}} origin
 * @param {object[]} stops
 * @returns {object[]} nova ordem
 */
function twoOpt(origin, stops) {
  // Abaixo de 4 paradas não há cruzamento possível de desfazer.
  if (stops.length < 4) return stops;

  // Acima do teto, o custo O(n²) por passagem deixa de compensar.
  if (stops.length > MAX_TWO_OPT_STOPS) return stops;

  let melhor         = [...stops];
  let melhorDistancia = routeDistanceKm(origin, melhor);
  let passagens      = 0;
  let melhorou       = true;

  while (melhorou && passagens < MAX_TWO_OPT_PASSES) {
    melhorou = false;
    passagens++;

    for (let i = 0; i < melhor.length - 1; i++) {
      for (let k = i + 1; k < melhor.length; k++) {
        const candidato = [
          ...melhor.slice(0, i),
          ...melhor.slice(i, k + 1).reverse(),
          ...melhor.slice(k + 1),
        ];

        const distancia = routeDistanceKm(origin, candidato);

        if (distancia < melhorDistancia - MIN_IMPROVEMENT_KM) {
          melhor          = candidato;
          melhorDistancia = distancia;
          melhorou        = true;
        }
      }
    }
  }

  return melhor;
}

/**
 * Otimiza a ordem de visita de um conjunto de paradas.
 *
 * @param {object[]} stops Paradas cruas (já validadas pela entidade)
 * @param {{lat: number, lng: number}} [origin] Ponto de partida (ex.: GPS do motorista).
 *   Omitido: usa a primeira parada com coordenadas como origem.
 * @param {{ departure_at?: string, speed_kmh?: number, service_minutes?: number }} [opts]
 *   Só têm efeito quando alguma parada traz janela (§ 3.48).
 * @returns {{
 *   stops: object[],
 *   distance_km: number,
 *   optimized_count: number,
 *   unoptimized_stops: string[],
 *   improvement_km: number
 * }}
 */
function optimizeStops(stops, origin, opts = {}) {
  const comCoordenadas = stops.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  const semCoordenadas = stops.filter((s) => typeof s.lat !== 'number' || typeof s.lng !== 'number');

  // Sem nenhuma coordenada não há nada a otimizar — devolve a ordem de entrada.
  if (comCoordenadas.length === 0) {
    return {
      stops,
      distance_km:       0,
      optimized_count:   0,
      unoptimized_stops: semCoordenadas.map((s) => s.order_id),
      improvement_km:    0,
    };
  }

  const partida = origin && typeof origin.lat === 'number' && typeof origin.lng === 'number'
    ? origin
    : comCoordenadas[0];

  const distanciaOriginal = routeDistanceKm(partida, comCoordenadas);

  // Janelas de entrega (§ 3.48). SÓ quando alguma parada as traz: sem elas, o
  // caminho é exatamente o de antes — quilómetros e mais nada. Uma otimização
  // que mudasse de comportamento por causa de um campo opcional vazio seria uma
  // alteração silenciosa de todas as rotas existentes.
  // O require fica aqui dentro e não no topo: time-windows.js precisa do
  // haversine deste ficheiro, e um ciclo resolvido no carregamento deixaria uma
  // das duas metades com exports vazios. Corre uma vez por otimização, não por
  // parada.
  const { hasWindows, orderByWindows } = require('./time-windows');

  if (hasWindows(comCoordenadas)) {
    const comJanelas = orderByWindows(comCoordenadas, partida, opts);
    const distanciaJanelas = routeDistanceKm(partida, comJanelas.stops);

    return {
      stops:             [...comJanelas.stops, ...semCoordenadas],
      distance_km:       Number(distanciaJanelas.toFixed(3)),
      optimized_count:   comJanelas.stops.length,
      unoptimized_stops: semCoordenadas.map((s) => s.order_id),
      improvement_km:    Number(Math.max(0, distanciaOriginal - distanciaJanelas).toFixed(3)),
      arrival_estimates: comJanelas.arrival_estimates,
      // Devolvidas mesmo vazias: a ausência do campo leria-se como "não foram
      // verificadas", e a lista vazia diz que foram e que cabem todas.
      window_violations: comJanelas.window_violations,
      speed_kmh:         comJanelas.speed_kmh,
      speed_basis:       comJanelas.speed_basis,
    };
  }

  const ordenadas = twoOpt(partida, nearestNeighbour(partida, comCoordenadas));
  const distanciaFinal = routeDistanceKm(partida, ordenadas);

  return {
    // Paradas sem coordenadas vão para o fim, preservando a ordem de entrada.
    stops:             [...ordenadas, ...semCoordenadas],
    distance_km:       Number(distanciaFinal.toFixed(3)),
    optimized_count:   ordenadas.length,
    unoptimized_stops: semCoordenadas.map((s) => s.order_id),
    improvement_km:    Number(Math.max(0, distanciaOriginal - distanciaFinal).toFixed(3)),
  };
}

module.exports = {
  EARTH_RADIUS_KM,
  MAX_TWO_OPT_STOPS,
  haversineKm,
  routeDistanceKm,
  nearestNeighbour,
  twoOpt,
  optimizeStops,
};
