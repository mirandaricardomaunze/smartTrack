/**
 * @file conflict-resolver.spec.js
 * @description Testes da resolução de conflitos de sync offline.
 *
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md § Conflict Resolution Rules
 *
 * Cada regra da tabela da skill tem o seu teste. É aqui que um erro perde a
 * atualização de um motorista ou desfaz o estado autoritativo do servidor.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EventType,
  Resolution,
  resolveConflict,
  isConflict,
} = require('./conflict-resolver.js');

/** Evento local base (STATUS_UPDATE). */
function local(overrides = {}) {
  return {
    order_id:         'order-1',
    event_type:       EventType.STATUS_UPDATE,
    payload:          { new_status: 'out_for_delivery' },
    device_timestamp: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Evento do servidor base. */
function server(overrides = {}) {
  return {
    order_id:         'order-1',
    event_type:       EventType.STATUS_UPDATE,
    new_status:       'in_transit',
    server_timestamp: '2026-07-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('resolveConflict — sem concorrência', () => {
  it('should apply when there is no server event', () => {
    const d = resolveConflict(local(), null);

    expect(d.resolution).toBe(Resolution.NO_CONFLICT);
    expect(d.apply).toBe(true);
    expect(isConflict(d)).toBe(false);
  });
});

describe('resolveConflict — STATUS_UPDATE por timestamp', () => {
  it('should let the local event win when it is newer', () => {
    // local 10:00 > server 09:00
    const d = resolveConflict(local(), server());

    expect(d.resolution).toBe(Resolution.LOCAL_WINS);
    expect(d.apply).toBe(true);
  });

  it('should let the server win when it is newer', () => {
    const d = resolveConflict(
      local({ device_timestamp: '2026-07-01T08:00:00.000Z' }),
      server({ server_timestamp: '2026-07-01T09:00:00.000Z' }),
    );

    expect(d.resolution).toBe(Resolution.SERVER_WINS);
    expect(d.apply).toBe(false);
  });

  it('should let the server win on an exact tie', () => {
    const d = resolveConflict(
      local({ device_timestamp: '2026-07-01T09:00:00.000Z' }),
      server({ server_timestamp: '2026-07-01T09:00:00.000Z' }),
    );

    // Empate favorece o autoritativo
    expect(d.resolution).toBe(Resolution.SERVER_WINS);
  });

  it('should let the server win when the local timestamp is invalid', () => {
    const d = resolveConflict(local({ device_timestamp: 'não-é-data' }), server());

    expect(d.resolution).toBe(Resolution.SERVER_WINS);
    expect(d.apply).toBe(false);
  });
});

describe('resolveConflict — entrega é autoritativa no servidor', () => {
  it('should never override a server-confirmed delivery, even if local is newer', () => {
    // Regra especial da skill: dois DELIVERED → SERVER_WINS
    const d = resolveConflict(
      local({ device_timestamp: '2026-07-01T23:59:00.000Z' }),
      server({ new_status: 'delivered', server_timestamp: '2026-07-01T09:00:00.000Z' }),
    );

    expect(d.resolution).toBe(Resolution.SERVER_WINS);
    expect(d.apply).toBe(false);
    expect(d.reason).toMatch(/entrega/i);
  });
});

describe('resolveConflict — LOCATION', () => {
  it('should always prefer the local GPS reading', () => {
    const d = resolveConflict(
      local({ event_type: EventType.LOCATION, device_timestamp: '2026-07-01T08:00:00.000Z' }),
      server({ event_type: EventType.LOCATION, server_timestamp: '2026-07-01T23:00:00.000Z' }),
    );

    // A leitura mais recente é sempre a melhor, mesmo com o servidor "mais novo"
    expect(d.resolution).toBe(Resolution.LOCAL_WINS);
    expect(d.apply).toBe(true);
  });
});

describe('resolveConflict — PHOTO / SIGNATURE', () => {
  it('should keep both photo captures', () => {
    const d = resolveConflict(local({ event_type: EventType.PHOTO_CAPTURE }), server());

    expect(d.resolution).toBe(Resolution.KEEP_BOTH);
    expect(d.apply).toBe(true);
  });

  it('should keep both signatures', () => {
    const d = resolveConflict(local({ event_type: EventType.SIGNATURE }), server());

    expect(d.resolution).toBe(Resolution.KEEP_BOTH);
    expect(d.apply).toBe(true);
  });
});

describe('resolveConflict — tipo desconhecido', () => {
  it('should not apply and should not be silent', () => {
    const d = resolveConflict(local({ event_type: 'INVENTADO' }), server());

    expect(d.apply).toBe(false);
    // Nunca descartar em silêncio — há sempre motivo
    expect(d.reason.length).toBeGreaterThan(0);
    expect(isConflict(d)).toBe(true);
  });
});

describe('isConflict', () => {
  it('should treat NO_CONFLICT as not a conflict', () => {
    expect(isConflict({ resolution: Resolution.NO_CONFLICT })).toBe(false);
  });

  it('should treat every other resolution as a conflict to log', () => {
    for (const r of [Resolution.LOCAL_WINS, Resolution.SERVER_WINS, Resolution.KEEP_BOTH]) {
      expect(isConflict({ resolution: r })).toBe(true);
    }
  });
});
