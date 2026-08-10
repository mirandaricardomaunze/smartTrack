/**
 * @file time-window.factory.ts
 * @description Factory das janelas de entrega e prioridades.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.48
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * As paradas estão dispostas em linha ao longo da Av. Julius Nyerere, em Maputo,
 * de propósito: assim a ordem mais curta é evidente, e qualquer alteração feita
 * por uma janela é visível a olho em vez de ter de ser calculada.
 */

export interface TestWindowStop {
  order_id: string;
  lat: number;
  lng: number;
  window_start?: string;
  window_end?: string;
  priority?: 'alta' | 'normal' | 'baixa';
  label: string;
}

/** Partida às 8h de um dia fixo — as horas têm de ser afirmáveis. */
export const PARTIDA = '2026-08-10T06:00:00.000Z';   // 08:00 em Maputo (UTC+2)

/** Origem: armazém no centro de Maputo. */
export const ARMAZEM = { lat: -25.9692, lng: 32.5732 };

function hora(h: number, m = 0): string {
  return new Date(Date.parse(PARTIDA) + (h * 60 + m) * 60_000).toISOString();
}

export const TimeWindowFactory = {
  /**
   * Quatro paradas em linha, cada vez mais longe do armazém.
   *
   * Sem janelas, a ordem mais curta é A → B → C → D.
   */
  linha(): TestWindowStop[] {
    return [
      { order_id: 'A', lat: -25.9750, lng: 32.5800, label: 'a mais perto', priority: 'normal' },
      { order_id: 'B', lat: -25.9850, lng: 32.5900, label: 'segunda', priority: 'normal' },
      { order_id: 'C', lat: -25.9950, lng: 32.6000, label: 'terceira', priority: 'normal' },
      { order_id: 'D', lat: -26.0050, lng: 32.6100, label: 'a mais longe', priority: 'normal' },
    ];
  },

  /**
   * A mesma linha, mas a parada mais longe tem de ser servida logo de manhã.
   *
   * É o caso que a otimização por distância erra: entregaria D em último, às
   * tantas da tarde, e a janela fecha às 9h30.
   */
  comJanelaCedoNoFim(): TestWindowStop[] {
    const stops = this.linha();
    stops[3] = { ...stops[3], window_start: hora(0), window_end: hora(1, 30), label: 'longe, mas só até às 9h30' };
    return stops;
  },

  /**
   * Uma janela que já fechou antes de a rota sair.
   *
   * Não há ordem nenhuma que a cumpra. O motor tem de dizê-lo em vez de a
   * enterrar no meio da lista.
   */
  comJanelaImpossivel(): TestWindowStop[] {
    const stops = this.linha();
    stops[2] = {
      ...stops[2],
      window_start: '2026-08-09T06:00:00.000Z',
      window_end: '2026-08-09T08:00:00.000Z',
      label: 'janela do dia anterior',
    };
    return stops;
  },

  /**
   * Uma parada prioritária ao fundo da linha, sem janela nenhuma.
   *
   * A prioridade deve puxá-la para a frente — mas nunca à custa de fazer outra
   * falhar a janela.
   */
  comPrioridade(): TestWindowStop[] {
    const stops = this.linha();
    stops[3] = { ...stops[3], priority: 'alta', window_start: hora(0), window_end: hora(9), label: 'longe e urgente' };
    stops[0] = { ...stops[0], window_start: hora(0), window_end: hora(1), label: 'perto e a fechar cedo' };
    return stops;
  },

  /** Uma janela que abre tarde: chegar cedo é esperar, não é falhar. */
  comEspera(): TestWindowStop[] {
    const stops = this.linha();
    stops[0] = { ...stops[0], window_start: hora(4), window_end: hora(6), label: 'só abre às 12h' };
    return stops;
  },

  opcoes(over: Record<string, unknown> = {}) {
    return { departure_at: PARTIDA, speed_kmh: 20, service_minutes: 5, ...over };
  },
};
