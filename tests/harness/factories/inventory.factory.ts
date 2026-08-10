/**
 * @file inventory.factory.ts
 * @description Factory das transferências entre filiais e contagens.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'cancelled';
export type TransferItemStatus = 'pending' | 'received' | 'missing' | 'unexpected';

export interface TestTransferInput {
  origin_id: string;
  destination_id: string;
  tracking_codes: string[];
  notes?: string;
}

/** Um cenário de conferência: o que ia no manifesto e o que se leu à chegada. */
export interface TestReconciliation {
  expected: string[];
  scanned: string[];
}

/** Uma encomenda no armazém, com a data que determina a sua idade. */
export interface TestStoredOrder {
  id: string;
  tracking_code: string;
  updated_at: string;
}

let contador = 1;

/** `daysAgo` dias antes de `now`, em ISO. */
function diasAtras(daysAgo: number, now = Date.now()): string {
  return new Date(now - daysAgo * 86_400_000).toISOString();
}

export class InventoryFactory {
  static transfer(overrides: Partial<TestTransferInput> = {}): TestTransferInput {
    const n = contador++;
    return {
      origin_id:      `warehouse-test-uuid-${String(n).padStart(4, '0')}`,
      destination_id: `warehouse-test-uuid-${String(n + 1).padStart(4, '0')}`,
      tracking_codes: [],
      ...overrides,
    };
  }

  /** Tudo o que saiu chegou — o caso que se espera e que raramente se testa. */
  static perfectReconciliation(codes = ['TRK1', 'TRK2', 'TRK3']): TestReconciliation {
    return { expected: [...codes], scanned: [...codes] };
  }

  /** Uma encomenda não chegou: é para este caso que a transferência existe. */
  static withMissing(): TestReconciliation {
    return { expected: ['TRK1', 'TRK2', 'TRK3'], scanned: ['TRK1', 'TRK3'] };
  }

  /** Chegou algo que não ia no manifesto. */
  static withUnexpected(): TestReconciliation {
    return { expected: ['TRK1', 'TRK2'], scanned: ['TRK1', 'TRK2', 'TRK9'] };
  }

  /** A mesma etiqueta lida duas vezes — o que acontece mesmo num armazém. */
  static withDuplicateScans(): TestReconciliation {
    return { expected: ['TRK1', 'TRK2'], scanned: ['TRK1', 'TRK1', 'TRK2', 'TRK2'] };
  }

  /**
   * Encomendas com idades escolhidas para cair nos três baldes: até 3 dias
   * (fresh), até 7 (aging), acima (stale).
   */
  static agedInventory(now = Date.now()): TestStoredOrder[] {
    return [
      { id: 'o1', tracking_code: 'TRK-FRESH-1', updated_at: diasAtras(0, now) },
      { id: 'o2', tracking_code: 'TRK-FRESH-2', updated_at: diasAtras(3, now) },
      { id: 'o3', tracking_code: 'TRK-AGING-1', updated_at: diasAtras(5, now) },
      { id: 'o4', tracking_code: 'TRK-STALE-1', updated_at: diasAtras(21, now) },
    ];
  }
}
