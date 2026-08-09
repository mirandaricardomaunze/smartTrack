/**
 * @file redelivery.factory.ts
 * @description Factory do reagendamento e da devolução ao remetente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.37
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export type ReturnReason = 'ATTEMPTS_EXHAUSTED' | 'REFUSED' | 'WRONG_ADDRESS' | 'SENDER_REQUEST' | 'OTHER';

export interface TestRescheduleInput {
  /** Dia acordado, YYYY-MM-DD. */
  scheduled_for: string;
  notes?: string;
  user_id?: string;
}

export interface TestReturnInput {
  reason: ReturnReason;
  notes?: string;
  user_id?: string;
}

/** Prova de que a encomenda voltou às mãos de alguém no remetente. */
export interface TestReturnProof {
  received_by: string;
  signature?: string;
  photo?: string;
  notes?: string;
  user_id?: string;
}

/** Um PNG de 1x1 — chega para provar que a assinatura é guardada. */
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** `daysAhead` dias a partir de hoje, em YYYY-MM-DD. */
function emDias(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

let contador = 1;

export class RedeliveryFactory {
  /** Reagendamento normal: amanhã. */
  static reschedule(overrides: Partial<TestRescheduleInput> = {}): TestRescheduleInput {
    return {
      scheduled_for: emDias(1),
      notes: 'Cliente pediu para tentar de manhã',
      user_id: `user-test-uuid-${String(contador++).padStart(4, '0')}`,
      ...overrides,
    };
  }

  /**
   * Reagendamento para ontem — o erro de digitação que ninguém apanha depois
   * e que faz a encomenda ficar marcada para uma data que já passou.
   */
  static rescheduleInThePast(): TestRescheduleInput {
    return RedeliveryFactory.reschedule({ scheduled_for: emDias(-1) });
  }

  /** Devolução por tentativas esgotadas — o caminho mais comum. */
  static returnRequest(overrides: Partial<TestReturnInput> = {}): TestReturnInput {
    return {
      reason: 'ATTEMPTS_EXHAUSTED',
      notes: 'Três tentativas sem sucesso',
      user_id: `user-test-uuid-${String(contador++).padStart(4, '0')}`,
      ...overrides,
    };
  }

  /** Prova de devolução completa: nome de quem recebeu e assinatura. */
  static returnProof(overrides: Partial<TestReturnProof> = {}): TestReturnProof {
    return {
      received_by: 'Armazém do Remetente — Ana Costa',
      signature: TINY_PNG,
      notes: 'Devolvida em bom estado',
      ...overrides,
    };
  }

  /** Prova sem nome: é o que a confirmação tem de recusar. */
  static returnProofWithoutReceiver(): TestReturnProof {
    return { received_by: '   ' };
  }

  /** Datas úteis para os testes, sem as espalhar pelos ficheiros. */
  static readonly TOMORROW = emDias(1);
  static readonly YESTERDAY = emDias(-1);
  static readonly TINY_PNG = TINY_PNG;
}
