/**
 * @file route.entity.js
 * @description Entidade de domínio Rota.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Rota)
 *           docs/spec/especificacao-tecnica-v1.md § 3.2 (Otimização de Rotas)
 *
 * REGRAS DE DOMÍNIO:
 * - Toda mudança de status DEVE passar por `isValidRouteTransition()`.
 * - Nunca usar string literal de status — sempre `RouteStatus`.
 * - Datas sempre UTC (ISO8601).
 * - Funções puras: nunca mutam o argumento, devolvem novo objeto.
 */
'use strict';

/**
 * Vocabulário canônico de status de rota.
 * Espelha o campo `status` da interface Rota da especificação técnica.
 */
const RouteStatus = Object.freeze({
  PLANNED:     'PLANEJADA',
  IN_PROGRESS: 'EM_ANDAMENTO',
  COMPLETED:   'CONCLUIDA',
  CANCELLED:   'CANCELADA',
});

/** Transições válidas entre status de rota. */
const VALID_ROUTE_TRANSITIONS = Object.freeze({
  [RouteStatus.PLANNED]:     [RouteStatus.IN_PROGRESS, RouteStatus.CANCELLED],
  [RouteStatus.IN_PROGRESS]: [RouteStatus.COMPLETED,   RouteStatus.CANCELLED],
  [RouteStatus.COMPLETED]:   [],
  [RouteStatus.CANCELLED]:   [],
});

/** Estados possíveis de uma parada individual. */
const StopStatus = Object.freeze({
  PENDING:   'pending',
  DELIVERED: 'delivered',
  FAILED:    'failed',
});

// ─── Erros tipados ────────────────────────────────────────────────────────────

class InvalidRouteTransitionError extends Error {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    super(`Transição de rota inválida: ${from} → ${to}`);
    this.name = 'InvalidRouteTransitionError';
    this.statusCode = 409;
  }
}

class MissingRequiredFieldError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Campo obrigatório em falta: ${field}`);
    this.name = 'MissingRequiredFieldError';
    this.statusCode = 400;
  }
}

class EmptyRouteError extends Error {
  constructor() {
    super('Uma rota precisa de pelo menos uma parada.');
    this.name = 'EmptyRouteError';
    this.statusCode = 400;
  }
}

class RouteNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Rota não encontrada: ${id}`);
    this.name = 'RouteNotFoundError';
    this.statusCode = 404;
  }
}

// ─── Funções de domínio puras ────────────────────────────────────────────────

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidRouteTransition(from, to) {
  const allowed = VALID_ROUTE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Valida uma parada recebida do exterior.
 * Coordenadas são OPCIONAIS — paradas sem coordenadas não entram na otimização
 * geográfica (ver optimizer.js), mas continuam a ser paradas válidas.
 *
 * @param {object} stop
 * @param {number} index Posição no array, usada nas mensagens de erro
 */
function validateStop(stop, index) {
  if (!stop || typeof stop !== 'object') {
    throw new MissingRequiredFieldError(`stops[${index}]`);
  }
  if (!stop.order_id) throw new MissingRequiredFieldError(`stops[${index}].order_id`);
  if (!stop.address)  throw new MissingRequiredFieldError(`stops[${index}].address`);

  // Se vier uma coordenada, tem de vir o par completo e dentro dos limites.
  const hasLat = stop.lat !== undefined && stop.lat !== null;
  const hasLng = stop.lng !== undefined && stop.lng !== null;

  if (hasLat !== hasLng) {
    throw new MissingRequiredFieldError(`stops[${index}].${hasLat ? 'lng' : 'lat'}`);
  }
  if (hasLat) {
    if (typeof stop.lat !== 'number' || Number.isNaN(stop.lat) || stop.lat < -90 || stop.lat > 90) {
      throw new MissingRequiredFieldError(`stops[${index}].lat (fora do intervalo -90..90)`);
    }
    if (typeof stop.lng !== 'number' || Number.isNaN(stop.lng) || stop.lng < -180 || stop.lng > 180) {
      throw new MissingRequiredFieldError(`stops[${index}].lng (fora do intervalo -180..180)`);
    }
  }
}

/**
 * Normaliza uma parada crua para a forma canônica persistida.
 *
 * @param {object} stop
 * @param {number} sequence Sequência otimizada, começa em 1
 * @returns {object}
 */
function normalizeStop(stop, sequence) {
  return {
    order_id: String(stop.order_id),
    address:  String(stop.address),
    lat:      typeof stop.lat === 'number' ? stop.lat : null,
    lng:      typeof stop.lng === 'number' ? stop.lng : null,
    sequence,
    status:   stop.status ?? StopStatus.PENDING,
  };
}

/**
 * Cria uma nova Rota com status PLANEJADA.
 * As paradas já devem vir na ordem otimizada — a ordenação é responsabilidade
 * do optimizer, não da entidade.
 *
 * @param {string} id
 * @param {{ driver_id: string, stops: object[], distance_km?: number }} dto
 * @returns {object} Rota
 */
function createRouteEntity(id, dto) {
  if (!dto.driver_id) throw new MissingRequiredFieldError('driver_id');
  if (!Array.isArray(dto.stops) || dto.stops.length === 0) throw new EmptyRouteError();

  dto.stops.forEach(validateStop);

  const now = new Date().toISOString();

  return {
    id,
    driver_id:    dto.driver_id,
    stops:        dto.stops.map((s, i) => normalizeStop(s, i + 1)),
    status:       RouteStatus.PLANNED,
    distance_km:  typeof dto.distance_km === 'number' ? dto.distance_km : null,
    optimized_at: now,
    created_at:   now,
    updated_at:   now,
  };
}

/**
 * Aplica uma transição de status à rota.
 * Devolve novo objeto — não muta o original.
 *
 * @param {object} route
 * @param {string} newStatus
 * @returns {object} Rota atualizada
 */
function applyRouteTransition(route, newStatus) {
  if (!isValidRouteTransition(route.status, newStatus)) {
    throw new InvalidRouteTransitionError(route.status, newStatus);
  }

  return {
    ...route,
    status:     newStatus,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Marca uma parada da rota com um novo estado.
 * Quando todas as paradas deixam de estar pendentes, a rota transita
 * automaticamente para CONCLUIDA (se estiver EM_ANDAMENTO).
 *
 * @param {object} route
 * @param {string} orderId
 * @param {string} stopStatus
 * @returns {object} Rota atualizada
 */
function markStop(route, orderId, stopStatus) {
  const valores = Object.values(StopStatus);
  if (!valores.includes(stopStatus)) {
    throw new MissingRequiredFieldError(`status (esperado um de: ${valores.join(', ')})`);
  }

  const encontrada = route.stops.some((s) => s.order_id === orderId);
  if (!encontrada) throw new MissingRequiredFieldError(`parada com order_id ${orderId}`);

  const stops = route.stops.map((s) =>
    s.order_id === orderId ? { ...s, status: stopStatus } : s,
  );

  const todasResolvidas = stops.every((s) => s.status !== StopStatus.PENDING);

  const updated = {
    ...route,
    stops,
    updated_at: new Date().toISOString(),
  };

  // Conclusão automática — só a partir de EM_ANDAMENTO, para não saltar estados.
  if (todasResolvidas && route.status === RouteStatus.IN_PROGRESS) {
    updated.status = RouteStatus.COMPLETED;
  }

  return updated;
}

/**
 * Contadores derivados, usados pelo painel admin.
 *
 * @param {object} route
 * @returns {{ total: number, delivered: number, failed: number, pending: number }}
 */
function summarizeRoute(route) {
  const stops = route.stops ?? [];
  return {
    total:     stops.length,
    delivered: stops.filter((s) => s.status === StopStatus.DELIVERED).length,
    failed:    stops.filter((s) => s.status === StopStatus.FAILED).length,
    pending:   stops.filter((s) => s.status === StopStatus.PENDING).length,
  };
}

module.exports = {
  RouteStatus,
  StopStatus,
  VALID_ROUTE_TRANSITIONS,
  InvalidRouteTransitionError,
  MissingRequiredFieldError,
  EmptyRouteError,
  RouteNotFoundError,
  isValidRouteTransition,
  validateStop,
  normalizeStop,
  createRouteEntity,
  applyRouteTransition,
  markStop,
  summarizeRoute,
};
