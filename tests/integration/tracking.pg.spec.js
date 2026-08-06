/**
 * @file tracking.pg.spec.js
 * @description Testes de integração do tracking-intl-service contra PostgreSQL.
 *
 * Prova o que os fakes escondem: o índice UNIQUE sobre event_hash (a defesa
 * estrutural contra a duplicação do polling) e o round-trip do histórico.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/tracking-intl-service && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('tracking_db');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/tracking-intl-service/src/application/tracking.service`) : null;
const pool = disponivel ? require(`${ROOT}/backend/tracking-intl-service/src/infrastructure/db`) : null;

const code = `LX000000004CN`;

describe.skipIf(!disponivel)('tracking-intl-service · PostgreSQL', () => {
  beforeAll(async () => {
    await pool.query('DELETE FROM tracking_events WHERE tracking_code = $1', [code]);
    await pool.query('DELETE FROM tracked_shipments WHERE tracking_code = $1', [code]);
    await svc.trackShipment({ tracking_code: code, carrier: '17TRACK' });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await pool.query('DELETE FROM tracking_events WHERE tracking_code = $1', [code]);
    await pool.query('DELETE FROM tracked_shipments WHERE tracking_code = $1', [code]);
    await pool.end();
  });

  it('should persist normalized events on the first poll', async () => {
    const r = await svc.pollShipment({ tracking_code: code, carrier: '17TRACK' });

    expect(r.polled).toBe(true);
    expect(r.new_events).toBe(4);
    expect(r.current_status).toBe('out_for_delivery');
  });

  it('should not duplicate events when polled again (unique event_hash)', async () => {
    // O polling relê o histórico completo — o índice UNIQUE é a última defesa
    const r = await svc.pollShipment({ tracking_code: code, carrier: '17TRACK' });

    expect(r.new_events).toBe(0);

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM tracking_events WHERE tracking_code = $1',
      [code],
    );
    expect(rows[0].n).toBe(4);
  });

  it('should store the canonical status and keep the raw value', async () => {
    const { rows } = await pool.query(
      `SELECT status, raw_status FROM tracking_events
        WHERE tracking_code = $1 AND raw_status = 'Picked up' LIMIT 1`,
      [code],
    );

    expect(rows[0].status).toBe('collected');   // canônico
    expect(rows[0].raw_status).toBe('Picked up'); // cru, auditoria
  });

  it('should return the history newest-first with the current status', async () => {
    const t = await svc.getTracking(code);

    expect(t.events).toHaveLength(4);
    expect(t.current_status).toBe('out_for_delivery');
    expect(new Date(t.events[0].carrier_timestamp).getTime())
      .toBeGreaterThan(new Date(t.events[3].carrier_timestamp).getTime());
  });

  it('should return counts as numbers', async () => {
    const stats = await svc.getStats();

    expect(typeof stats.events).toBe('number');
    expect(typeof stats.active_shipments).toBe('number');
  });

  it('should reject the unique index on a duplicate event_hash', async () => {
    await expect(pool.query(
      `INSERT INTO tracking_events (id, tracking_code, carrier, status, raw_status, carrier_timestamp, event_hash, created_at)
       SELECT 'dup-1', tracking_code, carrier, status, raw_status, carrier_timestamp, event_hash, NOW()
         FROM tracking_events WHERE tracking_code = $1 LIMIT 1`,
      [code],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('should reject an invalid canonical status', async () => {
    await expect(pool.query(
      `INSERT INTO tracking_events (id, tracking_code, carrier, status, raw_status, carrier_timestamp, event_hash, created_at)
       VALUES ('bad-1', $1, '17TRACK', 'INVENTADO', 'x', NOW(), 'hash-bad-1', NOW())`,
      [code],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
