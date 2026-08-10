/**
 * @file delivery-e2e.pg.spec.js
 * @description Percurso completo de uma encomenda, contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.34
 *
 * criar → recolher → despachar → transportar → sair para entrega → entregar →
 * apresentar a prova.
 *
 * PORQUÊ ESTE FICHEIRO EXISTE quando já há um teste por troço: os testes por
 * troço partem de uma encomenda semeada no estado de que precisam. Isso esconde
 * as juntas. Foi numa junta que apareceu o defeito que motivou este teste — a
 * criação da rota gravava as paradas e deixava o pedido sem `driver_id`, pelo
 * que a partir do despacho a aplicação do motorista levava 403 em tudo. Aqui
 * nada é semeado a meio: cada estado é o resultado do passo anterior.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate -- --reset-core`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { DeliveryJourney } from '../harness/journeys/delivery-journey';
import { DriverFactory } from '../harness/factories/driver.factory';
import { PodFactory } from '../harness/factories/pod.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const orders   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const routes   = disponivel ? require(`${ROOT}/backend/routes-service/src/application/routes.service`) : null;
const dispatch = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/dispatch.service`) : null;
const repos    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const CODIGO_ENTREGA = 'TRK900000001BR';
const CODIGO_PESADO  = 'TRK900000002BR';
const MOTORISTA      = 'driver-itest-e2e-0001';
const MORADA         = 'Av. Julius Nyerere 1200, Maputo';

/** Motociclista: 25 kg de teto. É o veículo que torna a recusa de carga real. */
const motociclista = DriverFactory.build({
  id: MOTORISTA,
  name: 'Motorista E2E',
  vehicle: { type: 'MOTO', plate: 'E2E0001', capacity_kg: 25 },
});

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM order_pod_images WHERE order_id IN (SELECT id FROM orders WHERE tracking_code = ANY($1::text[]))', [[CODIGO_ENTREGA, CODIGO_PESADO]]);
  await pool.query('DELETE FROM orders  WHERE tracking_code = ANY($1::text[])', [[CODIGO_ENTREGA, CODIGO_PESADO]]);
  await pool.query('DELETE FROM routes  WHERE driver_id = $1', [MOTORISTA]);
  await pool.query('DELETE FROM drivers WHERE id = $1', [MOTORISTA]);
}

describe.skipIf(!disponivel)('percurso da encomenda · ponta a ponta · PostgreSQL', () => {
  /** @type {DeliveryJourney} */
  let jornada;

  beforeAll(async () => {
    await limpar();
    await repos.DriverRepository.create(motociclista);

    jornada = new DeliveryJourney({ orders, routes, dispatch }, {
      trackingCode:   CODIGO_ENTREGA,
      client:         'cliente.e2e@exemplo.mz',
      destination:    'Maputo',
      driverId:       MOTORISTA,
      address:        MORADA,
      weightGrams:    4_500,   // 4,5 kg — cabe na moto
      codAmountCents: 0,
    });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should register the order awaiting collection', async () => {
    const order = await jornada.criar();

    expect(order.current_status).toBe('created');
    expect(order.tracking_code).toBe(CODIGO_ENTREGA);
    // O primeiro evento abre a cadeia de hash: sem ele nada do resto é verificável.
    expect(order.history).toHaveLength(1);
    expect(order.history[0].hash).toBeTruthy();
  });

  it('should collect it from the sender', async () => {
    const order = await jornada.recolher();
    expect(order.current_status).toBe('collected');
  });

  it('should dispatch it: route created AND order handed to the driver', async () => {
    await jornada.despachar();

    expect(jornada.route.driver_id).toBe(MOTORISTA);
    expect(jornada.route.stops).toHaveLength(1);
    expect(jornada.assignment.skipped).toEqual([]);

    // O ponto do teste. Sem estes dois campos a rota existe e o motorista
    // continua sem a encomenda: o guard de dono recusa-lhe o estado e o lote
    // de sincronização offline leva 403 inteiro.
    expect(jornada.order.driver_id).toBe(MOTORISTA);
    expect(jornada.order.route_id).toBe(jornada.route.id);

    // Despachar não move a encomenda — o veículo ainda não saiu.
    expect(jornada.order.current_status).toBe('collected');
  });

  it('should let the assigned driver move it through transport', async () => {
    expect((await jornada.transportar()).current_status).toBe('in_transit');
    expect((await jornada.sairParaEntrega()).current_status).toBe('out_for_delivery');

    // O evento traz a origem: quem auditar distingue o que o motorista fez do
    // que o painel fez por ele.
    expect(jornada.order.history[0].event_origin).toBe('DRIVER_APP');
    expect(jornada.order.history[0].user_id).toBe(MOTORISTA);
  });

  it('should deliver with proof and keep the chain intact', async () => {
    const pod = PodFactory.build({ recipient_name: 'Ana Cliente' });
    const order = await jornada.entregar({
      recipient_name: pod.recipient_name,
      signature:      pod.signature,
      lat:            pod.coords.lat,
      lng:            pod.coords.lng,
    });

    expect(order.current_status).toBe('delivered');
    expect(order.pod.recipient_name).toBe('Ana Cliente');
    // A resposta confirma que há assinatura sem a devolver (§ 3.28).
    expect(order.pod.has_signature).toBe(true);
    expect(order.pod.signature).toBeUndefined();

    // A cadeia de eventos liga o último ao anterior, sem furos.
    const eventos = [...order.history].reverse();
    for (let i = 1; i < eventos.length; i += 1) {
      expect(eventos[i].parent_hash).toBe(eventos[i - 1].hash);
    }
  });

  it('should show the client the proof under their tracking code', async () => {
    const { rastreio, imagens } = await jornada.provaDeEntrega();

    expect(rastreio.current_status).toBe('delivered');
    expect(rastreio.pod.recipient_name).toBe('Ana Cliente');
    expect(imagens.signature).toContain('data:image/png');
  });

  it('should have walked the operational path in order', () => {
    expect(jornada.trilho).toEqual([
      'created',
      'collected',
      'collected',        // despacho atribui, não transporta
      'in_transit',
      'out_for_delivery',
      'delivered',
      'delivered',
    ]);
  });

  it('should refuse to dispatch a load the vehicle cannot carry', async () => {
    // 60 kg numa moto de 25 kg não é uma rota ineficiente, é uma rota
    // impossível — e quem a descobria era o motorista no armazém (§ 3.33).
    const pesada = new DeliveryJourney({ orders, routes, dispatch }, {
      trackingCode: CODIGO_PESADO,
      client:       'cliente.e2e@exemplo.mz',
      destination:  'Maputo',
      driverId:     MOTORISTA,
      address:      MORADA,
      weightGrams:  60_000,
    });

    await pesada.criar();
    await pesada.recolher();
    await expect(pesada.despachar()).rejects.toThrow(/não cabe|excede/i);

    // E a encomenda não ficou presa a um motorista que não a leva.
    const recusada = await orders.getOrderTracking(CODIGO_PESADO);
    expect(recusada.driver_id).toBeUndefined();
    expect(recusada.current_status).toBe('collected');
  });
});
