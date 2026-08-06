/**
 * @file orders-sync.pg.spec.js
 * @description Testes de integração do sync offline contra PostgreSQL.
 *
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md § Test Scenarios Required
 *
 * Prova, contra a base real, as três garantias da skill: idempotência (índice
 * UNIQUE em processed_events), resolução de conflitos com SERVER_WINS, e o
 * registo no conflict_log (nenhum descarte silencioso). O cenário vem inteiro do
 * fixture do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/orders-service && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import offlineBatches from './helpers/offline-batches.js';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('orders_db');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/orders-service/src/application/driver-sync.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/orders-service/src/infrastructure/pg.repository`).OrderRepository : null;
const pool = disponivel ? require(`${ROOT}/backend/orders-service/src/infrastructure/db`) : null;

const [happyBatch, conflictBatch] = offlineBatches;
const O1 = 'order-itest-0001';
const O2 = 'order-itest-0002';

// O fixture referencia order-test-uuid-000{1,2}; reapontamos para ids próprios
// do teste, para não colidir com dados de outras suites.
function retarget(batch, orderId) {
  return { ...batch, events: batch.events.map((e) => ({ ...e, order_id: orderId })) };
}

async function cleanup() {
  for (const id of [O1, O2]) {
    await pool.query('DELETE FROM conflict_log WHERE order_id = $1', [id]);
    await pool.query('DELETE FROM processed_events WHERE order_id = $1', [id]);
    await pool.query('DELETE FROM order_events WHERE order_id = $1', [id]);
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  }
}

describe.skipIf(!disponivel)('orders-service · sync offline · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();

    await repo.createOrder({ id: O1, tracking_code: 'TRK-ITEST-0001', client_id: 'c1', current_status: 'created' });
    await repo.createOrder({ id: O2, tracking_code: 'TRK-ITEST-0002', client_id: 'c2', current_status: 'out_for_delivery' });

    // O servidor já marcou O2 como entregue às 10:05 (concorrente do fixture)
    await repo.applyEvent({
      id: 'seed-itest-0002', order_id: O2, status: 'delivered',
      description: 'Entregue (servidor)', event_origin: 'SYSTEM',
      device_timestamp: conflictBatch.server_concurrent_event.server_timestamp,
    });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should apply the collection from the happy batch', async () => {
    const r = await svc.syncDriverEvents(retarget(happyBatch, O1));

    expect(r.applied).toBeGreaterThan(0);
    expect((await repo.findById(O1)).current_status).toBe('collected');
  });

  it('should let the server win over a stale offline failure', async () => {
    const r = await svc.syncDriverEvents(retarget(conflictBatch, O2));

    expect(r.applied).toBe(0);
    expect(r.conflicts).toBe(1);
    expect(r.details[0].resolution).toBe('SERVER_WINS');

    // O estado autoritativo não foi desfeito
    expect((await repo.findById(O2)).current_status).toBe('delivered');
  });

  it('should write the dropped event to conflict_log', async () => {
    const conflitos = await repo.conflictsForOrder(O2);

    expect(conflitos).toHaveLength(1);
    expect(conflitos[0].resolution).toBe('SERVER_WINS');
    // local_value é JSONB — tem de voltar como objeto, não string
    expect(typeof conflitos[0].local_value).toBe('object');
    expect(conflitos[0].local_value.status).toBe('failed');
  });

  it('should be idempotent when the same batch is re-sent', async () => {
    const antes = (await repo.conflictsForOrder(O1)).length;
    const r = await svc.syncDriverEvents(retarget(happyBatch, O1));

    expect(r.applied).toBe(0);
    expect(r.duplicates).toBeGreaterThan(0);
    // Reenviar não gera novos conflitos nem reaplica
    expect((await repo.conflictsForOrder(O1)).length).toBe(antes);
  });

  it('should block a duplicate dedupe key at the database level', async () => {
    // A idempotência não pode depender só da aplicação
    await expect(pool.query(
      `INSERT INTO processed_events (dedupe_key, order_id)
       SELECT dedupe_key, order_id FROM processed_events WHERE order_id = $1 LIMIT 1`,
      [O1],
    )).rejects.toMatchObject({ code: '23505' });
  });
});
