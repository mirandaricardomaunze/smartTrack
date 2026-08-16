/**
 * @file bounded-query.spec.ts
 * @description Testes do teto que se declara.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.51
 *
 * Este mecanismo passou a ser o que separa "o relatório mediu tudo" de "o
 * relatório mediu parte e disse-o". Se ele se enganar no limite, volta o defeito
 * que veio corrigir — mas agora com um carimbo de honestidade por cima, que é
 * pior.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { queryBounded, coverageOf, mergeCoverage } = require('./bounded-query.js');

/** Executor falso: devolve `total` linhas, respeitando o LIMIT do SQL. */
function executorCom(total: number) {
  return {
    async query(sql: string) {
      const limite = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? total);
      return { rows: Array.from({ length: Math.min(total, limite) }, (_, i) => ({ i })) };
    },
  };
}

describe('Teto declarado · deteção', () => {
  it('should not claim truncation when everything fits', () => {
    expect(coverageOf(340, 2000, false)).toMatchObject({ truncated: false, note: null });
  });

  it('should say plainly what was left out', () => {
    // A frase vem daqui e não de cada ecrã: três ecrãs a redigirem o mesmo aviso
    // acabam com três avisos diferentes, e o que disser menos é o que alguém
    // vai acreditar.
    const c = coverageOf(500, 500, true);

    expect(c.truncated).toBe(true);
    expect(c.note).toContain('500');
    expect(c.note).toContain('ficaram de fora');
  });
});

describe('Teto declarado · consulta', () => {
  it('should notice there was more by asking for one row beyond the ceiling', async () => {
    // Sem esta linha extra, saber que truncou exigiria um COUNT à parte — que
    // num relatório pesado custa quase tanto como a própria consulta.
    const r = await queryBounded('SELECT 1', [], 10, executorCom(50));

    expect(r.rows).toHaveLength(10);
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.counted).toBe(10);
  });

  it('should report no truncation when the rows end exactly at the ceiling', async () => {
    // O caso de fronteira que uma implementação ingénua erra: 10 linhas com teto
    // 10 NÃO é truncagem, e acusá-la poria um aviso permanente em relatórios
    // completos — que se aprende a ignorar.
    const r = await queryBounded('SELECT 1', [], 10, executorCom(10));

    expect(r.rows).toHaveLength(10);
    expect(r.coverage.truncated).toBe(false);
  });

  it('should hand back everything when there is little', async () => {
    const r = await queryBounded('SELECT 1', [], 100, executorCom(3));

    expect(r.rows).toHaveLength(3);
    expect(r.coverage).toMatchObject({ counted: 3, truncated: false });
  });

  it('should never trim the caller rows below the ceiling it promised', async () => {
    const r = await queryBounded('SELECT 1', [], 5, executorCom(1000));
    expect(r.rows).toHaveLength(5);
  });
});

describe('Teto declarado · relatórios com várias consultas', () => {
  it('should treat the whole report as truncated when any part is', () => {
    // A rentabilidade lê rotas e pedidos em consultas separadas, que truncam de
    // forma independente. Um relatório "meio completo" não existe.
    const junta = mergeCoverage(
      coverageOf(500, 500, true),
      coverageOf(120, 500, false),
    );

    expect(junta.truncated).toBe(true);
    expect(junta.counted).toBe(620);
  });

  it('should stay quiet when every part fits', () => {
    expect(mergeCoverage(coverageOf(10, 500, false), coverageOf(20, 500, false)).truncated).toBe(false);
  });

  it('should survive a report that ran only one query', () => {
    expect(mergeCoverage(coverageOf(10, 500, false), undefined).counted).toBe(10);
  });
});
