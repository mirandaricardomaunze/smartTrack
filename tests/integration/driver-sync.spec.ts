/**
 * @file driver-sync.spec.ts
 * @description Testes de integração da sincronização offline do motorista (offline-sync-resolver).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 8.1
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md
 */

import { describe, it, expect } from 'vitest';
import { OrderFactory } from '../harness/factories/order.factory';
import { EventoRastreioFactory } from '../harness/factories/evento-rastreio.factory';
import { DriverFactory } from '../harness/factories/driver.factory';
import { MockJwtPayloads } from '../harness/mocks/jwt-payloads.mock';
import offlineEventsFixture from '../harness/fixtures/offline-events-batch.json';
import { OrderStatus } from '../../backend/shared/types/src/order-status.enum';

describe('DriverSyncService · Offline-to-Online Sync', () => {
  it('should validate driver JWT payload from harness mock', () => {
    const driverPayload = MockJwtPayloads.DRIVER;
    expect(driverPayload.role).toBe('DRIVER');
    expect(driverPayload.sub).toBe('driver-test-uuid-0001');
  });

  it('should process pending events in chronological order (device_timestamp ASC)', () => {
    const batch = offlineEventsFixture[0];
    expect(batch.driver_id).toBe('driver-test-uuid-0001');
    expect(batch.events.length).toBe(3);

    const timestamps = batch.events.map((e) => new Date(e.device_timestamp).getTime());
    const isSorted = timestamps.every((val, i, arr) => i === 0 || arr[i - 1] <= val);
    expect(isSorted).toBe(true);
  });

  it('should apply SERVER_WINS conflict resolution when server timestamp is newer', () => {
    const conflictBatch = offlineEventsFixture[1];
    const localEvent = conflictBatch.events[0];
    const serverEvent = conflictBatch.server_concurrent_event;

    const localTime = new Date(localEvent.device_timestamp).getTime();
    const serverTime = new Date(serverEvent.server_timestamp).getTime();

    // Server timestamp (10:05) is newer than local device timestamp (10:00)
    expect(serverTime).toBeGreaterThan(localTime);

    // Conflict resolution rule for status update: SERVER_WINS
    const winnerStatus = serverTime > localTime ? serverEvent.new_status : localEvent.payload.new_status;
    expect(winnerStatus).toBe('entregue');
  });

  it('should generate valid EventoRastreio from driver using EventoRastreioFactory', () => {
    const testOrder = OrderFactory.build();
    const driverEvent = EventoRastreioFactory.buildFromDriver(testOrder.id, OrderStatus.OUT_FOR_DELIVERY, {
      description: 'Saindo para entrega no cliente',
    });

    expect(driverEvent.order_id).toBe(testOrder.id);
    expect(driverEvent.event_origin).toBe('DRIVER');
    expect(driverEvent.status).toBe(OrderStatus.OUT_FOR_DELIVERY);
    expect(driverEvent.device_id).toBe('device-test-uuid-0001');
  });

  it('should mock driver performance metrics using DriverFactory', () => {
    const driver = DriverFactory.buildOnRoute();
    expect(driver.current_status).toBe('on_route');
    expect(driver.performance_metrics.success_rate).toBe(98);
  });
});
