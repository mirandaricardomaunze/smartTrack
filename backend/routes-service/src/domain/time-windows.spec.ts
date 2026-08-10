/**
 * @file time-windows.spec.ts
 * @description Testes das janelas de entrega e da prioridade.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.48
 *
 * O risco aqui não é uma rota má — é uma rota que parece boa. Uma ordem com o
 * mínimo de quilómetros e três janelas falhadas passa por eficiente até o
 * motorista chegar à porta fechada do terceiro cliente.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { TimeWindowFactory, ROUTE_ORIGIN } from '../../../../tests/harness';

const require = createRequire(import.meta.url);
const { orderByWindows, hasWindows, evaluateArrival, ASSUMED_SPEED_KMH } = require('./time-windows.js');
const { optimizeStops } = require('./optimizer.js');

const ids = (stops: any[]) => stops.map((s) => s.order_id);

describe('Janelas · deteção', () => {
  it('should leave a route with no windows exactly as it was', () => {
    // Uma otimização que mudasse de comportamento por causa de um campo
    // opcional vazio seria uma alteração silenciosa de todas as rotas em uso.
    expect(hasWindows(TimeWindowFactory.linha())).toBe(false);

    const r = optimizeStops(TimeWindowFactory.linha(), ROUTE_ORIGIN, TimeWindowFactory.opcoes());
    expect(r.window_violations).toBeUndefined();
    expect(ids(r.stops)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('should notice a single window among many stops', () => {
    expect(hasWindows(TimeWindowFactory.comJanelaCedoNoFim())).toBe(true);
  });
});

describe('Janelas · ordenação', () => {
  it('should reorder so the far early window is met', () => {
    // Por distância, D seria a última — e a janela fecha às 9h30. Alguns
    // quilómetros a mais saem mais baratos do que uma entrega falhada que volta
    // amanhã e paga a viagem duas vezes.
    const r = orderByWindows(
      TimeWindowFactory.comJanelaCedoNoFim(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );

    expect(ids(r.stops)[0]).toBe('D');
    expect(r.window_violations).toEqual([]);
  });

  it('should treat arriving early as waiting, not as failing', () => {
    const r = orderByWindows(
      TimeWindowFactory.comEspera(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );
    const a = r.arrival_estimates.find((e: any) => e.order_id === 'A');

    expect(a.status).toBe('espera');
    // A espera fica registada: meia hora à porta de um cliente é meia hora que
    // podia ter servido outro.
    expect(a.wait_minutes).toBeGreaterThan(0);
    expect(r.window_violations).toEqual([]);
  });

  it('should let priority decide only between equally possible stops', () => {
    // A prioritária está longe, mas a sua janela é larga; a de perto fecha às
    // 9h. Um expresso entregue depois de a janela fechar não é uma entrega
    // prioritária, é uma entrega falhada mais cedo na lista.
    const r = orderByWindows(
      TimeWindowFactory.comPrioridade(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );

    expect(ids(r.stops)[0]).toBe('A');
    expect(r.window_violations).toEqual([]);
  });
});

describe('Janelas · o que não dá para cumprir', () => {
  it('should report an impossible window instead of burying it', () => {
    // Não há ordem nenhuma que a cumpra. Um plano que o esconde fá-lo descobrir
    // à porta do cliente, que é o pior sítio e a pior hora.
    const r = orderByWindows(
      TimeWindowFactory.comJanelaImpossivel(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );

    expect(r.window_violations).toHaveLength(1);
    expect(r.window_violations[0]).toMatchObject({ order_id: 'C' });
    expect(r.window_violations[0].late_minutes).toBeGreaterThan(0);
  });

  it('should still deliver the impossible stop rather than drop it', () => {
    // Fora da janela continua a ser uma encomenda para entregar. Deixá-la fora
    // da rota fá-la desaparecer da operação.
    const r = orderByWindows(
      TimeWindowFactory.comJanelaImpossivel(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );

    expect(ids(r.stops).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('should push the impossible stop out of the way of the possible ones', () => {
    // Já está falhada; deixá-la à frente arrastaria as outras para o mesmo sítio.
    const r = orderByWindows(
      TimeWindowFactory.comJanelaImpossivel(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );

    expect(ids(r.stops).indexOf('C')).toBe(3);
  });

  it('should return an empty violation list rather than no list at all', () => {
    // A ausência do campo leria-se como "não foram verificadas".
    const r = orderByWindows(
      TimeWindowFactory.comJanelaCedoNoFim(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );
    expect(Array.isArray(r.window_violations)).toBe(true);
  });
});

describe('Janelas · velocidade declarada', () => {
  it('should say when the speed was given rather than measured', () => {
    // O plano é usado para prometer horas a clientes: uma hora estimada com uma
    // velocidade inventada não pode ser indistinguível de uma medida.
    const medida = orderByWindows(
      TimeWindowFactory.comJanelaCedoNoFim(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );
    expect(medida.speed_basis).toBe('measured');
    expect(medida.speed_kmh).toBe(20);
  });

  it('should fall back to a stated assumption and admit it', () => {
    const assumida = orderByWindows(
      TimeWindowFactory.comJanelaCedoNoFim(), ROUTE_ORIGIN,
      TimeWindowFactory.opcoes({ speed_kmh: undefined }),
    );

    expect(assumida.speed_basis).toBe('assumed');
    expect(assumida.speed_kmh).toBe(ASSUMED_SPEED_KMH);
  });
});

describe('Janelas · avaliação de uma chegada', () => {
  const stop = { window_start: '2026-08-10T06:00:00.000Z', window_end: '2026-08-10T08:00:00.000Z' };

  it.each([
    ['2026-08-10T05:00:00.000Z', 'espera'],
    ['2026-08-10T07:00:00.000Z', 'dentro_da_janela'],
    ['2026-08-10T09:00:00.000Z', 'fora_da_janela'],
  ])('should classify an arrival at %s as %s', (quando, esperado) => {
    expect(evaluateArrival(Date.parse(quando), stop).status).toBe(esperado);
  });

  it('should not invent a window where none was agreed', () => {
    expect(evaluateArrival(Date.now(), {}).status).toBe('sem_janela');
  });
});

describe('Janelas · integração com o motor de distância', () => {
  it('should hand the windowed result back through optimizeStops', () => {
    const r = optimizeStops(
      TimeWindowFactory.comJanelaCedoNoFim(), ROUTE_ORIGIN, TimeWindowFactory.opcoes(),
    );

    expect(ids(r.stops)[0]).toBe('D');
    expect(r.arrival_estimates).toHaveLength(4);
    expect(r.distance_km).toBeGreaterThan(0);
    expect(r.speed_basis).toBe('measured');
  });

  it('should keep sending stops with no coordinates to the end', () => {
    // A regra do § 3.2 não muda por haver janelas: otimizar sem coordenadas
    // exigiria geocodificação, que é de outro serviço.
    const comSemCoords = [
      ...TimeWindowFactory.comJanelaCedoNoFim(),
      { order_id: 'X', label: 'sem coordenadas' },
    ];
    const r = optimizeStops(comSemCoords as any, ROUTE_ORIGIN, TimeWindowFactory.opcoes());

    expect(ids(r.stops).at(-1)).toBe('X');
    expect(r.unoptimized_stops).toEqual(['X']);
  });
});
