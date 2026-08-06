/**
 * @file routes.pg.spec.js
 * @description Testes de integração do routes-service contra PostgreSQL real.
 *
 * Cobre o que os fakes em memória escondem: tipos devolvidos pelo driver pg
 * (NUMERIC vem como string), round-trip de JSONB e constraints da tabela.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/routes-service && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

// DEVE vir antes de importar o serviço — ver nota em helpers/pg-env.js
useDatabase('routes_db');

const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/routes-service/src/application/routes.service`) : null;
const pool = disponivel ? require(`${ROOT}/backend/routes-service/src/infrastructure/db`) : null;

const driverId = `driver-itest-${Date.now()}`;

describe.skipIf(!disponivel)('routes-service · PostgreSQL', () => {
  /** @type {object} */
  let rota;

  beforeAll(async () => {
    rota = await svc.createRoute({
      driver_id: driverId,
      origin: { lat: 0, lng: 0 },
      stops: [
        { order_id: 'o-c', address: 'C', lat: 0, lng: 3 },
        { order_id: 'o-a', address: 'A', lat: 0, lng: 1 },
        { order_id: 'o-b', address: 'B', lat: 0, lng: 2 },
      ],
    });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await pool.query('DELETE FROM routes WHERE driver_id = $1', [driverId]);
    await pool.query("DELETE FROM routes WHERE id = 'r-itest-bad'");
    await pool.end();
  });

  describe('persistência', () => {
    it('should round-trip stops through JSONB as an array', () => {
      expect(Array.isArray(rota.stops)).toBe(true);
      expect(rota.stops).toHaveLength(3);
    });

    it('should preserve the optimized order', () => {
      expect(rota.stops.map((s) => s.order_id)).toEqual(['o-a', 'o-b', 'o-c']);
    });

    it('should return distance_km as a number, not the NUMERIC string', () => {
      // pg devolve NUMERIC como string — o repositório tem de converter
      expect(typeof rota.distance_km).toBe('number');
      expect(rota.distance_km).toBeGreaterThan(0);
    });

    it('should return coordinates as numbers on re-read', async () => {
      const lida = await svc.getRoute(rota.id);

      expect(typeof lida.stops[0].lat).toBe('number');
      expect(typeof lida.stops[0].lng).toBe('number');
    });

    it('should derive the summary', () => {
      expect(rota.summary).toEqual({ total: 3, delivered: 0, failed: 0, pending: 3 });
    });
  });

  describe('ciclo de vida', () => {
    it('should transition to EM_ANDAMENTO and mark a stop', async () => {
      const emAndamento = await svc.updateRouteStatus(rota.id, { new_status: 'EM_ANDAMENTO' });
      expect(emAndamento.status).toBe('EM_ANDAMENTO');

      const marcada = await svc.updateStopStatus(rota.id, 'o-a', { status: 'delivered' });
      expect(marcada.summary.delivered).toBe(1);
    });

    it('should reoptimize keeping resolved stops first', async () => {
      const reot = await svc.reoptimizeRoute(rota.id, {
        new_stops: [{ order_id: 'o-d', address: 'D', lat: 0, lng: 0.5 }],
        origin: { lat: 0, lng: 0 },
      });

      expect(reot.stops).toHaveLength(4);
      // A parada já entregue aconteceu no mundo real — não é reordenada
      expect(reot.stops[0].order_id).toBe('o-a');
      expect(reot.stops.map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('consultas', () => {
    it('should return counts as numbers', async () => {
      const stats = await svc.getStats();

      // COUNT(*) vem como string do pg
      expect(typeof stats.planned).toBe('number');
      expect(typeof stats.in_progress).toBe('number');
    });

    it('should filter by driver', async () => {
      const lista = await svc.listRoutes({ driver_id: driverId });
      expect(lista).toHaveLength(1);
    });
  });

  describe('constraints', () => {
    it('should reject an invalid status at the database level', async () => {
      // A defesa não pode depender só do domínio
      await expect(pool.query(
        `INSERT INTO routes (id, driver_id, stops, status, optimized_at, created_at, updated_at)
         VALUES ('r-itest-bad', 'd', '[]', 'INVENTADO', NOW(), NOW(), NOW())`,
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});
