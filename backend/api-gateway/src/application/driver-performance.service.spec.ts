/**
 * @file driver-performance.service.spec.ts
 * @description Testes unitários dos indicadores de desempenho dos motoristas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.43
 *
 * Estes números aparecem no ecrã onde se decide quem fica com as melhores rotas.
 * O que aqui se afirma é sobretudo o que eles NÃO devem dizer: nada, quando não
 * há amostra. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { DriverPerformanceFactory } from '../../../../tests/harness';

const { rate, computePerformance, rankDrivers } = require('./driver-performance.service');

describe('Desempenho · taxa sem amostra', () => {
  it('should give null and not zero when there is nothing to measure', () => {
    // 0% para quem começou ontem é uma acusação.
    expect(rate(0, 0)).toBeNull();
  });

  it('should compute the percentage with one decimal', () => {
    expect(rate(2, 3)).toBe(66.7);
  });
});

describe('Desempenho · indicadores', () => {
  it('should report nothing at all for a driver without deliveries', () => {
    // Uma taxa de 100% para quem não entregou nada é um elogio sem base.
    const p = computePerformance([]);

    expect(p.deliveries).toBe(0);
    expect(p.success_rate_pct).toBeNull();
    expect(p.first_attempt_rate_pct).toBeNull();
    expect(p.punctuality_pct).toBeNull();
    expect(p.sample_size).toBe(0);
  });

  it('should lower the success rate on a failure', () => {
    // O defeito que esta secção corrige: um motorista com insucessos exibia
    // 100% de sucesso para sempre.
    const p = computePerformance(DriverPerformanceFactory.mixed());

    expect(p.deliveries).toBe(3);
    expect(p.failures).toBe(1);
    expect(p.returns).toBe(1);
    expect(p.success_rate_pct).toBe(60);
    expect(p.sample_size).toBe(5);
  });

  it('should not count a rescheduled delivery as first-attempt success', () => {
    // É o indicador que distingue quem resolve de quem volta lá três vezes.
    const p = computePerformance([
      DriverPerformanceFactory.clean(),
      DriverPerformanceFactory.deliveredAfterReschedule(),
    ]);

    expect(p.deliveries).toBe(2);
    expect(p.first_attempt_rate_pct).toBe(50);
  });

  it('should leave punctuality null when no zone has an agreed target', () => {
    // Numa operação sem SLA definido, 100% de pontualidade seria inventado.
    const p = computePerformance(DriverPerformanceFactory.withoutSlaTargets());

    expect(p.punctuality_pct).toBeNull();
    expect(p.punctuality_sample).toBe(0);
  });

  it('should measure punctuality only over deliveries that had a target', () => {
    const p = computePerformance([
      DriverPerformanceFactory.clean(),            // cumprido
      DriverPerformanceFactory.deliveredLate(),    // incumprido
      DriverPerformanceFactory.order({ sla_outcome: 'sem_prazo_acordado' }),
    ]);

    expect(p.punctuality_sample).toBe(2);
    expect(p.punctuality_pct).toBe(50);
  });

  it('should not let orders still in transit move the rates', () => {
    // Contá-las faria a taxa mover-se sozinha com o passar do dia.
    const p = computePerformance([
      DriverPerformanceFactory.clean(),
      DriverPerformanceFactory.inTransit(),
    ]);

    expect(p.sample_size).toBe(1);
    expect(p.success_rate_pct).toBe(100);
    expect(p.in_progress).toBe(1);
  });

  it('should report unsettled COD apart from service quality', () => {
    // Não é qualidade de serviço, é exposição de caixa — misturá-los daria uma
    // "nota" que ninguém sabe interpretar.
    const p = computePerformance([
      DriverPerformanceFactory.withUnsettledCod(50_000),
      DriverPerformanceFactory.withUnsettledCod(30_000),
    ]);

    expect(p.unsettled_cod_cents).toBe(80_000);
  });

  it('should have no customer rating field at all', () => {
    // Nunca existiu recolha de avaliações; os 5,0 eram inventados. Mostrar o
    // campo, ainda que vazio, convidaria alguém a preenchê-lo à mão.
    expect(computePerformance(DriverPerformanceFactory.mixed())).not.toHaveProperty('customer_rating');
  });
});

describe('Desempenho · ranking', () => {
  it('should put the best success rate first', () => {
    const linhas = [
      { driver_id: 'b', success_rate_pct: 80, deliveries: 10, sample_size: 10 },
      { driver_id: 'a', success_rate_pct: 95, deliveries: 10, sample_size: 10 },
    ];
    expect(rankDrivers(linhas)[0].driver_id).toBe('a');
  });

  it('should push drivers without a sample to the end, unjudged', () => {
    // Aparecer no topo por não ter falhado nada seria tão errado como aparecer
    // no fundo por não ter entregado.
    const linhas = [
      { driver_id: 'novo', success_rate_pct: null, deliveries: 0, sample_size: 0 },
      { driver_id: 'veterano', success_rate_pct: 70, deliveries: 50, sample_size: 50 },
    ];
    expect(rankDrivers(linhas)[0].driver_id).toBe('veterano');
  });

  it('should break a tie by the number of deliveries', () => {
    const linhas = [
      { driver_id: 'poucas', success_rate_pct: 100, deliveries: 2, sample_size: 2 },
      { driver_id: 'muitas', success_rate_pct: 100, deliveries: 40, sample_size: 40 },
    ];
    expect(rankDrivers(linhas)[0].driver_id).toBe('muitas');
  });

  it('should survive an empty or missing list', () => {
    expect(rankDrivers([])).toEqual([]);
    expect(rankDrivers(undefined as unknown as [])).toEqual([]);
  });
});
