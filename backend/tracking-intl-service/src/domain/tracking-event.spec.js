/**
 * @file tracking-event.spec.js
 * @description Testes da entidade EventoRastreio.
 *
 * Usa a fixture `carrier-status-samples.json` do harness para garantir que a
 * normalização aplicada na criação do evento é a mesma que o StatusMapper
 * promete — se as duas divergirem, o histórico do cliente fica errado.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import carrierSamples from '../../../../tests/harness/fixtures/carrier-status-samples.json';

const require = createRequire(import.meta.url);
const {
  buildEventHash,
  createTrackingEvent,
  dedupeBatch,
  sortNewestFirst,
  currentStatus,
  MissingRequiredFieldError,
} = require('./tracking-event.js');

/** Leitura crua base. */
function raw(overrides = {}) {
  return {
    tracking_code:     'LX987654321CN',
    carrier:           '17TRACK',
    raw_status:        'In Transit',
    carrier_timestamp: '2026-07-01T08:00:00.000Z',
    location:          'Hong Kong',
    ...overrides,
  };
}

describe('buildEventHash', () => {
  it('should be deterministic for identical readings', () => {
    expect(buildEventHash(raw())).toBe(buildEventHash(raw()));
  });

  it('should differ when the carrier timestamp differs', () => {
    // Mesmo status em momentos diferentes são acontecimentos distintos
    const a = buildEventHash(raw());
    const b = buildEventHash(raw({ carrier_timestamp: '2026-07-02T08:00:00.000Z' }));

    expect(a).not.toBe(b);
  });

  it('should differ when the location differs', () => {
    expect(buildEventHash(raw())).not.toBe(buildEventHash(raw({ location: 'Maputo' })));
  });

  it('should differ across tracking codes', () => {
    expect(buildEventHash(raw())).not.toBe(buildEventHash(raw({ tracking_code: 'OUTRO123BR' })));
  });
});

describe('createTrackingEvent', () => {
  it('should normalize the status through the StatusMapper', () => {
    const e = createTrackingEvent('trk-1', raw({ raw_status: 'Delivered' }));

    expect(e.status).toBe('delivered');
  });

  it('should preserve the raw carrier value for auditing', () => {
    const e = createTrackingEvent('trk-1', raw({ raw_status: 'Delivered' }));

    // Sem isto não há como descobrir um mapeamento errado depois
    expect(e.raw_status).toBe('Delivered');
  });

  it('should match the StatusMapper for every harness sample', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const { carrier, raw_status, expected_canonical } of carrierSamples) {
      const e = createTrackingEvent('trk-x', raw({ carrier, raw_status }));
      expect(e.status).toBe(expected_canonical);
    }
  });

  it('should require the mandatory fields', () => {
    expect(() => createTrackingEvent('t', raw({ tracking_code: undefined })))
      .toThrow(MissingRequiredFieldError);
    expect(() => createTrackingEvent('t', raw({ carrier: undefined })))
      .toThrow(MissingRequiredFieldError);
    expect(() => createTrackingEvent('t', raw({ raw_status: undefined })))
      .toThrow(MissingRequiredFieldError);
    expect(() => createTrackingEvent('t', raw({ carrier_timestamp: undefined })))
      .toThrow(MissingRequiredFieldError);
  });

  it('should default optional fields to null', () => {
    const e = createTrackingEvent('trk-1', raw({ location: undefined, description: undefined }));

    expect(e.location).toBeNull();
    expect(e.description).toBeNull();
  });
});

describe('dedupeBatch', () => {
  it('should drop repeated readings', () => {
    // O polling devolve o histórico completo a cada ciclo
    const eventos = [
      createTrackingEvent('a', raw()),
      createTrackingEvent('b', raw()),
      createTrackingEvent('c', raw({ carrier_timestamp: '2026-07-02T08:00:00.000Z' })),
    ];

    expect(dedupeBatch(eventos)).toHaveLength(2);
  });

  it('should preserve arrival order', () => {
    const eventos = [
      createTrackingEvent('a', raw({ raw_status: 'Picked up' })),
      createTrackingEvent('b', raw({ raw_status: 'In Transit' })),
    ];

    expect(dedupeBatch(eventos).map((e) => e.raw_status)).toEqual(['Picked up', 'In Transit']);
  });

  it('should handle an empty batch', () => {
    expect(dedupeBatch([])).toEqual([]);
  });
});

describe('sortNewestFirst', () => {
  it('should order by carrier timestamp descending', () => {
    const eventos = [
      createTrackingEvent('a', raw({ carrier_timestamp: '2026-07-01T08:00:00.000Z' })),
      createTrackingEvent('c', raw({ carrier_timestamp: '2026-07-03T08:00:00.000Z' })),
      createTrackingEvent('b', raw({ carrier_timestamp: '2026-07-02T08:00:00.000Z' })),
    ];

    expect(sortNewestFirst(eventos).map((e) => e.carrier_timestamp)).toEqual([
      '2026-07-03T08:00:00.000Z',
      '2026-07-02T08:00:00.000Z',
      '2026-07-01T08:00:00.000Z',
    ]);
  });

  it('should not mutate the input', () => {
    const eventos = [
      createTrackingEvent('a', raw({ carrier_timestamp: '2026-07-01T08:00:00.000Z' })),
      createTrackingEvent('b', raw({ carrier_timestamp: '2026-07-03T08:00:00.000Z' })),
    ];
    const original = eventos.map((e) => e.id);

    sortNewestFirst(eventos);

    expect(eventos.map((e) => e.id)).toEqual(original);
  });
});

describe('currentStatus', () => {
  it('should take the status of the newest carrier event', () => {
    const eventos = [
      createTrackingEvent('a', raw({ raw_status: 'Picked up',  carrier_timestamp: '2026-07-01T08:00:00.000Z' })),
      createTrackingEvent('b', raw({ raw_status: 'Delivered',  carrier_timestamp: '2026-07-03T08:00:00.000Z' })),
      createTrackingEvent('c', raw({ raw_status: 'In Transit', carrier_timestamp: '2026-07-02T08:00:00.000Z' })),
    ];

    // Não é o último do array — é o mais recente da transportadora
    expect(currentStatus(eventos)).toBe('delivered');
  });

  it('should return null when there are no events', () => {
    expect(currentStatus([])).toBeNull();
    expect(currentStatus(undefined)).toBeNull();
  });
});
