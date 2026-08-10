/**
 * @file driver.factory.ts
 * @description Factory de motoristas para testes (em Inglês).
 */

export interface TestDriver {
  id: string;
  name: string;
  email: string;
  phone: string;
  vehicle: {
    /** Modal de entrega (§ 3.33) — ver delivery-modal.factory.ts. */
    type: 'MOTO' | 'MOTOTRICICLO' | 'CARRO' | 'VAN' | 'CAMINHAO';
    plate: string;
    capacity_kg: number;
    licence_category?: string;
  };
  current_status: 'available' | 'on_route' | 'offline';
  performance_metrics: {
    punctuality: number;      // 0–100
    success_rate: number;      // 0–100
    customer_rating: number; // 1–5
    total_deliveries: number;
  };
  created_at: string; // ISO8601 UTC
}

let _counter = 1;

export class DriverFactory {
  static build(overrides: Partial<TestDriver> = {}): TestDriver {
    const n = _counter++;
    return {
      id:       `driver-test-uuid-${n.toString().padStart(4, '0')}`,
      name:     `Motorista Teste ${n}`,
      email:    `motorista${n}@test.com`,
      phone: `+55119${String(n).padStart(8, '0')}`,
      vehicle: {
        type:          'MOTO',
        plate:         `TST${String(n).padStart(4, '0')}`,
        capacity_kg: 20,
      },
      current_status: 'available',
      performance_metrics: {
        punctuality:        95,
        success_rate:        98,
        customer_rating:  4.8,
        total_deliveries:      120,
      },
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestDriver> = {}): TestDriver[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  static buildAvailable(): TestDriver {
    return this.build({ current_status: 'available' });
  }

  static buildOnRoute(): TestDriver {
    return this.build({ current_status: 'on_route' });
  }

  static buildOffline(): TestDriver {
    return this.build({ current_status: 'offline' });
  }

  static buildLowPerformance(): TestDriver {
    return this.build({
      performance_metrics: {
        punctuality:        60,
        success_rate:        72,
        customer_rating:  3.1,
        total_deliveries:      45,
      },
    });
  }
}
