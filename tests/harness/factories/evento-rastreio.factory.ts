/**
 * @file evento-rastreio.factory.ts
 * @description Factory de EventoRastreio para testes (em Inglês).
 */
import { OrderStatus } from '../../../backend/shared/types/src/order-status.enum';

export type EventOrigin = 'DRIVER' | 'SYSTEM' | 'CARRIER_INTL' | 'ADMIN';

export interface GeoPoint {
  lat: number;
  lng: number;
  accuracy_meters?: number;
}

export interface TestTrackingEvent {
  id:               string;
  order_id:         string;
  status:           OrderStatus;
  location?:        GeoPoint;
  description?:     string;
  event_origin:     EventOrigin;
  user_id?:         string;
  device_id?:       string;
  device_timestamp?: string; // ISO8601 UTC
  timestamp:        string;  // ISO8601 UTC
}

let _counter = 1;

export class EventoRastreioFactory {
  static build(overrides: Partial<TestTrackingEvent> = {}): TestTrackingEvent {
    const n = _counter++;
    return {
      id:            `event-test-uuid-${n.toString().padStart(4, '0')}`,
      order_id:     `order-test-uuid-0001`,
      status:        OrderStatus.CREATED,
      description:     'Order registered in the system',
      event_origin: 'SYSTEM',
      timestamp:     new Date().toISOString(),
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestTrackingEvent> = {}): TestTrackingEvent[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  static buildFromDriver(
    order_id: string,
    status: OrderStatus,
    opts: Partial<TestTrackingEvent> = {},
  ): TestTrackingEvent {
    return this.build({
      order_id,
      status,
      event_origin:    'DRIVER',
      device_id:        opts.device_id ?? 'device-test-uuid-0001',
      device_timestamp: opts.device_timestamp ?? new Date().toISOString(),
      user_id:       opts.user_id ?? 'driver-test-uuid-0001',
      ...opts,
    });
  }

  static buildFromCarrier(order_id: string, status: OrderStatus): TestTrackingEvent {
    return this.build({
      order_id,
      status,
      event_origin: 'CARRIER_INTL',
      description:     `Status mapped by StatusMapper: ${status}`,
    });
  }

  static buildWithGeo(
    order_id: string,
    status: OrderStatus,
    geo: GeoPoint,
  ): TestTrackingEvent {
    return this.build({ order_id, status, location: geo, event_origin: 'DRIVER' });
  }

  static buildTimeline(order_id: string): TestTrackingEvent[] {
    const base = Date.now();
    const at = (offsetMs: number): string => new Date(base - offsetMs).toISOString();

    return [
      this.build({ order_id, status: OrderStatus.CREATED,          event_origin: 'SYSTEM',    timestamp: at(7 * 3600000), description: 'Order registered in system' }),
      this.build({ order_id, status: OrderStatus.COLLECTED,         event_origin: 'DRIVER',  timestamp: at(5 * 3600000), description: 'Package collected at sender' }),
      this.build({ order_id, status: OrderStatus.IN_TRANSIT,        event_origin: 'SYSTEM',    timestamp: at(4 * 3600000), description: 'Transferring between hubs' }),
      this.build({ order_id, status: OrderStatus.OUT_FOR_DELIVERY,  event_origin: 'DRIVER',  timestamp: at(2 * 3600000), description: 'Out for delivery to recipient' }),
      this.build({ order_id, status: OrderStatus.DELIVERED,         event_origin: 'DRIVER',  timestamp: at(1 * 3600000), description: 'Delivered successfully' }),
    ];
  }

  static buildFailedDelivery(order_id: string): TestTrackingEvent {
    return this.buildFromDriver(order_id, OrderStatus.FAILED, {
      description: 'Recipient absent — unsuccessful delivery attempt',
    });
  }
}
