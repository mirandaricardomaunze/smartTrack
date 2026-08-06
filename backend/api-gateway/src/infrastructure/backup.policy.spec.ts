/**
 * @file backup.policy.spec.ts
 * @description Testes da retenção de cópias de segurança.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * Esta é a parte perigosa de um sistema de backup: decidir o que se APAGA. Um
 * erro aqui destrói o arquivo fiscal dos clientes em silêncio, e só se descobre
 * no dia em que é preciso restaurar. Daí a cobertura ser desproporcional ao
 * tamanho do ficheiro. Dados via factories do harness.
 */
import { describe, expect, it } from 'vitest';
import { BackupFactory } from '../../../../tests/harness';

const {
  backupFileName, parseBackupDate, planRetention, compareRowCounts,
  dayKey, weekKey, monthKey, DEFAULT_POLICY,
} = require('./backup.policy');

describe('Cópias · nome do ficheiro', () => {
  it('should carry the database and an instant that sorts chronologically', () => {
    const name = backupFileName('track', new Date('2026-08-05T18:55:35.123Z'));
    expect(name).toBe('sistematrack-track-20260805T185535Z.dump');
  });

  it('should round-trip through the parser', () => {
    const at = new Date('2026-03-09T07:04:02.000Z');
    expect(parseBackupDate(backupFileName('track', at))?.toISOString()).toBe(at.toISOString());
  });

  it('should sort by name in the same order as by date', () => {
    const names = BackupFactory.daily(10);
    const byName = [...names].sort();
    const byDate = [...names].sort((a, b) => parseBackupDate(a) - parseBackupDate(b));
    expect(byName).toEqual(byDate);
  });

  it.each(['relatorio.pdf', 'dump.sql', 'sistematrack-track.dump', ''])(
    'should not recognise %s as a backup', (name) => {
      expect(parseBackupDate(name)).toBeNull();
    },
  );
});

describe('Cópias · retenção', () => {
  it('should keep everything while inside the daily window', () => {
    const plan = planRetention(BackupFactory.daily(5), { daily: 7, weekly: 4, monthly: 6 });
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toHaveLength(5);
  });

  it('should keep only the newest of several backups on the same day', () => {
    const sameDay = BackupFactory.sameDay(4);      // 00:00, 01:00, 02:00, 03:00
    const plan = planRetention(sameDay);

    expect(plan.keep).toHaveLength(1);
    expect(plan.keep[0]).toBe(sameDay[sameDay.length - 1]);   // a mais recente
    expect(plan.remove).toHaveLength(3);
  });

  it('should thin out a year into daily, weekly and monthly survivors', () => {
    const plan = planRetention(BackupFactory.year(), DEFAULT_POLICY);

    // Sete diárias + quatro semanais + seis mensais, descontando sobreposições.
    expect(plan.keep.length).toBeLessThanOrEqual(17);
    expect(plan.keep.length).toBeGreaterThanOrEqual(13);
    expect(plan.keep.length + plan.remove.length).toBe(365);
  });

  it('should explain why each survivor was kept', () => {
    const plan = planRetention(BackupFactory.year(), DEFAULT_POLICY);
    for (const name of plan.keep) {
      expect(plan.reasons[name].length).toBeGreaterThan(0);
      expect(plan.reasons[name].join(' ')).toMatch(/diária|semanal|mensal/);
    }
  });

  it('should always keep the most recent backup', () => {
    const names = BackupFactory.year();
    const newest = names[0];
    expect(planRetention(names, { daily: 1, weekly: 1, monthly: 1 }).keep).toContain(newest);
  });

  it('should never delete a file it does not recognise', () => {
    const plan = planRetention([...BackupFactory.daily(30), 'copia-manual-do-cliente.dump.bak', 'notas.txt']);

    expect(plan.unknown).toEqual(['copia-manual-do-cliente.dump.bak', 'notas.txt']);
    expect(plan.remove).not.toContain('copia-manual-do-cliente.dump.bak');
    expect(plan.remove).not.toContain('notas.txt');
  });

  it('should do nothing with an empty directory', () => {
    expect(planRetention([])).toMatchObject({ keep: [], remove: [], unknown: [] });
  });

  it('should honour a policy that keeps nothing but the dailies', () => {
    const plan = planRetention(BackupFactory.daily(40), { daily: 3, weekly: 0, monthly: 0 });
    expect(plan.keep).toHaveLength(3);
    expect(plan.remove).toHaveLength(37);
  });

  it('should count a backup once when it qualifies for several reasons', () => {
    // A mais recente é simultaneamente a diária, a semanal e a mensal.
    const plan = planRetention(BackupFactory.daily(1));
    expect(plan.keep).toHaveLength(1);
    expect(plan.reasons[plan.keep[0]].length).toBeGreaterThanOrEqual(3);
  });
});

describe('Cópias · agrupamento por período', () => {
  it('should group by UTC calendar day', () => {
    expect(dayKey(new Date('2026-08-05T23:59:59Z'))).toBe('2026-08-05');
    expect(dayKey(new Date('2026-08-06T00:00:01Z'))).toBe('2026-08-06');
  });

  it('should put a whole ISO week under one key', () => {
    // Segunda a domingo da mesma semana.
    const monday = weekKey(new Date('2026-08-03T00:00:00Z'));
    expect(weekKey(new Date('2026-08-09T23:00:00Z'))).toBe(monday);
    expect(weekKey(new Date('2026-08-10T00:00:00Z'))).not.toBe(monday);
  });

  it('should group by month', () => {
    expect(monthKey(new Date('2026-08-31T23:00:00Z'))).toBe('2026-08');
    expect(monthKey(new Date('2026-09-01T00:00:00Z'))).toBe('2026-09');
  });
});

describe('Cópias · conferência do restauro', () => {
  it('should accept a restore that brought every row', () => {
    const counts = BackupFactory.manifest().row_counts as Record<string, number>;
    expect(compareRowCounts(counts, counts)).toEqual({ ok: true, differences: [] });
  });

  it('should refuse a restore that lost rows, naming the table', () => {
    const expected = { orders: 8, invoices: 3 };
    const result = compareRowCounts(expected, { orders: 8, invoices: 2 });

    expect(result.ok).toBe(false);
    expect(result.differences).toEqual([{ table: 'invoices', expected: 3, actual: 2 }]);
  });

  it('should treat a missing table as zero rows, not as a match', () => {
    const result = compareRowCounts({ audit_events: 5 }, {});
    expect(result.ok).toBe(false);
    expect(result.differences[0]).toMatchObject({ table: 'audit_events', actual: 0 });
  });

  it('should not complain about extra tables in the restored database', () => {
    // Uma tabela nova criada por uma migração posterior não invalida a cópia.
    expect(compareRowCounts({ orders: 8 }, { orders: 8, tabela_nova: 3 }).ok).toBe(true);
  });
});
