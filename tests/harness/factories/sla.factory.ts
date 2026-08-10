/**
 * @file sla.factory.ts
 * @description Factory do SLA de entrega e das ocorrências.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export type IncidentKind =
  | 'recipient_absent' | 'wrong_address' | 'damage' | 'delay'
  | 'refusal' | 'loss' | 'cod_mismatch';

export type IncidentPriority = 'low' | 'normal' | 'high' | 'critical';
export type IncidentStatus = 'aberta' | 'em_curso' | 'resolvida' | 'cancelada';

/** O mínimo de uma encomenda para medir SLA. */
export interface TestSlaOrder {
  id: string;
  tracking_code: string;
  current_status: string;
  created_at: string;
  /** Momento da entrega. Ausente = ainda a caminho. */
  delivered_at?: string;
  zone_code?: string;
  service?: 'normal' | 'express';
}

export interface TestSlaZone {
  code: string;
  /** `null` = sem prazo acordado; não produz incumprimento (§ 3.42). */
  sla_hours_normal: number | null;
  sla_hours_express: number | null;
}

export interface TestIncidentInput {
  kind: IncidentKind;
  priority: IncidentPriority;
  title: string;
  description?: string;
  order_id?: string;
  tracking_code?: string;
  assignee_id?: string;
}

/** Instante de referência fixo — um SLA que depende de "agora" não se afirma. */
export const AGORA = '2026-08-09T12:00:00.000Z';

/** `hours` horas antes de AGORA, em ISO. */
function horasAntes(hours: number): string {
  return new Date(Date.parse(AGORA) - hours * 3_600_000).toISOString();
}

let contador = 1;

export class SlaFactory {
  /** Zona com 48 h no normal e 24 h no expresso. */
  static zone(overrides: Partial<TestSlaZone> = {}): TestSlaZone {
    return { code: 'MAPUTO_CITY', sla_hours_normal: 48, sla_hours_express: 24, ...overrides };
  }

  /** Zona sem prazo acordado — o estado de quem ainda não decidiu a promessa. */
  static zoneWithoutSla(): TestSlaZone {
    return { code: 'SEM_PRAZO', sla_hours_normal: null, sla_hours_express: null };
  }

  /** Entregue dentro do prazo: criada há 30 h, entregue há 6 h (24 h de trânsito). */
  static deliveredOnTime(): TestSlaOrder {
    return {
      id: `order-sla-${contador++}`, tracking_code: 'TRK-SLA-OK', current_status: 'delivered',
      created_at: horasAntes(30), delivered_at: horasAntes(6), zone_code: 'MAPUTO_CITY', service: 'normal',
    };
  }

  /** Entregue fora do prazo: 72 h de trânsito contra 48 h prometidas. */
  static deliveredLate(): TestSlaOrder {
    return {
      id: `order-sla-${contador++}`, tracking_code: 'TRK-SLA-LATE', current_status: 'delivered',
      created_at: horasAntes(80), delivered_at: horasAntes(8), zone_code: 'MAPUTO_CITY', service: 'normal',
    };
  }

  /**
   * Ainda a caminho e já fora do prazo. É a diferença entre um mapa de SLA e um
   * relatório de autópsia: está incumprida AGORA, não quando chegar.
   */
  static inTransitAlreadyLate(): TestSlaOrder {
    return {
      id: `order-sla-${contador++}`, tracking_code: 'TRK-SLA-RUNNING', current_status: 'in_transit',
      created_at: horasAntes(100), zone_code: 'MAPUTO_CITY', service: 'normal',
    };
  }

  /** Ainda a caminho e dentro do prazo — não conta para nenhum dos lados. */
  static inTransitOnTime(): TestSlaOrder {
    return {
      id: `order-sla-${contador++}`, tracking_code: 'TRK-SLA-YOUNG', current_status: 'in_transit',
      created_at: horasAntes(6), zone_code: 'MAPUTO_CITY', service: 'normal',
    };
  }

  static incident(overrides: Partial<TestIncidentInput> = {}): TestIncidentInput {
    const n = contador++;
    return {
      kind: 'damage',
      priority: 'normal',
      title: `Encomenda danificada no transporte ${n}`,
      description: 'Caixa amassada, conteúdo por verificar.',
      tracking_code: `TRK-INC-${String(n).padStart(4, '0')}`,
      ...overrides,
    };
  }

  static readonly horasAntes = horasAntes;
}
