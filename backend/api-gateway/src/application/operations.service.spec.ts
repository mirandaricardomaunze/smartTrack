/**
 * @file operations.service.spec.ts
 * @description Testes unitários da ordenação da fila de exceções.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.39
 *
 * As contagens vivem em SQL e estão cobertas na suite de integração. O que é
 * puro — e é o que decide o que a pessoa vê primeiro — é a severidade. Uma lista
 * por ordem de chegada faz o urgente desaparecer debaixo do trivial, que é o
 * mesmo que não ter lista. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { OperationsFactory } from '../../../../tests/harness';

const { severity, rankExceptions, KIND_WEIGHT } = require('./operations.service');

describe('Operações · severidade', () => {
  it('should rank a customer left waiting above a box forgotten in the warehouse', () => {
    // Um reagendamento vencido é alguém que ficou à espera num dia que já
    // passou; destrói mais confiança do que uma caixa que ninguém viu.
    const vencido = OperationsFactory.exception({ kind: 'overdue_reschedule', age_days: 1 });
    const parada  = OperationsFactory.exception({ kind: 'stale_in_warehouse', age_days: 1 });

    expect(severity(vencido)).toBeGreaterThan(severity(parada));
  });

  it('should let time aggravate within the same kind', () => {
    // Sem o tempo, dez insucessos do mesmo dia apareciam pela ordem em que a
    // base os devolveu.
    const novo  = OperationsFactory.exception({ kind: 'failed_without_decision', age_days: 1 });
    const velho = OperationsFactory.exception({ kind: 'failed_without_decision', age_days: 9 });

    expect(severity(velho)).toBeGreaterThan(severity(novo));
  });

  it('should not let age push a light kind above a grave one', () => {
    // Uma caixa esquecida há um ano não pode passar à frente de um cliente que
    // ficou à espera ontem — o teto de 30 dias mantém a ordem legível.
    const paradaHaUmAno = OperationsFactory.exception({ kind: 'stale_in_warehouse', age_days: 365 });
    const vencidoOntem  = OperationsFactory.exception({ kind: 'overdue_reschedule', age_days: 1 });

    expect(severity(vencidoOntem)).toBeGreaterThan(severity(paradaHaUmAno));
  });

  it('should give an unknown kind a low weight instead of crashing', () => {
    // Uma espécie nova acrescentada sem tocar na tabela de pesos aparece no fim,
    // não rebenta a lista.
    expect(severity({ kind: 'espécie_nova', age_days: 2 } as never)).toBe(12);
  });

  it('should treat a missing age as zero, not as NaN', () => {
    // NaN numa comparação de ordenação produz uma lista arbitrária, e ninguém
    // percebe porquê.
    expect(severity({ kind: 'overdue_reschedule' } as never)).toBe(KIND_WEIGHT.overdue_reschedule);
  });
});

describe('Operações · ordenação da fila', () => {
  it('should put the most urgent first', () => {
    const fila = rankExceptions(OperationsFactory.mixedQueue());

    expect(fila[0].kind).toBe('overdue_reschedule');
    expect(fila[fila.length - 1].kind).toBe('stale_in_warehouse');
  });

  it('should stamp the computed severity on each row', () => {
    // Quem lê a lista tem de poder perceber porque é que aquela linha está ali.
    const fila = rankExceptions(OperationsFactory.mixedQueue());
    expect(fila.every((e: any) => typeof e.severity === 'number')).toBe(true);
  });

  it('should not mutate the list it was given', () => {
    const original = OperationsFactory.mixedQueue();
    const primeiro = original[0].kind;
    rankExceptions(original);

    expect(original[0].kind).toBe(primeiro);
    expect(original[0]).not.toHaveProperty('severity');
  });

  it('should survive an empty or missing queue', () => {
    expect(rankExceptions([])).toEqual([]);
    expect(rankExceptions(undefined as unknown as [])).toEqual([]);
  });
});
