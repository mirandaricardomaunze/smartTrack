/**
 * @file hr-attendance.spec.ts
 * @description Testes do cálculo de assiduidade por turno (função pura).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.18 (Recursos Humanos)
 *
 * Antes, a hora de entrada estava fixa em 07:00 UTC e a jornada em 8 horas —
 * quem entrasse às 08:30 em Maputo contava como pontual. Aqui prova-se que o
 * horário passou a vir do TURNO, em hora local, com dias de descanso e turnos
 * que atravessam a meia-noite. Dados via factories do harness.
 */
import { describe, expect, it } from 'vitest';
import { HrShiftFactory, HrAttendanceFactory } from '../../../../tests/harness';

const { attendanceMetrics, shiftNetMinutes, DEFAULT_SHIFT } = require('./hr.service');

/** Turno de Maputo: 08:00–17:00 com 1h de pausa, de segunda a sexta (UTC+2). */
function maputoShift(overrides: Record<string, unknown> = {}) {
  return {
    ...HrShiftFactory.build({ start_time: '08:00:00', end_time: '17:00:00', break_minutes: 60, work_days: [1, 2, 3, 4, 5] }),
    timezone_offset_minutes: 120,
    ...overrides,
  };
}

describe('Assiduidade · jornada prevista do turno', () => {
  it('should discount the break from the shift span', () => {
    expect(shiftNetMinutes(maputoShift())).toBe(480);   // 9h - 1h
  });

  it('should handle a shift that crosses midnight', () => {
    expect(shiftNetMinutes(maputoShift({ start_time: '22:00', end_time: '06:00', break_minutes: 30 }))).toBe(450);
  });

  it('should accept HH:MM and HH:MM:SS alike (TIME comes back from PG with seconds)', () => {
    expect(shiftNetMinutes(maputoShift({ start_time: '08:00', end_time: '17:00' })))
      .toBe(shiftNetMinutes(maputoShift({ start_time: '08:00:00', end_time: '17:00:00' })));
  });
});

describe('Assiduidade · atraso em hora local', () => {
  it('should treat an 08:00 Maputo arrival as punctual', () => {
    // 08:00 em Maputo (UTC+2) = 06:00 UTC. Com a hora fixa antiga, isto dava 0
    // atraso por acaso; o que interessa é que continue certo com o turno real.
    const m = attendanceMetrics('2026-08-03T06:00:00.000Z', '2026-08-03T15:00:00.000Z', 60, maputoShift());
    expect(m.late_minutes).toBe(0);
  });

  it('should flag as late an arrival that the old fixed 07:00 UTC rule forgave', () => {
    // 08:30 em Maputo = 06:30 UTC. A regra antiga (07:00 UTC) dava 0 atraso.
    const m = attendanceMetrics('2026-08-03T06:30:00.000Z', '2026-08-03T15:00:00.000Z', 60, maputoShift());
    expect(m.late_minutes).toBe(30);
  });

  it('should not invent lateness for someone who arrives early', () => {
    const m = attendanceMetrics('2026-08-03T05:30:00.000Z', '2026-08-03T15:00:00.000Z', 60, maputoShift());
    expect(m.late_minutes).toBe(0);
  });

  it('should use the local calendar day, not the UTC one', () => {
    // 01:00 de 4 de agosto em Maputo = 23:00 UTC de 3 de agosto. A entrada
    // pertence ao dia 4 local; contra um turno que começa às 08:00 isso é
    // chegar MUITO cedo, não 17 horas atrasado.
    const m = attendanceMetrics('2026-08-03T23:00:00.000Z', undefined, 60, maputoShift({ work_days: [] }));
    expect(m.late_minutes).toBe(0);
  });
});

describe('Assiduidade · trabalho e horas extraordinárias', () => {
  it('should count overtime against the shift, not a hardcoded 8 hours', () => {
    // Turno de 6h líquidas; trabalhou 8h → 2h extra.
    const shift = maputoShift({ start_time: '08:00', end_time: '15:00', break_minutes: 60 });
    const m = attendanceMetrics('2026-08-03T06:00:00.000Z', '2026-08-03T15:00:00.000Z', 60, shift);

    expect(m.expected_minutes).toBe(360);
    expect(m.worked_minutes).toBe(480);
    expect(m.overtime_minutes).toBe(120);
  });

  it('should report no worked time while the exit is still open', () => {
    const m = attendanceMetrics('2026-08-03T06:00:00.000Z', undefined, 60, maputoShift());
    expect(m.worked_minutes).toBe(0);
    expect(m.overtime_minutes).toBe(0);
  });

  it('should never return negative worked time on an inverted punch', () => {
    const m = attendanceMetrics('2026-08-03T15:00:00.000Z', '2026-08-03T06:00:00.000Z', 60, maputoShift());
    expect(m.worked_minutes).toBe(0);
  });
});

describe('Assiduidade · dias de descanso', () => {
  it('should count every worked minute as overtime on a rest day', () => {
    // 2026-08-02 é um domingo; o turno só trabalha de segunda a sexta.
    const m = attendanceMetrics('2026-08-02T06:00:00.000Z', '2026-08-02T12:00:00.000Z', 0, maputoShift());

    expect(m.rest_day).toBe(true);
    expect(m.late_minutes).toBe(0);          // não há atraso num dia de folga
    expect(m.overtime_minutes).toBe(360);
    expect(m.expected_minutes).toBe(0);
  });

  it('should apply no weekly rule when the shift declares no work days', () => {
    const m = attendanceMetrics('2026-08-02T06:00:00.000Z', '2026-08-02T12:00:00.000Z', 0, maputoShift({ work_days: [] }));
    expect(m.rest_day).toBe(false);
  });
});

describe('Assiduidade · turno de omissão', () => {
  it('should keep the previous behaviour for companies without shifts', () => {
    // Sem turno configurado o sistema mantém 09:00 locais (07:00 UTC) e 8h.
    const a = HrAttendanceFactory.build();
    expect(attendanceMetrics(a.clock_in, a.clock_out, a.break_minutes))
      .toMatchObject({ worked_minutes: 425, late_minutes: 0, overtime_minutes: 0 });
    expect(shiftNetMinutes(DEFAULT_SHIFT)).toBe(480);
  });

  it('should reject an unparseable clock-in', () => {
    expect(() => attendanceMetrics('não é uma data')).toThrowError(/entrada inválida/i);
  });
});
