/**
 * @file dispatch.service.spec.ts
 * @description Testes unitários do planeador de despacho automático.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.38
 *
 * `planDispatch` é pura e é ela que decide quem leva o quê. É aqui que se afirma
 * o que nunca pode acontecer: passar a capacidade do veículo, dar carga a um
 * motorista ocupado, meter numa rota de hoje uma encomenda marcada para amanhã,
 * ou perder uma encomenda sem dizer porquê. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { DispatchFactory, MAPUTO_PONTOS } from '../../../../tests/harness';

const { planDispatch, orderEligibility, orderCoords } = require('./dispatch.service');

const HOJE = '2026-08-09';

describe('Despacho · elegibilidade da encomenda', () => {
  it('should accept an order sitting at the warehouse', () => {
    expect(orderEligibility(DispatchFactory.order(), HOJE).ok).toBe(true);
  });

  it('should refuse one that is already out for delivery, naming the state', () => {
    const r = orderEligibility(DispatchFactory.order({ current_status: 'out_for_delivery' }), HOJE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('out_for_delivery');
  });

  it('should refuse one scheduled for a future date', () => {
    // Foi para isto que o § 3.37 pôs a data no pedido: uma encomenda reagendada
    // para sexta não pode entrar na rota de terça.
    const r = orderEligibility(DispatchFactory.order({ next_attempt_on: '2026-08-15' }), HOJE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('2026-08-15');
  });

  it('should accept one scheduled for today — the day has come', () => {
    expect(orderEligibility(DispatchFactory.order({ next_attempt_on: HOJE }), HOJE).ok).toBe(true);
  });

  it('should refuse one without a destination', () => {
    const r = orderEligibility(DispatchFactory.order({ destination: {} as { city: string } }), HOJE);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('destino');
  });
});

describe('Despacho · coordenadas', () => {
  it('should read coordinates from the order', () => {
    expect(orderCoords(DispatchFactory.order())).toEqual(MAPUTO_PONTOS.baixa);
  });

  it('should give null when there are none, instead of a plausible guess', () => {
    // Atribuir uma coordenada plausível punha no mapa uma entrega que ninguém
    // sabe onde é.
    expect(orderCoords(DispatchFactory.withoutCoords())).toBeNull();
  });

  it('should reject coordinates outside the possible range', () => {
    expect(orderCoords(DispatchFactory.order({ coords: { lat: 95, lng: 32 } }))).toBeNull();
    expect(orderCoords(DispatchFactory.order({ coords: { lat: -25, lng: 300 } }))).toBeNull();
  });
});

describe('Despacho · plano', () => {
  it('should never load a vehicle above its capacity', () => {
    // Uma moto de 25 kg com seis encomendas de 5 kg: cinco cabem, a sexta não.
    const encomendas = Array.from({ length: 6 }, () => DispatchFactory.order({ weight_grams: 5_000 }));
    const plano = planDispatch(encomendas, [DispatchFactory.driver()], { today: HOJE });

    expect(plano.routes).toHaveLength(1);
    expect(plano.routes[0].load_kg).toBeLessThanOrEqual(25);
    expect(plano.routes[0].stops).toHaveLength(5);
    expect(plano.unassigned).toHaveLength(1);
    expect(plano.unassigned[0].reason).toMatch(/não coube/i);
  });

  it('should not give work to a driver who is already on a route', () => {
    // Um `on_route` leva carga que o sistema não sabe medir.
    const plano = planDispatch([DispatchFactory.order()], [DispatchFactory.busyDriver()], { today: HOJE });

    expect(plano.routes).toEqual([]);
    expect(plano.unassigned[0].reason).toMatch(/sem motoristas disponíveis/i);
  });

  it('should not give work to an offline driver either', () => {
    const plano = planDispatch([DispatchFactory.order()], [DispatchFactory.offlineDriver()], { today: HOJE });
    expect(plano.routes).toEqual([]);
  });

  it('should group nearby stops together before reaching for a distant one', () => {
    // Três na cidade e uma em Marracuene, a 28 km: partindo da baixa, a de
    // Marracuene tem de ser a última a entrar.
    const plano = planDispatch(DispatchFactory.clusteredOrders(), [DispatchFactory.vanDriver()], {
      today: HOJE, origin: MAPUTO_PONTOS.baixa,
    });

    expect(plano.routes).toHaveLength(1);
    const ordem = plano.routes[0].stops.map((s: any) => s.lat);
    expect(ordem[ordem.length - 1]).toBe(MAPUTO_PONTOS.marracuene.lat);
  });

  it('should spread across drivers when one vehicle is not enough', () => {
    const encomendas = Array.from({ length: 8 }, () => DispatchFactory.order({ weight_grams: 5_000 }));
    const plano = planDispatch(encomendas, [DispatchFactory.driver(), DispatchFactory.driver()], { today: HOJE });

    expect(plano.routes).toHaveLength(2);
    expect(plano.summary.planned_orders).toBe(8);
    expect(plano.unassigned).toEqual([]);
  });

  it('should let an order without weight travel, counting it as unknown', () => {
    // Inventar um peso médio produzia uma recusa (ou uma autorização) sem base.
    const plano = planDispatch(
      [DispatchFactory.withoutWeight(), DispatchFactory.order({ weight_grams: 5_000 })],
      [DispatchFactory.driver()],
      { today: HOJE },
    );

    expect(plano.routes[0].stops).toHaveLength(2);
    expect(plano.routes[0].unknown_weight).toBe(1);
    expect(plano.routes[0].load_kg).toBe(5);
  });

  it('should dispatch an order without coordinates, marking it as not geolocated', () => {
    // A morada existe e o motorista navega por ela — só não participa no
    // agrupamento geográfico, e o plano diz isso.
    const plano = planDispatch(
      [DispatchFactory.order(), DispatchFactory.withoutCoords()],
      [DispatchFactory.driver()],
      { today: HOJE },
    );

    const semCoords = plano.routes[0].stops.find((s: any) => s.lat === undefined);
    expect(semCoords).toBeTruthy();
    expect(semCoords.geolocated).toBe(false);
  });

  it('should name every order it could not place', () => {
    // Um plano que esconde as sobras deixa encomendas paradas sem ninguém saber
    // porquê.
    const plano = planDispatch(
      [DispatchFactory.order(), DispatchFactory.scheduledForTomorrow(), DispatchFactory.order({ current_status: 'delivered' })],
      [DispatchFactory.driver()],
      { today: HOJE },
    );

    expect(plano.unassigned).toHaveLength(2);
    for (const sobra of plano.unassigned) {
      expect(sobra.tracking_code).toBeTruthy();
      expect(sobra.reason).toBeTruthy();
    }
  });

  it('should skip a driver whose vehicle has no valid modal instead of guessing', () => {
    const semModal = DispatchFactory.driver({ vehicle: { type: 'HELICOPTERO', plate: 'X', capacity_kg: 500 } });
    const plano = planDispatch([DispatchFactory.order()], [semModal], { today: HOJE });

    expect(plano.routes).toEqual([]);
    expect(plano.unassigned).toHaveLength(1);
  });

  it('should survive having nothing to dispatch', () => {
    const plano = planDispatch([], [DispatchFactory.driver()], { today: HOJE });

    expect(plano.routes).toEqual([]);
    expect(plano.unassigned).toEqual([]);
    expect(plano.summary.planned_orders).toBe(0);
  });

  it('should report a summary that adds up', () => {
    const encomendas = Array.from({ length: 7 }, () => DispatchFactory.order({ weight_grams: 5_000 }));
    const plano = planDispatch(encomendas, [DispatchFactory.driver()], { today: HOJE });

    expect(plano.summary.eligible_orders).toBe(7);
    expect(plano.summary.planned_orders + plano.summary.unassigned).toBe(7);
    expect(plano.summary.drivers_used).toBe(plano.routes.length);
  });
});
