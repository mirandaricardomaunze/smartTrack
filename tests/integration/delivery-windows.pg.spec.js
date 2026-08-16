/**
 * @file delivery-windows.pg.spec.js
 * @description Janela de entrega, do registo do pedido ao plano de rota.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.48
 *
 * O motor de janelas tinha 17 testes e estava INALCANÇÁVEL: não havia onde
 * guardar uma janela nem por onde a fazer chegar até ele. Este teste percorre o
 * caminho todo — registar com janela, ler de volta, e ver a janela chegar à
 * parada que o motor recebe. É o que distingue "implementado" de "utilizável".
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { DispatchFactory } from '../harness';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const orders   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const dispatch = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/dispatch.service`) : null;
const tenant   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-janela';
const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

/** Base fixa: as horas têm de ser afirmáveis. */
const PARTIDA = '2026-09-01T06:00:00.000Z';
const maisHoras = (h) => new Date(Date.parse(PARTIDA) + h * 3_600_000).toISOString();

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM orders WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

describe.skipIf(!disponivel)('janelas de entrega · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await pool.query(
      `INSERT INTO companies (id, name, slug, status) VALUES ($1,'Janelas ITEST',$1,'active')`,
      [EMPRESA],
    );
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should keep the agreed window from registration to read-back', async () => {
    const criada = await naEmpresa(() => orders.createOrder({
      tracking_code: 'TRK800000001BR',
      client: 'Cliente com janela',
      destination: 'Maputo',
      window_start: maisHoras(2),
      window_end: maisHoras(5),
      delivery_priority: 'alta',
    }));

    const lida = await naEmpresa(() => orders.getOrderTracking('TRK800000001BR'));

    expect(lida.window_start).toBe(maisHoras(2));
    expect(lida.window_end).toBe(maisHoras(5));
    expect(lida.delivery_priority).toBe('alta');
  });

  it('should leave an order with no window untouched', async () => {
    // O caso que protege todas as encomendas que já existem: sem janela, nada
    // muda — nem no registo, nem no motor.
    const criada = await naEmpresa(() => orders.createOrder({
      tracking_code: 'TRK800000002BR',
      client: 'Cliente sem janela',
      destination: 'Beira',
    }));

    expect(criada.window_start).toBeUndefined();
    expect(criada.window_end).toBeUndefined();
    expect(criada.delivery_priority).toBeUndefined();
  });

  it('should refuse a window that ends before it starts', async () => {
    // Não é impossível de guardar — é impossível de CUMPRIR. Guardada,
    // produziria uma violação garantida em todas as rotas onde entrasse.
    await expect(naEmpresa(() => orders.createOrder({
      tracking_code: 'TRK800000003BR',
      client: 'Cliente impossível',
      destination: 'Maputo',
      window_start: maisHoras(6),
      window_end: maisHoras(3),
    }))).rejects.toThrow(/window/i);
  });

  it('should accept a one-sided window', async () => {
    // "Depois das 14h" é uma combinação real; exigir a outra ponta obrigaria
    // quem regista a inventá-la.
    const criada = await naEmpresa(() => orders.createOrder({
      tracking_code: 'TRK800000004BR',
      client: 'Só depois das',
      destination: 'Matola',
      window_start: maisHoras(8),
    }));

    expect(criada.window_start).toBe(maisHoras(8));
    expect(criada.window_end).toBeUndefined();
  });

  it('should carry the window onto the stop the route engine receives', async () => {
    // O elo que faltava: sem ele, o motor com 17 testes nunca via uma janela.
    const comJanela = DispatchFactory.withWindow({
      window_start: maisHoras(1),
      window_end: maisHoras(3),
    });

    const plano = dispatch.planDispatch(
      [comJanela],
      [DispatchFactory.vanDriver()],
      { today: PARTIDA.slice(0, 10) },
    );

    expect(plano.unassigned).toEqual([]);
    const parada = plano.routes.flatMap((r) => r.stops)
      .find((p) => p.order_id === comJanela.id);

    expect(parada).toBeDefined();
    expect(parada.window_start).toBe(maisHoras(1));
    expect(parada.window_end).toBe(maisHoras(3));
    expect(parada.priority).toBe('alta');
  });

  it('should warn about an impossible window while the plan can still be changed', () => {
    // O ponto todo do § 3.48 no despacho: a janela fechou ontem, e quem revê o
    // plano vê isso ANTES de a rota sair. Descoberta depois, a falha só aparece
    // à porta do cliente.
    const impossivel = DispatchFactory.withWindow({
      window_start: '2026-08-31T06:00:00.000Z',
      window_end: '2026-08-31T08:00:00.000Z',
    });

    const plano = dispatch.planDispatch([impossivel], [DispatchFactory.vanDriver()], {
      today: PARTIDA.slice(0, 10),
      departure_at: PARTIDA,
    });

    const rota = plano.routes[0];
    expect(rota.window_violations).toHaveLength(1);
    expect(rota.window_violations[0].late_minutes).toBeGreaterThan(0);

    // E continua na rota: tirá-la fá-la-ia desaparecer da operação.
    expect(rota.stops.map((p) => p.order_id)).toContain(impossivel.id);
  });

  it('should say nothing about windows on a route that has none', () => {
    // Campo ausente e lista vazia são coisas diferentes: "não tem janelas" não é
    // "verificadas e todas cabem".
    const plano = dispatch.planDispatch([DispatchFactory.order()], [DispatchFactory.vanDriver()],
      { today: PARTIDA.slice(0, 10) });

    expect(plano.routes[0].window_violations).toBeUndefined();
  });

  it('should leave a stop with no window free of invented ones', () => {
    // Uma janela inventada aqui criaria compromissos que ninguém assumiu.
    const semJanela = DispatchFactory.order();
    const plano = dispatch.planDispatch([semJanela], [DispatchFactory.vanDriver()],
      { today: PARTIDA.slice(0, 10) });
    const parada = plano.routes.flatMap((r) => r.stops)[0];

    expect(parada.window_start).toBeUndefined();
    expect(parada.window_end).toBeUndefined();
    expect(parada.priority).toBeUndefined();
  });
});
