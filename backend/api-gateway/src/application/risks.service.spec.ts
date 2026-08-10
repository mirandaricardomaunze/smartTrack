/**
 * @file risks.service.spec.ts
 * @description Testes da deteção de atrasos, paragens e desvios.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.47
 *
 * Uma lista de alertas só é lida enquanto for verdadeira. Basta uma encomenda
 * declarada atrasada sem prazo nem histórico para a lista inteira passar a ser
 * ignorada — e é precisamente aí que ela deixa de servir para alguma coisa.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { RiskFactory } from '../../../../tests/harness';

const require = createRequire(import.meta.url);
const {
  assessDelay, assessStall, sequenceDeviations, plannedOrderIds, STALL_HOURS_FALLBACK,
} = require('./risks.service.js');

describe('Risco · classificação do atraso', () => {
  const previsao = RiskFactory.prediction();
  const casos = RiskFactory.delayCases();
  const caso = (label: string) => casos.find((c) => c.label === label)!;

  it('should leave a fresh order alone', () => {
    expect(assessDelay(caso('longe do prazo'), previsao, null).level).toBe('no_prazo');
  });

  it('should raise the flag while there is still time to act', () => {
    // É o ponto todo do módulo: sinalizada só depois do prazo, a lista é um
    // relatório de más notícias em vez de uma lista de trabalho.
    const r = assessDelay(caso('passou a mediana, ainda a tempo'), previsao, null);

    expect(r.level).toBe('em_risco');
    expect(r.limit_hours).toBe(30);
  });

  it('should call an order late once it passes the measured limit', () => {
    const r = assessDelay(caso('já passou o prazo'), previsao, null);

    expect(r.level).toBe('atrasada');
    expect(r.basis).toBe('p90');
  });

  it('should never call an order late with nothing to judge it by', () => {
    // Sem prazo acordado e sem histórico, um "atrasada" seria um incumprimento
    // inventado — e nem 200 horas o justificam.
    const r = assessDelay(caso('sem prazo nem histórico'), RiskFactory.noPrediction(), null);

    expect(r.level).toBe('sem_base');
    expect(r.basis).toBe(null);
    expect(r.limit_hours).toBe(null);
  });

  it('should let the promise made to the client override the measurement', () => {
    // É por ela que a empresa responde, mesmo quando a medição diz outra coisa.
    const r = assessDelay(caso('passou a mediana, ainda a tempo'), previsao, 24);

    expect(r.basis).toBe('sla');
    expect(r.limit_hours).toBe(24);
    expect(r.level).toBe('atrasada');   // 25 h já passaram as 24 prometidas
  });

  it('should still warn early when only a promise exists', () => {
    // Sem P50 medido, o aviso sai a 60% do prometido: mais vale um aviso
    // aproximado do que só a notícia do incumprimento.
    const r = assessDelay({ elapsed_hours: 20 }, RiskFactory.noPrediction(), 30);
    expect(r.level).toBe('em_risco');
  });
});

describe('Risco · encomenda parada', () => {
  const medianas = RiskFactory.statusMedians();

  it('should not confuse slow with stopped', () => {
    // 25 h num estado cuja mediana é 20 h é uma encomenda a demorar, não uma
    // encomenda parada. A margem é larga de propósito.
    const r = assessStall({ current_status: 'in_transit', hours_in_status: 25 }, medianas);
    expect(r.stalled).toBe(false);
  });

  it('should flag an order that stopped moving', () => {
    const r = assessStall({ current_status: 'in_transit', hours_in_status: 80 }, medianas);

    expect(r.stalled).toBe(true);
    expect(r.basis).toBe('historico_do_estado');
    expect(r.limit_hours).toBe(60);
  });

  it('should judge a stall separately from a delay', () => {
    // Uma encomenda pode estar dentro do prazo e parada há quatro dias. Um só
    // número esconderia uma das duas.
    const parada = assessStall({ current_status: 'out_for_delivery', hours_in_status: 30 }, medianas);
    const prazo = assessDelay({ elapsed_hours: 10 }, RiskFactory.prediction(), null);

    expect(parada.stalled).toBe(true);
    expect(prazo.level).toBe('no_prazo');
  });

  it('should fall back to a stated threshold when the state was never measured', () => {
    const r = assessStall({ current_status: 'estado_novo', hours_in_status: 100 }, medianas);

    expect(r.basis).toBe('sem_historico');
    expect(r.limit_hours).toBe(STALL_HOURS_FALLBACK);
    expect(r.stalled).toBe(true);
  });
});

describe('Risco · desvio de sequência', () => {
  const planeada = RiskFactory.plannedRoute();

  it('should see nothing wrong in a route done as planned', () => {
    expect(sequenceDeviations(planeada, RiskFactory.actualInOrder())).toEqual([]);
  });

  it('should point at the stop served ahead of its turn', () => {
    const desvios = sequenceDeviations(planeada, RiskFactory.actualOutOfOrder());

    // A quarta parada foi entregue em segundo lugar; as que vieram depois dela
    // aparecem como fora de ordem.
    expect(desvios.length).toBeGreaterThan(0);
    expect(desvios[0]).toMatchObject({ order_id: 'ord-b', planned_position: 2, kind: 'sequencia' });
  });

  it('should not silence a stop that was never in the plan', () => {
    // Uma recolha urgente a meio da rota é um desvio à sua maneira, e não pode
    // desaparecer por não ter posição planeada.
    const desvios = sequenceDeviations(planeada, RiskFactory.actualWithUnplanned());

    expect(desvios).toContainEqual(
      expect.objectContaining({ order_id: 'ord-urgente', kind: 'fora_do_plano', planned_position: null }),
    );
  });

  it('should survive a route with nothing delivered yet', () => {
    expect(sequenceDeviations(planeada, [])).toEqual([]);
    expect(sequenceDeviations([], ['ord-a'])).toHaveLength(1);
  });

  it('should read the planned ids whichever shape the stops came in', () => {
    expect(plannedOrderIds([{ order_id: 'a' }, { id: 'b' }, { nada: 1 }])).toEqual(['a', 'b']);
    expect(plannedOrderIds(null)).toEqual([]);
  });
});
