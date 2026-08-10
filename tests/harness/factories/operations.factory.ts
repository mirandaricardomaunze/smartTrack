/**
 * @file operations.factory.ts
 * @description Factory do dashboard operacional e das suas exceções.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.39
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export type ExceptionKind =
  | 'failed_without_decision'
  | 'overdue_reschedule'
  | 'stale_in_warehouse'
  | 'stale_in_transit'
  | 'transfer_missing_items'
  | 'credit_limit_exceeded';

/** Uma linha da fila de exceções, como o serviço a devolve. */
export interface TestOperationException {
  kind: ExceptionKind;
  entity_id: string;
  label: string;
  /** Há quantos dias está parada. Alimenta a severidade. */
  age_days: number;
  detail: string;
}

let contador = 1;

/** `daysAgo` dias antes de agora, em ISO. */
function diasAtras(daysAgo: number, now = Date.now()): string {
  return new Date(now - daysAgo * 86_400_000).toISOString();
}

/** `daysAhead` dias a partir de hoje, em YYYY-MM-DD. */
function emDias(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

export class OperationsFactory {
  static exception(overrides: Partial<TestOperationException> = {}): TestOperationException {
    const n = contador++;
    return {
      kind:      'failed_without_decision',
      entity_id: `order-ops-${String(n).padStart(4, '0')}`,
      label:     `TRK96${String(n).padStart(7, '0')}BR`,
      age_days:  2,
      detail:    'Insucesso sem reagendamento nem devolução',
      ...overrides,
    };
  }

  /**
   * Uma fila com as seis espécies de exceção e antiguidades diferentes — serve
   * para afirmar a ordenação por severidade sem a escrever à mão em cada teste.
   */
  static mixedQueue(): TestOperationException[] {
    return [
      OperationsFactory.exception({ kind: 'stale_in_warehouse', age_days: 1, detail: 'Parada no armazém' }),
      OperationsFactory.exception({ kind: 'overdue_reschedule', age_days: 5, detail: 'Data combinada já passou' }),
      OperationsFactory.exception({ kind: 'failed_without_decision', age_days: 12, detail: 'Insucesso sem decisão' }),
      OperationsFactory.exception({ kind: 'stale_in_transit', age_days: 4, detail: 'Em trânsito sem chegar' }),
      OperationsFactory.exception({ kind: 'credit_limit_exceeded', age_days: 0, detail: 'Limite ultrapassado' }),
      OperationsFactory.exception({ kind: 'transfer_missing_items', age_days: 3, detail: '2 encomenda(s) em falta' }),
    ];
  }

  /** Encomenda falhada e sem decisão nenhuma — entra na fila. */
  static failedWithoutDecision(daysAgo = 3) {
    return {
      current_status: 'failed',
      delivery_attempts: 1,
      next_attempt_on: null,
      return_info: null,
      updated_at: diasAtras(daysAgo),
    };
  }

  /** Encomenda falhada mas já reagendada — NÃO entra: há decisão tomada. */
  static failedButRescheduled() {
    return {
      current_status: 'failed',
      delivery_attempts: 1,
      next_attempt_on: emDias(2),
      return_info: null,
      updated_at: diasAtras(1),
    };
  }

  /** Reagendamento cuja data já passou e continua por entregar. */
  static overdueReschedule(daysLate = 2) {
    return {
      current_status: 'in_transit',
      next_attempt_on: emDias(-daysLate),
      updated_at: diasAtras(daysLate),
    };
  }
}
