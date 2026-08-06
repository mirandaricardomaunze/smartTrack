/**
 * @file optimizer.spec.js
 * @description Testes do motor de otimização de rotas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2 (Otimização de Rotas)
 *
 * Estratégia: usar geometrias em que a resposta ótima é conhecida por construção
 * (pontos colineares, quadrado com cruzamento) em vez de comparar contra números
 * mágicos — assim os testes continuam a valer se a heurística for afinada.
 */
import { describe, it, expect } from 'vitest';
// O módulo sob teste é CommonJS (o serviço corre em Node sem build step),
// por isso é importado como default e desestruturado.
import optimizer from './optimizer.js';

const {
  haversineKm,
  routeDistanceKm,
  nearestNeighbour,
  twoOpt,
  optimizeStops,
} = optimizer;

/** Helper: constrói uma parada de teste. */
function stop(id, lat, lng) {
  return { order_id: id, address: `Endereço ${id}`, lat, lng, status: 'pending' };
}

describe('haversineKm', () => {
  it('should return zero for the same point', () => {
    expect(haversineKm({ lat: -25.96, lng: 32.58 }, { lat: -25.96, lng: 32.58 })).toBe(0);
  });

  it('should be symmetric', () => {
    const a = { lat: -25.96, lng: 32.58 }; // Maputo
    const b = { lat: -19.84, lng: 34.84 }; // Beira

    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });

  it('should approximate a known distance (Maputo → Beira ≈ 740km)', () => {
    const d = haversineKm({ lat: -25.9692, lng: 32.5732 }, { lat: -19.8436, lng: 34.8389 });

    // Tolerância larga: é distância geodésica, não rodoviária.
    expect(d).toBeGreaterThan(700);
    expect(d).toBeLessThan(780);
  });

  it('should grow with latitude separation', () => {
    const origem = { lat: 0, lng: 0 };
    expect(haversineKm(origem, { lat: 10, lng: 0 })).toBeLessThan(
      haversineKm(origem, { lat: 20, lng: 0 }),
    );
  });
});

describe('routeDistanceKm', () => {
  it('should return zero for an empty route', () => {
    expect(routeDistanceKm({ lat: 0, lng: 0 }, [])).toBe(0);
  });

  it('should sum the legs including the leg from the origin', () => {
    const origem = { lat: 0, lng: 0 };
    const paradas = [stop('a', 0, 1), stop('b', 0, 2)];

    const esperado =
      haversineKm(origem, paradas[0]) + haversineKm(paradas[0], paradas[1]);

    expect(routeDistanceKm(origem, paradas)).toBeCloseTo(esperado, 9);
  });
});

describe('nearestNeighbour', () => {
  it('should order collinear stops by increasing distance from the origin', () => {
    const origem = { lat: 0, lng: 0 };
    // Entregues fora de ordem de propósito
    const paradas = [stop('c', 0, 3), stop('a', 0, 1), stop('b', 0, 2)];

    const ordem = nearestNeighbour(origem, paradas);

    expect(ordem.map((s) => s.order_id)).toEqual(['a', 'b', 'c']);
  });

  it('should visit every stop exactly once', () => {
    const origem = { lat: 0, lng: 0 };
    const paradas = [stop('a', 1, 1), stop('b', 2, 2), stop('c', -1, 3), stop('d', 0.5, -2)];

    const ordem = nearestNeighbour(origem, paradas);

    expect(ordem).toHaveLength(4);
    expect(new Set(ordem.map((s) => s.order_id))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('should not mutate the input array', () => {
    const paradas = [stop('a', 0, 2), stop('b', 0, 1)];
    const copia   = [...paradas];

    nearestNeighbour({ lat: 0, lng: 0 }, paradas);

    expect(paradas).toEqual(copia);
  });
});

describe('twoOpt', () => {
  it('should not change routes with fewer than 4 stops', () => {
    const paradas = [stop('a', 0, 1), stop('b', 0, 2), stop('c', 0, 3)];
    expect(twoOpt({ lat: 0, lng: 0 }, paradas)).toEqual(paradas);
  });

  it('should never make a route longer', () => {
    const origem = { lat: 0, lng: 0 };
    // Ordem deliberadamente cruzada sobre os cantos de um quadrado
    const paradas = [stop('a', 0, 0.1), stop('b', 0.1, 0.1), stop('c', 0, 0), stop('d', 0.1, 0)];

    const antes  = routeDistanceKm(origem, paradas);
    const depois = routeDistanceKm(origem, twoOpt(origem, paradas));

    expect(depois).toBeLessThanOrEqual(antes);
  });

  it('should untangle a crossing on a square', () => {
    const origem = { lat: 0, lng: 0 };
    // Percurso em "gravata": (0,0) → (1,1) → (0,1) → (1,0) cruza no meio
    const cruzado = [stop('a', 0, 0), stop('b', 1, 1), stop('c', 0, 1), stop('d', 1, 0)];

    const resultado = twoOpt(origem, cruzado);

    expect(routeDistanceKm(origem, resultado)).toBeLessThan(routeDistanceKm(origem, cruzado));
  });

  it('should preserve the stop set', () => {
    const origem = { lat: 0, lng: 0 };
    const paradas = [stop('a', 0, 0), stop('b', 1, 1), stop('c', 0, 1), stop('d', 1, 0)];

    const ids = twoOpt(origem, paradas).map((s) => s.order_id).sort();

    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('optimizeStops', () => {
  it('should assign sequential positions and report the distance', () => {
    const paradas = [stop('c', 0, 3), stop('a', 0, 1), stop('b', 0, 2)];

    const r = optimizeStops(paradas, { lat: 0, lng: 0 });

    expect(r.stops.map((s) => s.order_id)).toEqual(['a', 'b', 'c']);
    expect(r.distance_km).toBeGreaterThan(0);
    expect(r.optimized_count).toBe(3);
    expect(r.unoptimized_stops).toEqual([]);
  });

  it('should never report a negative improvement', () => {
    const paradas = [stop('a', 0, 0), stop('b', 1, 1), stop('c', 0, 1), stop('d', 1, 0)];

    expect(optimizeStops(paradas, { lat: 0, lng: 0 }).improvement_km).toBeGreaterThanOrEqual(0);
  });

  it('should use the first stop as origin when none is given', () => {
    const paradas = [stop('a', 0, 0), stop('b', 0, 1)];

    const r = optimizeStops(paradas);

    expect(r.stops[0].order_id).toBe('a');
    expect(r.optimized_count).toBe(2);
  });

  describe('paradas sem coordenadas', () => {
    it('should append them at the end and flag them', () => {
      const paradas = [
        stop('a', 0, 2),
        { order_id: 'sem-gps', address: 'Endereço por geocodificar', status: 'pending' },
        stop('b', 0, 1),
      ];

      const r = optimizeStops(paradas, { lat: 0, lng: 0 });

      expect(r.stops.map((s) => s.order_id)).toEqual(['b', 'a', 'sem-gps']);
      expect(r.unoptimized_stops).toEqual(['sem-gps']);
      expect(r.optimized_count).toBe(2);
    });

    it('should keep input order when no stop has coordinates', () => {
      const paradas = [
        { order_id: 'x', address: 'A', status: 'pending' },
        { order_id: 'y', address: 'B', status: 'pending' },
      ];

      const r = optimizeStops(paradas);

      expect(r.stops.map((s) => s.order_id)).toEqual(['x', 'y']);
      expect(r.distance_km).toBe(0);
      expect(r.optimized_count).toBe(0);
      expect(r.unoptimized_stops).toEqual(['x', 'y']);
    });
  });

  it('should handle a single stop', () => {
    const r = optimizeStops([stop('a', -25.96, 32.58)], { lat: -25.96, lng: 32.58 });

    expect(r.stops).toHaveLength(1);
    expect(r.distance_km).toBe(0);
  });
});
