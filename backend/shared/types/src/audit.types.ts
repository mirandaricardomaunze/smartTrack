/**
 * @file audit.types.ts
 * @description Tipos do registo de auditoria.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * O registo é **append-only** e encadeado por empresa: cada evento assina o
 * anterior, pelo que alterar ou apagar uma linha parte a cadeia.
 */

export enum AuditOutcome {
  SUCCESS = 'success',
  /** Pedido recusado por permissão, quota ou subscrição (401/402/403). */
  DENIED = 'denied',
  ERROR = 'error',
}

export interface AuditEvent {
  id: string;
  company_id: string;
  /** Ordem dentro da empresa — buracos denunciam remoções. */
  seq: number;
  occurred_at: string;
  actor_id?: string;
  actor_email?: string;
  actor_role?: string;
  /** `orders.create`, `invoices.void`, `hr.payroll_status`… */
  action: string;
  entity_type?: string;
  entity_id?: string;
  /** Rótulo legível: código de rastreio, número da fatura, nome. */
  entity_label?: string;
  summary: string;
  /** Contexto curado; nunca corpos de pedido nem segredos. */
  metadata: Record<string, unknown>;
  outcome: AuditOutcome;
  status_code?: number;
  method?: string;
  path?: string;
  ip?: string;
  user_agent?: string;
  request_id?: string;
  duration_ms?: number;
  hash: string;
  previous_hash: string;
}

export interface AuditListResult {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditStats {
  total: number;
  denied: number;
  errors: number;
  /** Atores distintos no período. */
  actors: number;
  first_at?: string;
  last_at?: string;
  top_actions: Array<{ action: string; total: number }>;
}

export interface AuditChainIntegrity {
  company_id: string;
  ok: boolean;
  checked: number;
  broken: Array<{ id: string; seq: number; reason: string }>;
  gaps: Array<{ expected: number; found: number }>;
}

export interface AuditIntegrityReport {
  ok: boolean;
  checked_at: string;
  chains: AuditChainIntegrity[];
}

/** Contadores do próprio registo — uma falha de escrita não pode passar calada. */
export interface AuditHealth {
  recorded: number;
  failed: number;
  last_error: string | null;
  last_failure_at: string | null;
}
