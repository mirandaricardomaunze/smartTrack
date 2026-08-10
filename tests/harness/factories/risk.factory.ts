/**
 * @file risk.factory.ts
 * @description Factory dos cenários de atraso, paragem e desvio de sequência.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.47
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * O cenário que mais importa aqui é o da encomenda sobre a qual nada foi
 * prometido nem medido: declará-la atrasada seria inventar um incumprimento, e
 * basta uma linha falsa para a lista deixar de ser lida.
 */

export interface TestInFlightOrder {
  id: string;
  tracking_code: string;
  current_status: string;
  elapsed_hours: number;
  hours_in_status: number;
  label: string;
}

export interface TestPrediction {
  p50_hours: number | null;
  p90_hours: number | null;
}

let contador = 1;

export const RiskFactory = {
  /** Previsão medida típica: metade chega em 20 h, nove em cada dez em 30 h. */
  prediction(over: Partial<TestPrediction> = {}): TestPrediction {
    return { p50_hours: 20, p90_hours: 30, ...over };
  },

  /** Segmento sem amostra bastante — não há previsão nenhuma. */
  noPrediction(): TestPrediction {
    return { p50_hours: null, p90_hours: null };
  },

  order(over: Partial<TestInFlightOrder> = {}): TestInFlightOrder {
    const n = contador++;
    return {
      id: `ord-risk-${n}`,
      tracking_code: `TRK90000${String(n).padStart(4, '0')}BR`,
      current_status: 'in_transit',
      elapsed_hours: 5,
      hours_in_status: 2,
      label: 'a andar, dentro do prazo',
      ...over,
    };
  },

  /** Os quatro estados que a classificação tem de distinguir. */
  delayCases(): TestInFlightOrder[] {
    return [
      this.order({ elapsed_hours: 5, label: 'longe do prazo' }),
      this.order({ elapsed_hours: 25, label: 'passou a mediana, ainda a tempo' }),
      this.order({ elapsed_hours: 41, label: 'já passou o prazo' }),
      this.order({ elapsed_hours: 200, label: 'sem prazo nem histórico' }),
    ];
  },

  /** Medianas medidas por estado — a base de "quanto tempo é normal aqui". */
  statusMedians(): Map<string, number> {
    return new Map([
      ['at_warehouse', 12],
      ['in_transit', 20],
      ['out_for_delivery', 4],
    ]);
  },

  /** Uma rota planeada com cinco paradas. */
  plannedRoute(): string[] {
    return ['ord-a', 'ord-b', 'ord-c', 'ord-d', 'ord-e'];
  },

  /** Entregue exatamente pela ordem planeada. */
  actualInOrder(): string[] {
    return ['ord-a', 'ord-b', 'ord-c'];
  },

  /** A quarta entregue antes da segunda — o desvio que se quer ver. */
  actualOutOfOrder(): string[] {
    return ['ord-a', 'ord-d', 'ord-b', 'ord-c'];
  },

  /** Uma paragem que nunca esteve no plano: recolha urgente a meio da rota. */
  actualWithUnplanned(): string[] {
    return ['ord-a', 'ord-urgente', 'ord-b'];
  },
};
