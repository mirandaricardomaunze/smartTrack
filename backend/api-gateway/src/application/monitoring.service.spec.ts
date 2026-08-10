/**
 * @file monitoring.service.spec.ts
 * @description Testes unitários do núcleo da observabilidade.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * Prova, sem base de dados, o que faz a métrica valer alguma coisa: a rota
 * agrega por molde (e não por id, que faria o mapa crescer sem limite), o
 * percentil sai do balde certo, e a taxa de erro respeita a janela e a amostra
 * mínima. Dados via factories.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MonitoringFactory } from '../../../../tests/harness';

const monitoring = require('./monitoring.service');

const {
  routeKey, bucketIndex, percentileFromBuckets, statusClass, errorRate,
  observeRequest, getMetrics, resetMetrics, LATENCY_BUCKETS_MS,
} = monitoring;

describe('Observabilidade · agregação por rota', () => {
  it('should group by the route template, not by the concrete id', () => {
    // Sem isto, mil encomendas dão mil linhas de métrica e o mapa cresce com o
    // tráfego — o defeito clássico que torna a métrica cara e inútil ao mesmo tempo.
    const req = MonitoringFactory.request({ baseUrl: '/v1/orders', route: { path: '/:id' } });
    expect(routeKey(req)).toBe('GET /v1/orders/:id');
  });

  it('should collapse unknown paths into a single bucket', () => {
    // Um 404 não tem rota: agrupar pelo caminho pedido deixaria qualquer
    // varredura de URLs encher a memória do processo.
    expect(routeKey(MonitoringFactory.unmatchedRequest())).toBe('GET unmatched');
  });

  it('should keep the base path when the route is the root of a module', () => {
    const req = MonitoringFactory.request({ method: 'post', baseUrl: '/v1/orders', route: { path: '/' } });
    expect(routeKey(req)).toBe('POST /v1/orders');
  });
});

describe('Observabilidade · latência', () => {
  it.each([
    [10, 0],
    [50, 0],
    [51, 1],
    [2500, 5],
    [9000, LATENCY_BUCKETS_MS.length],
  ])('should place %ims in bucket %i', (ms, indice) => {
    expect(bucketIndex(ms)).toBe(indice);
  });

  it('should report no percentile when nothing was measured', () => {
    expect(percentileFromBuckets([0, 0, 0, 0, 0, 0, 0, 0], 0.95)).toBeNull();
  });

  it('should report the ceiling of the bucket where the percentile falls', () => {
    // 95 pedidos rápidos + 5 lentos: o p95 cai ainda no balde rápido.
    const buckets = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
    buckets[0] = 95;
    buckets[4] = 5;
    expect(percentileFromBuckets(buckets, 0.95)).toBe(LATENCY_BUCKETS_MS[0]);
  });

  it('should report Infinity when the slow tail is above the last bucket', () => {
    const buckets = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0);
    buckets[0] = 50;
    buckets[LATENCY_BUCKETS_MS.length] = 50;
    expect(percentileFromBuckets(buckets, 0.95)).toBe(Infinity);
  });
});

describe('Observabilidade · taxa de erro', () => {
  const agora = 1_700_000_000_000;

  it('should ignore samples older than the window', () => {
    const recentes: Array<[number, boolean]> = [
      [agora - 60 * 60_000, true],  // uma hora atrás: fora
      [agora - 60_000, false],
      [agora - 30_000, true],
    ];
    const resultado = errorRate(recentes, agora, 15 * 60_000);

    expect(resultado.requests).toBe(2);
    expect(resultado.errors).toBe(1);
    expect(resultado.rate).toBeCloseTo(0.5);
  });

  it('should be zero when the window is empty instead of dividing by zero', () => {
    expect(errorRate([], agora, 15 * 60_000)).toEqual({ requests: 0, errors: 0, rate: 0 });
  });
});

describe('Observabilidade · classes de estado', () => {
  it.each([[200, '2xx'], [301, '3xx'], [404, '4xx'], [500, '5xx']])(
    'should classify %i as %s', (status, classe) => {
      expect(statusClass(status)).toBe(classe);
    });

  it('should treat a missing status as a server error, not as success', () => {
    // Um estado que não se conseguiu ler é uma anomalia; contá-lo como 2xx
    // escondia exatamente o caso que interessa ver.
    expect(statusClass(undefined as unknown as number)).toBe('5xx');
  });
});

describe('Observabilidade · fotografia das métricas', () => {
  beforeEach(() => resetMetrics());

  it('should count requests, errors and latency per route', () => {
    for (const obs of MonitoringFactory.latencySeries([10, 20, 30])) {
      observeRequest(obs.req, obs.status, obs.durationMs);
    }
    observeRequest(MonitoringFactory.request(), 500, 800);

    const metricas = getMetrics();
    const rota = metricas.routes.find((r: any) => r.route === 'GET /v1/orders/:id');

    expect(rota.requests).toBe(4);
    expect(rota.errors).toBe(1);
    expect(rota.max_ms).toBe(800);
    expect(metricas.status_classes['2xx']).toBe(3);
    expect(metricas.status_classes['5xx']).toBe(1);
  });

  it('should count only server errors as errors', () => {
    // Um 404 é a API a responder corretamente que aquilo não existe. Contá-lo
    // como avaria fazia o alerta de taxa de erro disparar com o utilizador a
    // escrever mal um código de rastreio.
    observeRequest(MonitoringFactory.request(), 404, 5);

    const metricas = getMetrics();
    expect(metricas.status_classes['4xx']).toBe(1);
    expect(metricas.error_window.errors).toBe(0);
  });

  it('should start with a clean window after a reset', () => {
    observeRequest(MonitoringFactory.request(), 500, 5);
    resetMetrics();

    const metricas = getMetrics();
    expect(metricas.routes).toEqual([]);
    expect(metricas.error_window.requests).toBe(0);
    expect(metricas.error_sink.recorded).toBe(0);
  });
});
