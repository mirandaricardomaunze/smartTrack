/**
 * @file routes-tenant.pg.spec.js
 * @description Isolamento das rotas por empresa, contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4 (Multiempresa)
 *
 * Ficheiro próprio e contra `track` — a base única onde o servidor corre — e não
 * dentro de `routes.pg.spec.js`, que aponta para a `routes_db` de
 * desenvolvimento e fecha o pool no fim.
 *
 * PORQUÊ EXISTE: `routes` era a única tabela de serviço sem `company_id`, e o
 * repositório fazia `SELECT * FROM routes` sem filtro nenhum. Um ADMIN de uma
 * empresa via as rotas de todas as outras — motoristas, moradas das paradas e
 * números de encomenda de outros clientes da plataforma.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc    = disponivel ? require(`${ROOT}/backend/routes-service/src/application/routes.service`) : null;
const tenant = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA_A = 'company-itest-rotas-a';
const EMPRESA_B = 'company-itest-rotas-b';
const MOTORISTA = 'driver-itest-rotas-a';

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM routes WHERE company_id = ANY($1::text[])', [[EMPRESA_A, EMPRESA_B]]);
}

describe.skipIf(!disponivel)('rotas · isolamento por empresa · PostgreSQL', () => {
  beforeAll(limpar);

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should not show one company the routes of another', async () => {
    await tenant.runWithCompany(EMPRESA_A, () => svc.createRoute({
      driver_id: MOTORISTA,
      stops: [{ order_id: 'order-iso-1', address: 'Av. Julius Nyerere, Maputo' }],
    }));

    const daA = await tenant.runWithCompany(EMPRESA_A, () => svc.listRoutes());
    const daB = await tenant.runWithCompany(EMPRESA_B, () => svc.listRoutes());

    expect(daA.length).toBe(1);
    expect(daB).toEqual([]);
  });

  it('should not let another company read a route by its id', async () => {
    // Adivinhar o id não pode dar acesso: o filtro é da consulta, não da UI.
    const rota = await tenant.runWithCompany(EMPRESA_A, () => svc.createRoute({
      driver_id: MOTORISTA,
      stops: [{ order_id: 'order-iso-2', address: 'Matola' }],
    }));

    await expect(tenant.runWithCompany(EMPRESA_B, () => svc.getRoute(rota.id)))
      .rejects.toMatchObject({ name: 'RouteNotFoundError' });
  });

  it('should not count another company routes in the stats', async () => {
    const statsB = await tenant.runWithCompany(EMPRESA_B, () => svc.getStats());
    expect(statsB.planned).toBe(0);
  });

  it('should not let another company touch a route it cannot see', async () => {
    const rota = await tenant.runWithCompany(EMPRESA_A, () => svc.createRoute({
      driver_id: MOTORISTA,
      stops: [{ order_id: 'order-iso-3', address: 'Matola' }],
    }));

    // Escrever é tão sensível como ler: sem filtro no UPDATE, uma empresa podia
    // cancelar a rota de outra.
    await expect(tenant.runWithCompany(EMPRESA_B, () => svc.updateRouteStatus(rota.id, { new_status: 'CANCELADA' })))
      .rejects.toMatchObject({ name: 'RouteNotFoundError' });

    const inalterada = await tenant.runWithCompany(EMPRESA_A, () => svc.getRoute(rota.id));
    expect(inalterada.status).toBe('PLANEJADA');
  });
});
