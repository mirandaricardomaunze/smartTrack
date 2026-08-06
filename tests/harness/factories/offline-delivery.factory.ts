import { MockJwtPayloads } from '../mocks/jwt-payloads.mock';
import { DeliveryFailureFactory, PodFactory } from './pod.factory';
import { OrderFactory } from './order.factory';

let counter = 1;

export class OfflineDeliveryFactory {
  static delivered() {
    const sequence = counter++;
    const order = OrderFactory.buildOutForDelivery({ driver_id: MockJwtPayloads.DRIVER.sub });
    const pod = PodFactory.buildSignatureOnly();
    return {
      order,
      batch: {
        driver_id: MockJwtPayloads.DRIVER.sub,
        sync_session_id: `sync-pod-test-${sequence}`,
        events: [{
          order_id: order.id,
          event_type: 'STATUS_UPDATE',
          payload: { new_status: 'entregue', recipient_name: pod.recipient_name, signature: pod.signature, notes: pod.notes, lat: pod.coords?.lat, lng: pod.coords?.lng },
          device_timestamp: pod.captured_at,
          device_id: `device-test-uuid-${String(sequence).padStart(4, '0')}`,
          correlation_id: `correlation-pod-test-${sequence}`,
        }],
      },
    };
  }

  static failed() {
    const sequence = counter++;
    const order = OrderFactory.buildOutForDelivery({ driver_id: MockJwtPayloads.DRIVER.sub });
    const failure = DeliveryFailureFactory.build();
    return {
      order,
      batch: {
        driver_id: MockJwtPayloads.DRIVER.sub,
        sync_session_id: `sync-failure-test-${sequence}`,
        events: [{
          order_id: order.id,
          event_type: 'STATUS_UPDATE',
          payload: { new_status: 'insucesso', reason: failure.reason, notes: failure.notes },
          device_timestamp: failure.captured_at,
          device_id: `device-test-uuid-${String(sequence).padStart(4, '0')}`,
          correlation_id: `correlation-failure-test-${sequence}`,
        }],
      },
    };
  }
}
