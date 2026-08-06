/**
 * @file tracking.factory.ts
 * @description Test factory para o rastreio internacional (envios e eventos).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.10, § 8.3, § 6
 *
 * Alinhado com os contratos do tracking-intl-service:
 *   - listShipments()  → TestTrackedShipment
 *   - tracking_events  → TestIntlTrackingEvent
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { OrderStatus } from '../../../backend/shared/types/src/order-status.enum';

/** Transportadoras com mapeamento conhecido (StatusMapper). */
export type IntlCarrier = '17TRACK' | 'CAINIAO' | 'CORREIOS_BR';

export interface TestTrackedShipment {
  tracking_code: string;
  carrier: IntlCarrier;
  active: boolean;
  last_polled_at: string | null;
  current_status: OrderStatus | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

export interface TestIntlTrackingEvent {
  id: string;
  tracking_code: string;
  carrier: IntlCarrier;
  status: OrderStatus;
  raw_status: string;
  location: string | null;
  description: string | null;
  carrier_timestamp: string;
  event_hash: string;
  created_at: string;
}

let _counter = 1;
let _evtCounter = 1;

export class TrackedShipmentFactory {
  static build(overrides: Partial<TestTrackedShipment> = {}): TestTrackedShipment {
    const n = _counter++;
    const now = new Date().toISOString();
    return {
      tracking_code:  `LX${String(n).padStart(9, '0')}CN`,
      carrier:        '17TRACK',
      active:         true,
      last_polled_at: null,
      current_status: null,
      event_count:    0,
      created_at:     now,
      updated_at:     now,
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestTrackedShipment> = {}): TestTrackedShipment[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  /** Envio já finalizado (estado final atingido → deixa de ser consultado). */
  static buildFinished(overrides: Partial<TestTrackedShipment> = {}): TestTrackedShipment {
    return this.build({ active: false, current_status: OrderStatus.DELIVERED, event_count: 3, ...overrides });
  }

  /** Código que o simulador trata como falha da API da transportadora. */
  static buildErrCode(overrides: Partial<TestTrackedShipment> = {}): TestTrackedShipment {
    const base = this.build(overrides);
    return { ...base, tracking_code: `${base.tracking_code}-ERR` };
  }

  /** Código que o simulador trata como "sem eventos ainda". */
  static buildEmptyCode(overrides: Partial<TestTrackedShipment> = {}): TestTrackedShipment {
    const base = this.build(overrides);
    return { ...base, tracking_code: `${base.tracking_code}-EMPTY` };
  }
}

export class IntlTrackingEventFactory {
  static build(overrides: Partial<TestIntlTrackingEvent> = {}): TestIntlTrackingEvent {
    const n = _evtCounter++;
    const ts = new Date(Date.parse('2026-07-01T08:00:00.000Z') + n * 86_400_000).toISOString();
    return {
      id:                `trk-test-${n.toString().padStart(4, '0')}`,
      tracking_code:     `LX${String(n).padStart(9, '0')}CN`,
      carrier:           '17TRACK',
      status:            OrderStatus.IN_TRANSIT,
      raw_status:        'In Transit',
      location:          'Hong Kong',
      description:       'Em trânsito internacional',
      carrier_timestamp: ts,
      event_hash:        `hash-test-${n.toString().padStart(4, '0')}`,
      created_at:        ts,
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestIntlTrackingEvent> = {}): TestIntlTrackingEvent[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }
}
