/**
 * @file audit.factory.ts
 * @description Test factories do registo de auditoria.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * Alinhado com backend/shared/types/src/audit.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { AuditOutcome } from '../../../backend/shared/types/src/audit.types';

export interface TestAuditEvent {
  id: string;
  company_id: string;
  seq: number;
  occurred_at: string;
  actor_id?: string;
  actor_email?: string;
  actor_role?: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  entity_label?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  outcome: AuditOutcome;
  hash?: string;
  previous_hash: string;
}

/** Dados que um caso de uso passa a `audit.record`. */
export interface TestAuditInput {
  action: string;
  summary: string;
  actor?: { id: string; email: string; role: string };
  entity_type?: string;
  entity_id?: string;
  entity_label?: string;
  metadata?: Record<string, unknown>;
  outcome?: AuditOutcome;
}

let _counter = 1;

export class AuditEventFactory {
  /** Evento já assinado, como sai da base. */
  static build(overrides: Partial<TestAuditEvent> = {}): TestAuditEvent {
    const n = _counter++;
    return {
      id: `audit-itest-${n}`,
      company_id: 'company-itest-audit',
      seq: n,
      occurred_at: '2026-08-02T10:00:00.000Z',
      actor_id: 'user-itest-0001',
      actor_email: 'ana.admin@example.mz',
      actor_role: 'ADMIN',
      action: 'invoices.void',
      entity_type: 'invoice',
      entity_id: 'invoice-itest-0001',
      entity_label: 'FT A2026/0001',
      summary: 'ana.admin@example.mz anulou o documento FT A2026/0001',
      metadata: { reason: 'Emitida por engano' },
      outcome: AuditOutcome.SUCCESS,
      previous_hash: '0',
      ...overrides,
    };
  }

  /** Entrada de um evento de negócio, para `record`. */
  static input(overrides: Partial<TestAuditInput> = {}): TestAuditInput {
    return {
      action: 'invoices.void',
      summary: 'ana.admin@example.mz anulou o documento FT A2026/0001',
      actor: { id: 'user-itest-0001', email: 'ana.admin@example.mz', role: 'ADMIN' },
      entity_type: 'invoice',
      entity_id: 'invoice-itest-0001',
      entity_label: 'FT A2026/0001',
      metadata: { reason: 'Emitida por engano' },
      ...overrides,
    };
  }

  /** Entrada com segredos — prova que a redação os apaga. */
  static withSecrets(overrides: Partial<TestAuditInput> = {}): TestAuditInput {
    return AuditEventFactory.input({
      metadata: {
        email: 'cliente@example.mz',
        password: 'SenhaSuperSecreta1',
        token: 'eyJhbGciOiJIUzI1NiJ9.abc',
        nested: { password_hash: 'hash-do-diabo', keep: 'isto fica' },
      },
      ...overrides,
    });
  }
}

/**
 * Cadeia coerente por construção — o teste depois adultera um elo para provar
 * que a verificação apanha.
 */
export class AuditChainFactory {
  static build(sign: (event: TestAuditEvent) => string, length = 4): TestAuditEvent[] {
    const chain: TestAuditEvent[] = [];
    let previous = '0';

    for (let i = 1; i <= length; i += 1) {
      const event = AuditEventFactory.build({
        id: `audit-chain-${i}`,
        seq: i,
        occurred_at: `2026-08-02T10:0${i}:00.000Z`,
        action: i % 2 === 0 ? 'orders.create' : 'invoices.void',
        previous_hash: previous,
      });
      event.hash = sign(event);
      previous = event.hash;
      chain.push(event);
    }
    return chain;
  }
}

export { AuditOutcome };
