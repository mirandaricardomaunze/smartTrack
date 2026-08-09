/**
 * @file pg.repository.spec.ts
 * @description Testes dos conversores puros do repositório.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.37 (datas acordadas)
 *
 * Este ficheiro não toca na base: exercita as funções que traduzem uma linha do
 * Postgres para o vocabulário do domínio. É onde vivem os erros silenciosos —
 * um dia trocado numa conversão não faz nenhum teste de integração falhar, mas
 * aparece ao operador como uma entrega marcada para o dia errado.
 */
import { describe, expect, it } from 'vitest';

const { dateOnly } = require('./pg.repository');

describe('Repositório · conversão de datas sem hora', () => {
  it('should keep the day that was written, east of Greenwich', () => {
    // O driver devolve um DATE como Date à MEIA-NOITE LOCAL. Em UTC+2,
    // `toISOString()` recua para o dia anterior — uma entrega combinada para
    // dia 10 aparecia ao operador como dia 9.
    const meiaNoiteLocal = new Date(2026, 7, 10, 0, 0, 0); // 10 de agosto
    expect(dateOnly(meiaNoiteLocal)).toBe('2026-08-10');
  });

  it('should pad month and day to two digits', () => {
    expect(dateOnly(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05');
  });

  it('should pass a string through, trimmed to the date part', () => {
    // O driver pode já devolver texto conforme a configuração; o resultado tem
    // de ser o mesmo dos dois lados.
    expect(dateOnly('2026-08-10')).toBe('2026-08-10');
    expect(dateOnly('2026-08-10T00:00:00.000Z')).toBe('2026-08-10');
  });

  it('should give undefined for an absent date instead of a fake one', () => {
    // `null` numa coluna de data significa "não há data". Devolver hoje, ou o
    // epoch, punha uma data inventada num campo que o operador vai ler.
    expect(dateOnly(null)).toBeUndefined();
    expect(dateOnly(undefined)).toBeUndefined();
  });

  it('should survive the last day of the year without rolling over', () => {
    expect(dateOnly(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31');
  });
});
