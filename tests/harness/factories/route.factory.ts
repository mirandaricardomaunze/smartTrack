import { MockJwtPayloads } from '../mocks/jwt-payloads.mock';

export interface TestRoute {
  id: string;
  driver_id: string;
  status: 'PLANEJADA' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'CANCELADA';
  stops: Array<{ order_id: string; address: string; sequence: number; status: 'pending' | 'delivered' | 'failed' }>;
}

let counter = 1;

export class RouteFactory {
  static build(overrides: Partial<TestRoute> = {}): TestRoute {
    const sequence = counter++;
    return {
      id: `route-test-uuid-${String(sequence).padStart(4, '0')}`,
      driver_id: MockJwtPayloads.DRIVER.sub,
      status: 'EM_ANDAMENTO',
      stops: [{
        order_id: `order-test-uuid-${String(sequence).padStart(4, '0')}`,
        address: 'Av. Julius Nyerere, Maputo',
        sequence: 1,
        status: 'pending',
      }],
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestRoute> = {}): TestRoute[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }
}
