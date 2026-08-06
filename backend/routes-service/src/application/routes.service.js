/**
 * @file routes.service.js
 * @description Casos de uso do routes-service.
 *
 * Single Responsibility: lógica de negócio — não conhece HTTP nem SQL.
 * Recebe DTOs, delega ao domínio (route.entity + optimizer) e persiste
 * através do RouteRepository.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2 (Otimização de Rotas)
 */
'use strict';

const { RouteRepository } = require('../infrastructure/pg.repository');
const { optimizeStops }   = require('../domain/optimizer');

const {
  RouteStatus,
  RouteNotFoundError,
  MissingRequiredFieldError,
  EmptyRouteError,
  InvalidRouteTransitionError,
  createRouteEntity,
  applyRouteTransition,
  markStop,
  summarizeRoute,
  validateStop,
} = require('../domain/route.entity');

/**
 * Gera um id de rota legível e ordenável.
 * @returns {string}
 */
function generateRouteId() {
  const stamp  = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `route-${stamp}-${random}`;
}

/**
 * Lista rotas, opcionalmente filtradas por motorista.
 *
 * @param {{ driver_id?: string }} [filtros]
 * @returns {Promise<object[]>}
 */
async function listRoutes(filtros = {}) {
  const rotas = filtros.driver_id
    ? await RouteRepository.findByDriver(filtros.driver_id)
    : await RouteRepository.findAll();

  // O painel admin consome os contadores — derivá-los aqui evita duplicar
  // a regra em cada cliente.
  return rotas.map((rota) => ({ ...rota, summary: summarizeRoute(rota) }));
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getRoute(id) {
  const rota = await RouteRepository.findById(id);
  if (!rota) throw new RouteNotFoundError(id);
  return { ...rota, summary: summarizeRoute(rota) };
}

/** Retorna somente a rota ativa atribuída ao motorista autenticado. */
async function getActiveRouteForDriver(driverId) {
  if (!driverId) throw new MissingRequiredFieldError('driver_id');
  const rota = await RouteRepository.findActiveByDriver(driverId);
  return rota ? { ...rota, summary: summarizeRoute(rota) } : null;
}

/**
 * Otimiza um conjunto de paradas SEM persistir nada.
 * Útil para pré-visualizar uma rota antes de a criar.
 *
 * @param {{ stops: object[], origin?: {lat: number, lng: number} }} dto
 * @returns {object} Resultado da otimização
 */
function previewOptimization(dto) {
  if (!Array.isArray(dto.stops) || dto.stops.length === 0) throw new EmptyRouteError();
  dto.stops.forEach(validateStop);

  const resultado = optimizeStops(dto.stops, dto.origin);

  return {
    ...resultado,
    stops: resultado.stops.map((s, i) => ({ ...s, sequence: i + 1 })),
  };
}

/**
 * Cria uma rota já otimizada para um motorista.
 *
 * @param {{ driver_id: string, stops: object[], origin?: {lat: number, lng: number} }} dto
 * @returns {Promise<object>} Rota criada
 */
async function createRoute(dto) {
  if (!dto.driver_id) throw new MissingRequiredFieldError('driver_id');
  if (!Array.isArray(dto.stops) || dto.stops.length === 0) throw new EmptyRouteError();

  dto.stops.forEach(validateStop);

  const otimizado = optimizeStops(dto.stops, dto.origin);

  const rota = createRouteEntity(generateRouteId(), {
    driver_id:   dto.driver_id,
    stops:       otimizado.stops,
    distance_km: otimizado.distance_km,
  });

  console.info(
    `[audit] Rota ${rota.id} criada para motorista ${dto.driver_id} — ` +
    `${otimizado.optimized_count} parada(s) otimizada(s), ${otimizado.distance_km}km`,
  );

  const persistida = await RouteRepository.create(rota);
  return { ...persistida, summary: summarizeRoute(persistida), optimization: otimizado };
}

/**
 * Reotimiza uma rota existente, opcionalmente acrescentando novas paradas.
 *
 * Spec § 3.2: "Reotimização dinâmica quando novo pedido entra na rota ou há atraso."
 * Só reordena paradas PENDENTES — as já entregues ou falhadas ficam no início,
 * na ordem em que foram resolvidas, porque já aconteceram no mundo real.
 *
 * @param {string} id
 * @param {{ new_stops?: object[], origin?: {lat: number, lng: number} }} [dto]
 * @returns {Promise<object>} Rota reotimizada
 */
async function reoptimizeRoute(id, dto = {}) {
  const rota = await RouteRepository.findById(id);
  if (!rota) throw new RouteNotFoundError(id);

  if (rota.status === RouteStatus.COMPLETED || rota.status === RouteStatus.CANCELLED) {
    throw new InvalidRouteTransitionError(rota.status, 'reotimização');
  }

  const novas = Array.isArray(dto.new_stops) ? dto.new_stops : [];
  novas.forEach(validateStop);

  const resolvidas = rota.stops.filter((s) => s.status !== 'pending');
  const pendentes  = rota.stops.filter((s) => s.status === 'pending');

  const otimizado = optimizeStops([...pendentes, ...novas], dto.origin);

  const stops = [...resolvidas, ...otimizado.stops].map((s, i) => ({ ...s, sequence: i + 1 }));

  const atualizada = {
    ...rota,
    stops,
    distance_km:  otimizado.distance_km,
    optimized_at: new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  };

  console.info(
    `[audit] Rota ${id} reotimizada — ${novas.length} nova(s) parada(s), ` +
    `${otimizado.distance_km}km, ganho de ${otimizado.improvement_km}km`,
  );

  const persistida = await RouteRepository.update(atualizada);
  if (!persistida) throw new RouteNotFoundError(id);

  return { ...persistida, summary: summarizeRoute(persistida), optimization: otimizado };
}

/**
 * Transita o status de uma rota.
 *
 * @param {string} id
 * @param {{ new_status: string }} dto
 * @returns {Promise<object>} Rota atualizada
 */
async function updateRouteStatus(id, dto) {
  if (!dto || !dto.new_status) throw new MissingRequiredFieldError('new_status');

  const rota = await RouteRepository.findById(id);
  if (!rota) throw new RouteNotFoundError(id);

  const atualizada = applyRouteTransition(rota, dto.new_status);

  const persistida = await RouteRepository.update(atualizada);
  if (!persistida) throw new RouteNotFoundError(id);

  console.info(`[audit] Rota ${id}: ${rota.status} → ${dto.new_status}`);
  return { ...persistida, summary: summarizeRoute(persistida) };
}

/**
 * Marca o resultado de uma parada (entregue / insucesso).
 *
 * @param {string} id
 * @param {string} orderId
 * @param {{ status: string }} dto
 * @returns {Promise<object>} Rota atualizada
 */
async function updateStopStatus(id, orderId, dto) {
  if (!dto || !dto.status) throw new MissingRequiredFieldError('status');

  const rota = await RouteRepository.findById(id);
  if (!rota) throw new RouteNotFoundError(id);

  const atualizada = markStop(rota, orderId, dto.status);

  const persistida = await RouteRepository.update(atualizada);
  if (!persistida) throw new RouteNotFoundError(id);

  return { ...persistida, summary: summarizeRoute(persistida) };
}

/**
 * @returns {Promise<object>}
 */
async function getStats() {
  return RouteRepository.getStats();
}

module.exports = {
  listRoutes,
  getRoute,
  getActiveRouteForDriver,
  previewOptimization,
  createRoute,
  reoptimizeRoute,
  updateRouteStatus,
  updateStopStatus,
  getStats,
  generateRouteId,
  // Re-export dos erros para o router poder tipá-los sem importar o domínio
  RouteNotFoundError,
  MissingRequiredFieldError,
  EmptyRouteError,
  InvalidRouteTransitionError,
};
