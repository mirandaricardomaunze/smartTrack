/**
 * @file sync-event.spec.js
 * @description Testes da validação e normalização de eventos de sync.
 *
 * Usa o fixture `offline-events-batch.json` do harness para garantir que o
 * vocabulário pt-BR que o app do motorista envia é traduzido corretamente.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import offlineBatches from '../../../../tests/harness/fixtures/offline-events-batch.json';

const require = createRequire(import.meta.url);
const {
  OrderStatus,
  toCanonicalStatus,
  buildDedupeKey,
  validateSyncEvent,
  sortChronological,
  MissingRequiredFieldError,
} = require('./sync-event.js');

describe('toCanonicalStatus', () => {
  it('should translate every pt-BR status found in the harness fixture', () => {
    // Recolhe todos os new_status do fixture e confirma que traduzem
    const statuses = offlineBatches
      .flatMap((b) => b.events)
      .filter((e) => e.event_type === 'STATUS_UPDATE')
      .map((e) => e.payload.new_status);

    for (const s of statuses) {
      expect(toCanonicalStatus(s)).not.toBeNull();
    }
  });

  it('should map the known pt-BR vocabulary', () => {
    expect(toCanonicalStatus('coletado')).toBe(OrderStatus.COLLECTED);
    expect(toCanonicalStatus('saiu_para_entrega')).toBe(OrderStatus.OUT_FOR_DELIVERY);
    expect(toCanonicalStatus('insucesso')).toBe(OrderStatus.FAILED);
    expect(toCanonicalStatus('entregue')).toBe(OrderStatus.DELIVERED);
  });

  it('should pass through an already-canonical status (idempotent)', () => {
    expect(toCanonicalStatus('delivered')).toBe(OrderStatus.DELIVERED);
  });

  it('should return null for an unrecognised status', () => {
    expect(toCanonicalStatus('talvez')).toBeNull();
    expect(toCanonicalStatus('')).toBeNull();
    expect(toCanonicalStatus(undefined)).toBeNull();
  });
});

describe('buildDedupeKey', () => {
  it('should be deterministic — the same event yields the same key', () => {
    const evt = offlineBatches[0].events[0];
    expect(buildDedupeKey(evt)).toBe(buildDedupeKey(evt));
  });

  it('should differ across events of the same batch', () => {
    const [a, b] = offlineBatches[0].events;
    expect(buildDedupeKey(a)).not.toBe(buildDedupeKey(b));
  });

  it('should differ when the device_timestamp differs', () => {
    const base = offlineBatches[0].events[0];
    const outro = { ...base, device_timestamp: '2099-01-01T00:00:00.000Z' };
    expect(buildDedupeKey(base)).not.toBe(buildDedupeKey(outro));
  });
});

describe('validateSyncEvent', () => {
  it('should accept every event in the harness fixture', () => {
    offlineBatches.flatMap((b) => b.events).forEach((evt, i) => {
      expect(() => validateSyncEvent(evt, i)).not.toThrow();
    });
  });

  it('should require order_id, event_type and device_timestamp', () => {
    expect(() => validateSyncEvent({ event_type: 'X', device_timestamp: 't' }, 0)).toThrow(MissingRequiredFieldError);
    expect(() => validateSyncEvent({ order_id: 'o', device_timestamp: 't' }, 0)).toThrow(MissingRequiredFieldError);
    expect(() => validateSyncEvent({ order_id: 'o', event_type: 'X' }, 0)).toThrow(MissingRequiredFieldError);
  });
});

describe('sortChronological', () => {
  it('should order events by device_timestamp ascending', () => {
    // O primeiro lote do fixture já vem em ordem — baralhar e reordenar
    const eventos = [...offlineBatches[0].events].reverse();
    const ordenados = sortChronological(eventos);

    const ts = ordenados.map((e) => e.device_timestamp);
    const crescente = [...ts].sort((a, b) => Date.parse(a) - Date.parse(b));
    expect(ts).toEqual(crescente);
  });

  it('should be stable for equal timestamps', () => {
    const t = '2026-07-01T10:00:00.000Z';
    const eventos = [
      { order_id: 'o', event_type: 'LOCATION', device_timestamp: t, id: 'primeiro' },
      { order_id: 'o', event_type: 'LOCATION', device_timestamp: t, id: 'segundo' },
    ];

    expect(sortChronological(eventos).map((e) => e.id)).toEqual(['primeiro', 'segundo']);
  });

  it('should not mutate the input', () => {
    const eventos = [...offlineBatches[0].events];
    const ids = eventos.map((e) => e.id);
    sortChronological(eventos);
    expect(eventos.map((e) => e.id)).toEqual(ids);
  });
});
