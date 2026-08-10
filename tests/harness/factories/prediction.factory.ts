/**
 * @file prediction.factory.ts
 * @description Factory do histórico que alimenta a previsão de tempo de entrega.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.46
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * As amostras aqui são construídas para responder a uma pergunta cada: a
 * mediana aguenta um disparate? a amostra curta é recusada? o recurso à zona é
 * assinalado? uma promessa que a medição desmente aparece dita?
 */

export interface TestDelivery {
  created_at: string;
  delivered_at: string | null;
  city: string | null;
  zone: string | null;
  service_level: string;
}

/** Base fixa: a duração tem de ser afirmável sem depender de hoje. */
export const INICIO = '2026-06-01T08:00:00.000Z';

function maisHoras(iso: string, horas: number): string {
  return new Date(Date.parse(iso) + horas * 3_600_000).toISOString();
}

export const PredictionFactory = {
  /** Uma entrega com a duração pedida. */
  delivery(horas: number, over: Partial<TestDelivery> = {}): TestDelivery {
    return {
      created_at: INICIO,
      delivered_at: maisHoras(INICIO, horas),
      city: 'Maputo',
      zone: 'Maputo Cidade',
      service_level: 'normal',
      ...over,
    };
  },

  /** `n` entregas com as durações dadas, repetidas até perfazer `n`. */
  deliveries(horas: number[], over: Partial<TestDelivery> = {}): TestDelivery[] {
    return horas.map((h) => this.delivery(h, over));
  },

  /**
   * Amostra suficiente e bem comportada: 24 entregas entre 10 e 33 horas.
   * A mediana cai em 21,5 h e o P90 perto de 30 h.
   */
  amostraSuficiente(over: Partial<TestDelivery> = {}): TestDelivery[] {
    const horas = Array.from({ length: 24 }, (_, i) => 10 + i);
    return this.deliveries(horas, over);
  },

  /** Curta de propósito: 5 entregas. Não deve produzir previsão nenhuma. */
  amostraCurta(over: Partial<TestDelivery> = {}): TestDelivery[] {
    return this.deliveries([12, 14, 16, 18, 20], over);
  },

  /**
   * A mesma amostra suficiente com uma encomenda esquecida três semanas.
   *
   * É o caso que separa mediana de média: a média salta mais de 20 horas, a
   * mediana não se mexe.
   */
  comEsquecida(): TestDelivery[] {
    return [...this.amostraSuficiente(), this.delivery(24 * 21)];
  },

  /** Durações que só existem para serem recusadas. */
  invalidas(): TestDelivery[] {
    return [
      // Relógio trocado: entregue antes de ter sido registada.
      this.delivery(-5),
      // Mais de 90 dias: não é uma entrega, é um registo esquecido.
      this.delivery(24 * 120),
      { ...this.delivery(10), delivered_at: null },
    ];
  },

  /**
   * Duas partes da mesma zona: normal com amostra curta, express com amostra
   * cheia. Junta, a zona chega ao mínimo — é o cenário do recurso.
   */
  zonaComRecurso(): TestDelivery[] {
    return [
      ...this.amostraCurta({ service_level: 'normal' }),
      ...this.amostraSuficiente({ service_level: 'express' }),
    ];
  },
};
