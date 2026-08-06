/**
 * @file track17.client.spec.js
 * @description Testes do cliente REAL 17TRACK com `fetch` mockado.
 *
 * Prova o parsing da resposta v2.2 (events → leituras cruas), o fluxo
 * register→retry para números ainda não registados, e os caminhos de erro
 * (sem key, HTTP não-2xx, falha de rede). Não faz chamadas reais.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Track17Client, Track17NotConfiguredError } = require('./track17.client.js');

/** Resposta gettrackinfo com 2 eventos. */
function trackInfoResponse(number) {
  return {
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        accepted: [{
          number,
          track_info: {
            tracking: {
              providers: [{
                provider: { name: 'China Post' },
                events: [
                  { time_iso: '2026-05-02T10:00:00+08:00', stage: 'InTransit',  description: 'Departed facility', location: 'Hong Kong' },
                  { time_iso: '2026-05-01T09:00:00+08:00', stage: 'PickedUp',   description: 'Item accepted',    location: 'Shenzhen' },
                ],
              }],
            },
          },
        }],
        rejected: [],
      },
    }),
  };
}

function rejectedResponse(number) {
  return {
    status: 200,
    json: async () => ({ code: 0, data: { accepted: [], rejected: [{ number, error: { code: -18019902, message: 'not registered' } }] } }),
  };
}

function okRegisterResponse(number) {
  return { status: 200, json: async () => ({ code: 0, data: { accepted: [{ number }], rejected: [] } }) };
}

describe('Track17Client (real, fetch mockado)', () => {
  beforeEach(() => { process.env.TRACK17_API_KEY = 'test-key'; });
  afterEach(() => { delete process.env.TRACK17_API_KEY; vi.restoreAllMocks(); });

  it('should parse gettrackinfo events into raw carrier readings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => trackInfoResponse('RR123456789CN')));

    const r = await Track17Client.fetchEvents('17TRACK', 'RR123456789CN');

    expect(r.httpCode).toBe(200);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ raw_status: 'InTransit', location: 'Hong Kong', description: 'Departed facility' });
    expect(r.events[0].carrier_timestamp).toBe('2026-05-02T10:00:00+08:00');
    expect(r.events[1].raw_status).toBe('PickedUp');
  });

  it('should register then retry when the number is not yet registered', async () => {
    const number = 'LX999888777CN';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejectedResponse(number)) // 1º gettrackinfo → rejeitado
      .mockResolvedValueOnce(okRegisterResponse(number)) // register
      .mockResolvedValueOnce(trackInfoResponse(number)); // 2º gettrackinfo → aceite
    vi.stubGlobal('fetch', fetchMock);

    const r = await Track17Client.fetchEvents('17TRACK', number);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain('/register');
    expect(r.httpCode).toBe(200);
    expect(r.events).toHaveLength(2);
  });

  it('should send the API key in the 17token header', async () => {
    const fetchMock = vi.fn(async () => trackInfoResponse('RR1'));
    vi.stubGlobal('fetch', fetchMock);

    await Track17Client.fetchEvents('17TRACK', 'RR1');

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['17token']).toBe('test-key');
  });

  it('should treat a non-2xx HTTP status as a carrier failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 429, json: async () => ({}) })));

    const r = await Track17Client.fetchEvents('17TRACK', 'RR1');
    expect(r.httpCode).toBe(429);
    expect(r.events).toHaveLength(0);
  });

  it('should treat a network error as carrier unavailable (503)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const r = await Track17Client.fetchEvents('17TRACK', 'RR1');
    expect(r.httpCode).toBe(503);
  });

  it('should throw when no API key is configured', async () => {
    delete process.env.TRACK17_API_KEY;
    vi.stubGlobal('fetch', vi.fn());

    await expect(Track17Client.fetchEvents('17TRACK', 'RR1')).rejects.toBeInstanceOf(Track17NotConfiguredError);
  });
});
