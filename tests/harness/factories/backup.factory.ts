/**
 * @file backup.factory.ts
 * @description Test factory das cópias de segurança.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export interface TestBackupManifest {
  database: string;
  file: string;
  created_at: string;
  bytes: number;
  sha256: string;
  row_counts: Record<string, number | null>;
}

const DAY = 86_400_000;

/** Nome no formato que o script escreve: `sistematrack-<base>-<AAAAMMDDTHHMMSSZ>.dump`. */
function nameAt(date: Date, database = 'track'): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `sistematrack-${database}-${stamp}.dump`;
}

export class BackupFactory {
  /** Nome de uma cópia numa data concreta. */
  static fileName(date: Date, database = 'track'): string {
    return nameAt(date, database);
  }

  /** Uma cópia por dia, do mais recente para trás. */
  static daily(days: number, from: Date = new Date('2026-08-05T02:00:00.000Z')): string[] {
    return Array.from({ length: days }, (_, i) => nameAt(new Date(from.getTime() - i * DAY)));
  }

  /** Várias cópias no MESMO dia — o caso que decide qual sobrevive. */
  static sameDay(count: number, day: Date = new Date('2026-08-05T00:00:00.000Z')): string[] {
    return Array.from({ length: count }, (_, i) => nameAt(new Date(day.getTime() + i * 3_600_000)));
  }

  /** Histórico longo: uma por dia durante um ano. */
  static year(from: Date = new Date('2026-08-05T02:00:00.000Z')): string[] {
    return BackupFactory.daily(365, from);
  }

  static manifest(overrides: Partial<TestBackupManifest> = {}): TestBackupManifest {
    return {
      database: 'track',
      file: nameAt(new Date('2026-08-05T02:00:00.000Z')),
      created_at: '2026-08-05T02:00:00.000Z',
      bytes: 119_342,
      sha256: 'a53448d88400d37884b349e25ce6a83b3d14e712481d7b95d8a1e8c4b438eb7b',
      row_counts: { orders: 8, invoices: 3, audit_events: 5, companies: 1 },
      ...overrides,
    };
  }
}
