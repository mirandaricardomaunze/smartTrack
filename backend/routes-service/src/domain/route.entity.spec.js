/**
 * @file route.entity.spec.js
 * @description Testes da entidade de domínio Rota.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Rota)
 */
import { describe, it, expect } from 'vitest';
// O módulo sob teste é CommonJS (o serviço corre em Node sem build step),
// por isso é importado como default e desestruturado.
import routeEntity from './route.entity.js';

const {
  RouteStatus,
  StopStatus,
  isValidRouteTransition,
  validateStop,
  createRouteEntity,
  applyRouteTransition,
  markStop,
  summarizeRoute,
  InvalidRouteTransitionError,
  MissingRequiredFieldError,
  EmptyRouteError,
} = routeEntity;

/** Helper: constrói uma parada válida. */
function stop(id, extras = {}) {
  return { order_id: id, address: `Endereço ${id}`, lat: -25.96, lng: 32.58, ...extras };
}

/** Helper: constrói uma rota de teste. */
function makeRoute(stops = [stop('a'), stop('b')]) {
  return createRouteEntity('route-test-0001', { driver_id: 'driver-test-uuid-0001', stops });
}

describe('isValidRouteTransition', () => {
  it('should allow PLANEJADA → EM_ANDAMENTO', () => {
    expect(isValidRouteTransition(RouteStatus.PLANNED, RouteStatus.IN_PROGRESS)).toBe(true);
  });

  it('should allow cancelling from PLANEJADA and EM_ANDAMENTO', () => {
    expect(isValidRouteTransition(RouteStatus.PLANNED, RouteStatus.CANCELLED)).toBe(true);
    expect(isValidRouteTransition(RouteStatus.IN_PROGRESS, RouteStatus.CANCELLED)).toBe(true);
  });

  it('should reject skipping straight to CONCLUIDA', () => {
    expect(isValidRouteTransition(RouteStatus.PLANNED, RouteStatus.COMPLETED)).toBe(false);
  });

  it('should treat CONCLUIDA and CANCELADA as terminal', () => {
    expect(isValidRouteTransition(RouteStatus.COMPLETED, RouteStatus.IN_PROGRESS)).toBe(false);
    expect(isValidRouteTransition(RouteStatus.CANCELLED, RouteStatus.PLANNED)).toBe(false);
  });

  it('should reject unknown statuses', () => {
    expect(isValidRouteTransition('INVENTADO', RouteStatus.PLANNED)).toBe(false);
  });
});

describe('validateStop', () => {
  it('should accept a stop without coordinates', () => {
    expect(() => validateStop({ order_id: 'a', address: 'Rua X' }, 0)).not.toThrow();
  });

  it('should require order_id and address', () => {
    expect(() => validateStop({ address: 'Rua X' }, 0)).toThrow(MissingRequiredFieldError);
    expect(() => validateStop({ order_id: 'a' }, 0)).toThrow(MissingRequiredFieldError);
  });

  it('should reject a half coordinate pair', () => {
    expect(() => validateStop({ order_id: 'a', address: 'X', lat: -25.96 }, 0))
      .toThrow(/lng/);
    expect(() => validateStop({ order_id: 'a', address: 'X', lng: 32.58 }, 0))
      .toThrow(/lat/);
  });

  it('should reject coordinates outside valid ranges', () => {
    expect(() => validateStop({ order_id: 'a', address: 'X', lat: 91, lng: 0 }, 0))
      .toThrow(/-90\.\.90/);
    expect(() => validateStop({ order_id: 'a', address: 'X', lat: 0, lng: 181 }, 0))
      .toThrow(/-180\.\.180/);
  });
});

describe('createRouteEntity', () => {
  it('should create a route in PLANEJADA with sequenced stops', () => {
    const rota = makeRoute();

    expect(rota.status).toBe(RouteStatus.PLANNED);
    expect(rota.stops.map((s) => s.sequence)).toEqual([1, 2]);
    expect(rota.stops.every((s) => s.status === StopStatus.PENDING)).toBe(true);
  });

  it('should require a driver_id', () => {
    expect(() => createRouteEntity('r1', { stops: [stop('a')] }))
      .toThrow(MissingRequiredFieldError);
  });

  it('should reject an empty route', () => {
    expect(() => createRouteEntity('r1', { driver_id: 'd1', stops: [] }))
      .toThrow(EmptyRouteError);
  });

  it('should normalize missing coordinates to null', () => {
    const rota = createRouteEntity('r1', {
      driver_id: 'd1',
      stops: [{ order_id: 'a', address: 'Rua X' }],
    });

    expect(rota.stops[0].lat).toBeNull();
    expect(rota.stops[0].lng).toBeNull();
  });
});

describe('applyRouteTransition', () => {
  it('should return a new object without mutating the original', () => {
    const rota = makeRoute();
    const nova = applyRouteTransition(rota, RouteStatus.IN_PROGRESS);

    expect(nova.status).toBe(RouteStatus.IN_PROGRESS);
    expect(rota.status).toBe(RouteStatus.PLANNED);
  });

  it('should throw on an invalid transition', () => {
    const rota = makeRoute();
    expect(() => applyRouteTransition(rota, RouteStatus.COMPLETED))
      .toThrow(InvalidRouteTransitionError);
  });
});

describe('markStop', () => {
  it('should mark a single stop as delivered', () => {
    const rota = makeRoute();
    const nova = markStop(rota, 'a', StopStatus.DELIVERED);

    expect(nova.stops.find((s) => s.order_id === 'a').status).toBe(StopStatus.DELIVERED);
    expect(nova.stops.find((s) => s.order_id === 'b').status).toBe(StopStatus.PENDING);
  });

  it('should not mutate the original route', () => {
    const rota = makeRoute();
    markStop(rota, 'a', StopStatus.DELIVERED);

    expect(rota.stops[0].status).toBe(StopStatus.PENDING);
  });

  it('should auto-complete the route when the last pending stop resolves', () => {
    let rota = applyRouteTransition(makeRoute(), RouteStatus.IN_PROGRESS);

    rota = markStop(rota, 'a', StopStatus.DELIVERED);
    expect(rota.status).toBe(RouteStatus.IN_PROGRESS);

    rota = markStop(rota, 'b', StopStatus.FAILED);
    expect(rota.status).toBe(RouteStatus.COMPLETED);
  });

  it('should not auto-complete a route still in PLANEJADA', () => {
    // Nunca saltar de PLANEJADA para CONCLUIDA sem passar por EM_ANDAMENTO
    let rota = makeRoute();
    rota = markStop(rota, 'a', StopStatus.DELIVERED);
    rota = markStop(rota, 'b', StopStatus.DELIVERED);

    expect(rota.status).toBe(RouteStatus.PLANNED);
  });

  it('should reject an unknown stop status', () => {
    expect(() => markStop(makeRoute(), 'a', 'talvez')).toThrow(MissingRequiredFieldError);
  });

  it('should reject an unknown order_id', () => {
    expect(() => markStop(makeRoute(), 'inexistente', StopStatus.DELIVERED))
      .toThrow(MissingRequiredFieldError);
  });
});

describe('summarizeRoute', () => {
  it('should count stops by status', () => {
    let rota = applyRouteTransition(makeRoute([stop('a'), stop('b'), stop('c')]), RouteStatus.IN_PROGRESS);
    rota = markStop(rota, 'a', StopStatus.DELIVERED);
    rota = markStop(rota, 'b', StopStatus.FAILED);

    expect(summarizeRoute(rota)).toEqual({ total: 3, delivered: 1, failed: 1, pending: 1 });
  });

  it('should tolerate a route without stops', () => {
    expect(summarizeRoute({})).toEqual({ total: 0, delivered: 0, failed: 0, pending: 0 });
  });
});
