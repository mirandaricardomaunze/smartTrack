/**
 * @file monitoring.factory.ts
 * @description Factory da observabilidade — requisições medidas e erros gravados.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** O mínimo de um `req` do Express que as métricas leem. */
export interface TestMeasuredRequest {
  method: string;
  baseUrl: string;
  /** Molde da rota resolvido pelo Express (`/:id`), ou undefined em 404. */
  route?: { path: string };
}

/** Uma requisição já concluída, para alimentar `observeRequest`. */
export interface TestObservation {
  req: TestMeasuredRequest;
  status: number;
  durationMs: number;
}

export interface TestErrorEvent {
  id: string;
  correlation_id: string;
  occurred_at: string;
  method: string;
  path: string;
  status: number;
  error_name: string;
  message: string;
  user_id: string | null;
}

let contador = 1;

export class MonitoringFactory {
  /** Requisição que o Express conseguiu casar com uma rota. */
  static request(overrides: Partial<TestMeasuredRequest> = {}): TestMeasuredRequest {
    return {
      method:  'GET',
      baseUrl: '/v1/orders',
      route:   { path: '/:id' },
      ...overrides,
    };
  }

  /** Requisição para um caminho que não existe — o Express não preenche `route`. */
  static unmatchedRequest(): TestMeasuredRequest {
    return { method: 'GET', baseUrl: '', route: undefined };
  }

  static observation(overrides: Partial<TestObservation> = {}): TestObservation {
    return {
      req:        MonitoringFactory.request(),
      status:     200,
      durationMs: 42,
      ...overrides,
    };
  }

  /**
   * Uma série de observações com latências dadas — para exercitar percentis
   * sem espalhar arrays mágicos pelos testes.
   */
  static latencySeries(latenciasMs: number[], status = 200): TestObservation[] {
    return latenciasMs.map((durationMs) => MonitoringFactory.observation({ status, durationMs }));
  }

  static errorEvent(overrides: Partial<TestErrorEvent> = {}): TestErrorEvent {
    const n = contador++;
    return {
      id:             `error-test-uuid-${String(n).padStart(4, '0')}`,
      correlation_id: `corr-test-${String(n).padStart(4, '0')}`,
      occurred_at:    new Date().toISOString(),
      method:         'POST',
      path:           '/v1/orders',
      status:         500,
      error_name:     'TypeError',
      message:        'Cannot read properties of undefined',
      user_id:        'user-test-uuid-0001',
      ...overrides,
    };
  }
}
