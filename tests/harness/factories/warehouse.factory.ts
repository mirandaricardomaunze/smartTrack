/**
 * @file warehouse.factory.ts
 * @description Test factory para Armazéns e movimentos (gestão dinâmica).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 8.2, § 4
 *
 * Tipos alinhados com o contrato do backend:
 *   - Warehouse / WarehouseStatus / MovementType
 *     (backend/shared/types/src/warehouse.types.ts)
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import {
  WarehouseStatus,
  MovementType,
} from '../../../backend/shared/types/src/warehouse.types';

export interface TestWarehouse {
  id: string;
  code: string;
  name: string;
  address: { city: string; state: string; country: string };
  capacity: number; // 0 = ilimitada
  status: WarehouseStatus;
  gps?: { lat: number; lng: number };
  created_at: string; // ISO8601 UTC
  updated_at: string; // ISO8601 UTC
}

export interface TestWarehouseMovement {
  id: string;
  warehouse_id: string;
  order_id: string;
  tracking_code?: string;
  type: MovementType;
  notes?: string;
  user_id?: string;
  created_at: string; // ISO8601 UTC
}

let _counter = 1;
let _movCounter = 1;

export class WarehouseFactory {
  static build(overrides: Partial<TestWarehouse> = {}): TestWarehouse {
    const n = _counter++;
    const now = new Date().toISOString();
    return {
      id:       `wh-test-uuid-${n.toString().padStart(4, '0')}`,
      code:     `WH-${String(n).padStart(3, '0')}`,
      name:     `Armazém Teste ${n}`,
      address:  { city: 'Maputo', state: 'MPM', country: 'MZ' },
      capacity: 100,
      status:   WarehouseStatus.ACTIVE,
      gps:      { lat: -25.9692, lng: 32.5732 },
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestWarehouse> = {}): TestWarehouse[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  /** Armazém com capacidade unitária — útil para testar lotação/capacidade excedida. */
  static buildFull(overrides: Partial<TestWarehouse> = {}): TestWarehouse {
    return this.build({ capacity: 1, ...overrides });
  }

  /** Armazém com capacidade ilimitada (0). */
  static buildUnlimited(overrides: Partial<TestWarehouse> = {}): TestWarehouse {
    return this.build({ capacity: 0, ...overrides });
  }

  /** Armazém inativo — não deve aceitar entradas. */
  static buildInactive(overrides: Partial<TestWarehouse> = {}): TestWarehouse {
    return this.build({ status: WarehouseStatus.INACTIVE, ...overrides });
  }
}

export class WarehouseMovementFactory {
  static build(overrides: Partial<TestWarehouseMovement> = {}): TestWarehouseMovement {
    const n = _movCounter++;
    return {
      id:            `wh-mov-test-uuid-${n.toString().padStart(4, '0')}`,
      warehouse_id:  'wh-test-uuid-0001',
      order_id:      'order-test-uuid-0001',
      tracking_code: `TRK${String(n).padStart(8, '0')}BR`,
      type:          MovementType.INTAKE,
      notes:         undefined,
      user_id:       undefined,
      created_at:    new Date().toISOString(),
      ...overrides,
    };
  }

  static buildIntake(overrides: Partial<TestWarehouseMovement> = {}): TestWarehouseMovement {
    return this.build({ type: MovementType.INTAKE, ...overrides });
  }

  static buildDispatch(overrides: Partial<TestWarehouseMovement> = {}): TestWarehouseMovement {
    return this.build({ type: MovementType.DISPATCH, ...overrides });
  }
}
