/**
 * @file settlement.factory.ts
 * @description Test factory para COD e acerto de caixa do motorista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.5
 *
 * Alinhado com backend/shared/types/src/cod.types.ts. Valores em centavos.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { CodMethod, CodStatus, SettlementStatus } from '../../../backend/shared/types/src/cod.types';

export interface TestCodCollection {
  amount: number;
  method: CodMethod;
  collected_by?: string;
  collected_at: string;
}

export interface TestDriverSettlement {
  id: string;
  driver_id: string;
  status: SettlementStatus;
  order_count: number;
  expected_cash_cents: number;
  expected_mobile_cents: number;
  expected_total_cents: number;
  received_cash_cents: number | null;
  difference_cents: number | null;
  order_ids: string[];
  opened_at: string;
  opened_by?: string;
  reconciled_at?: string | null;
  reconciled_by?: string | null;
  notes?: string | null;
}

let _counter = 1;

export class CodCollectionFactory {
  static build(overrides: Partial<TestCodCollection> = {}): TestCodCollection {
    return {
      amount:       5000, // 50,00 MZN
      method:       CodMethod.CASH,
      collected_by: undefined,
      collected_at: new Date().toISOString(),
      ...overrides,
    };
  }

  static buildMobile(overrides: Partial<TestCodCollection> = {}): TestCodCollection {
    return this.build({ method: CodMethod.MPESA, ...overrides });
  }
}

export class DriverSettlementFactory {
  static build(overrides: Partial<TestDriverSettlement> = {}): TestDriverSettlement {
    const n = _counter++;
    return {
      id:                    `stl-test-uuid-${n.toString().padStart(4, '0')}`,
      driver_id:             'driver-test-uuid-0001',
      status:                SettlementStatus.OPEN,
      order_count:           1,
      expected_cash_cents:   5000,
      expected_mobile_cents: 0,
      expected_total_cents:  5000,
      received_cash_cents:   null,
      difference_cents:      null,
      order_ids:             ['order-test-uuid-0001'],
      opened_at:             new Date().toISOString(),
      opened_by:             undefined,
      reconciled_at:         null,
      reconciled_by:         null,
      notes:                 null,
      ...overrides,
    };
  }

  /** Acerto já reconciliado (sem diferença). */
  static buildReconciled(overrides: Partial<TestDriverSettlement> = {}): TestDriverSettlement {
    return this.build({
      status:              SettlementStatus.RECONCILED,
      received_cash_cents: 5000,
      difference_cents:    0,
      reconciled_at:       new Date().toISOString(),
      ...overrides,
    });
  }
}

/** Reexport para conveniência nos specs. */
export { CodMethod, CodStatus, SettlementStatus };
