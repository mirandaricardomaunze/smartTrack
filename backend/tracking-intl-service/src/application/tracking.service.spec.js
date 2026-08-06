/**
 * @file tracking.service.spec.js
 * @description Testes do fluxo de polling.
 *
 * O repositório é substituído por um fake em memória via `configurePorts`; a
 * transportadora simulada já é determinística. O que se prova aqui é a
 * propriedade que interessa: **consultar duas vezes não duplica o histórico**.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const service = require('./tracking.service.js');

const {
  trackShipment,
  getTracking,
  pollShipment,
  runPollingCycle,
  configurePorts,
  resetPorts,
  MissingRequiredFieldError,
  TrackingNotFoundError,
} = service;

// ─── Fakes ────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} event_hash → evento */
const eventos = new Map();
/** @type {Map<string, object>} tracking_code → shipment */
const shipments = new Map();

const fakeRepo = {
  async findByCode(code) {
    return [...eventos.values()]
      .filter((e) => e.tracking_code === code)
      .sort((a, b) => new Date(b.carrier_timestamp) - new Date(a.carrier_timestamp));
  },
  async insertMany(lote) {
    const inseridos = [];
    for (const e of lote) {
      if (eventos.has(e.event_hash)) continue; // ON CONFLICT DO NOTHING
      eventos.set(e.event_hash, { ...e });
      inseridos.push({ ...e });
    }
    return inseridos;
  },
  async findCodesToPoll(limite = 100) {
    return [...shipments.values()]
      .filter((s) => s.active)
      .slice(0, limite)
      .map((s) => ({ tracking_code: s.tracking_code, carrier: s.carrier }));
  },
  async trackShipment(dto) {
    const s = { ...dto, active: true, last_polled_at: null };
    shipments.set(dto.tracking_code, s);
    return s;
  },
  async markPolled(code, finalizado) {
    const s = shipments.get(code);
    if (s) {
      s.last_polled_at = new Date().toISOString();
      s.active = !finalizado;
    }
  },
  async getStats() {
    return { events: eventos.size, active_shipments: 0, finished_shipments: 0, carriers: 0 };
  },
};

beforeEach(() => {
  eventos.clear();
  shipments.clear();
  resetPorts();
  configurePorts({ repo: fakeRepo });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ─── Registo ──────────────────────────────────────────────────────────────────

describe('trackShipment', () => {
  it('should register a code for polling and normalise it to upper case', async () => {
    const s = await trackShipment({ tracking_code: 'lx987654321cn', carrier: '17TRACK' });

    expect(s.tracking_code).toBe('LX987654321CN');
    expect(s.active).toBe(true);
  });

  it('should reject an unknown carrier', async () => {
    await expect(trackShipment({ tracking_code: 'X1', carrier: 'INVENTADA' }))
      .rejects.toThrow(MissingRequiredFieldError);
  });

  it('should require the mandatory fields', async () => {
    await expect(trackShipment({ carrier: '17TRACK' })).rejects.toThrow(MissingRequiredFieldError);
    await expect(trackShipment({ tracking_code: 'X1' })).rejects.toThrow(MissingRequiredFieldError);
  });
});

// ─── Polling ──────────────────────────────────────────────────────────────────

describe('pollShipment', () => {
  it('should fetch, normalize and persist new events', async () => {
    const r = await pollShipment({ tracking_code: 'LX000000004CN', carrier: '17TRACK' });

    expect(r.polled).toBe(true);
    expect(r.new_events).toBe(4);
    // O percurso do 17TRACK termina em "Out for Delivery"
    expect(r.current_status).toBe('out_for_delivery');
  });

  it('should not duplicate events when polled twice', async () => {
    // A propriedade central: o polling relê o histórico completo a cada ciclo
    const primeira = await pollShipment({ tracking_code: 'LX000000004CN', carrier: '17TRACK' });
    const segunda  = await pollShipment({ tracking_code: 'LX000000004CN', carrier: '17TRACK' });

    expect(primeira.new_events).toBe(4);
    expect(segunda.new_events).toBe(0);
    expect(eventos.size).toBe(4);
  });

  it('should only persist the newly appeared events', async () => {
    // Códigos diferentes devolvem percursos de comprimento diferente,
    // mas o mesmo código com mais eventos só acrescenta os novos.
    await pollShipment({ tracking_code: 'LX000000002CN', carrier: '17TRACK' });
    expect(eventos.size).toBe(2);
  });

  it('should store the canonical status, not the raw carrier string', async () => {
    await pollShipment({ tracking_code: 'LX000000001CN', carrier: '17TRACK' });

    const [evento] = [...eventos.values()];
    expect(evento.status).toBe('collected');   // canônico
    expect(evento.raw_status).toBe('Picked up'); // cru, para auditoria
  });

  it('should deactivate the shipment once it reaches a final state', async () => {
    await trackShipment({ tracking_code: 'CN000000003XX', carrier: 'CAINIAO' });
    const r = await pollShipment({ tracking_code: 'CN000000003XX', carrier: 'CAINIAO' });

    // O percurso CAINIAO de 3 eventos termina em SIGN_IN → delivered
    expect(r.current_status).toBe('delivered');
    expect(r.finished).toBe(true);
    expect(shipments.get('CN000000003XX').active).toBe(false);
  });

  it('should not mark as polled when the carrier API fails', async () => {
    await trackShipment({ tracking_code: 'LX1CN', carrier: '17TRACK' });
    shipments.get('LX1CN').last_polled_at = null;

    const r = await pollShipment({ tracking_code: 'LX1CN-ERR', carrier: '17TRACK' });

    // Falha da transportadora não é nossa — o próximo ciclo tem de tentar de novo
    expect(r.polled).toBe(false);
    expect(r.new_events).toBe(0);
    expect(eventos.size).toBe(0);
  });

  it('should handle a code with no events yet', async () => {
    const r = await pollShipment({ tracking_code: 'LX1CN-EMPTY', carrier: '17TRACK' });

    expect(r.polled).toBe(true);
    expect(r.new_events).toBe(0);
    expect(r.current_status).toBeNull();
  });
});

// ─── Ciclo completo ───────────────────────────────────────────────────────────

describe('runPollingCycle', () => {
  it('should poll every active shipment', async () => {
    await trackShipment({ tracking_code: 'LX000000002CN', carrier: '17TRACK' });
    await trackShipment({ tracking_code: 'CN000000002XX', carrier: 'CAINIAO' });

    const r = await runPollingCycle();

    expect(r.checked).toBe(2);
    expect(r.new_events).toBe(4); // 2 de cada
    expect(r.failures).toBe(0);
  });

  it('should count a carrier failure without aborting the cycle', async () => {
    await trackShipment({ tracking_code: 'LX000000002CN', carrier: '17TRACK' });
    await trackShipment({ tracking_code: 'LX2CN-ERR', carrier: '17TRACK' });

    const r = await runPollingCycle();

    expect(r.checked).toBe(2);
    expect(r.failures).toBe(1);
    // O código saudável foi processado apesar da falha do outro
    expect(r.new_events).toBe(2);
  });

  it('should skip shipments already finished', async () => {
    await trackShipment({ tracking_code: 'CN000000003XX', carrier: 'CAINIAO' });
    await runPollingCycle();

    // Ficou entregue no primeiro ciclo — não volta a ser consultado
    const segundo = await runPollingCycle();
    expect(segundo.checked).toBe(0);
  });
});

// ─── Consulta ─────────────────────────────────────────────────────────────────

describe('getTracking', () => {
  it('should return the history newest first with the current status', async () => {
    await pollShipment({ tracking_code: 'LX000000004CN', carrier: '17TRACK' });

    const t = await getTracking('lx000000004cn');

    expect(t.tracking_code).toBe('LX000000004CN');
    expect(t.current_status).toBe('out_for_delivery');
    expect(t.events).toHaveLength(4);
    expect(new Date(t.events[0].carrier_timestamp).getTime())
      .toBeGreaterThan(new Date(t.events[3].carrier_timestamp).getTime());
  });

  it('should throw when the code was never tracked', async () => {
    await expect(getTracking('NAO-EXISTE')).rejects.toThrow(TrackingNotFoundError);
  });
});
