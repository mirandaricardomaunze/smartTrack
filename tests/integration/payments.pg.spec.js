/**
 * @file payments.pg.spec.js
 * @description Testes de integração do payments-service contra PostgreSQL real.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md
 *
 * O que só se prova aqui: BIGINT vem do pg como string (o repositório tem de
 * converter, senão os centavos viram texto e a aritmética financeira parte), e
 * o índice UNIQUE sobre `idempotency_key` é a última defesa contra cobrança
 * dupla em concorrência.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/payments-service && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

// DEVE vir antes de importar o serviço — ver nota em helpers/pg-env.js
useDatabase('payments_db');

const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/payments-service/src/application/payments.service`) : null;
const pool = disponivel ? require(`${ROOT}/backend/payments-service/src/infrastructure/db`) : null;

const carimbo  = Date.now();
const orderOk  = `ord-itest-ok-${carimbo}`;
const order422 = `ord-itest-422-${carimbo}`;
const order503 = `ord-itest-503-${carimbo}`;

describe.skipIf(!disponivel)('payments-service · PostgreSQL', () => {
  /** @type {object} */
  let pago;

  beforeAll(async () => {
    // Não dormir os 2s/8s reais entre retentativas
    svc.configurePorts({ sleep: async () => {} });
    pago = await svc.chargeOrder({ order_id: orderOk, value: 2990 });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await pool.query('DELETE FROM payments WHERE order_id = ANY($1)', [[orderOk, order422, order503]]);
    await pool.query("DELETE FROM payments WHERE id = 'p-itest-dup'");
    await pool.end();
    svc.resetPorts();
  });

  describe('tipos e persistência', () => {
    it('should charge successfully', () => {
      expect(pago.status).toBe('succeeded');
      expect(pago.gateway_transaction_id).toBeTruthy();
    });

    it('should return value as a number, not the BIGINT string', () => {
      // Se isto falhar, "2990" + 100 = "2990100" e a receita fica errada
      expect(typeof pago.value).toBe('number');
      expect(pago.value).toBe(2990);
    });

    it('should return attempt_number as a number', () => {
      expect(typeof pago.attempt_number).toBe('number');
      expect(pago.attempt_number).toBe(1);
    });

    it('should build the canonical idempotency key', () => {
      expect(pago.idempotency_key).toBe(`${orderOk}:charge:1`);
    });
  });

  describe('idempotência', () => {
    it('should not create a second charge for the same order', async () => {
      const repetido = await svc.chargeOrder({ order_id: orderOk, value: 2990 });

      expect(repetido.id).toBe(pago.id);
      expect(await svc.listPayments({ order_id: orderOk })).toHaveLength(1);
    });

    it('should let the unique index block a duplicate key', async () => {
      // A última defesa: dois processos em corrida não conseguem inserir a mesma tentativa
      await expect(pool.query(
        `INSERT INTO payments (id, order_id, value, status, gateway, idempotency_key, attempt_number, created_at, updated_at)
         VALUES ('p-itest-dup', $1, 2990, 'pending', 'MERCADO_PAGO', $2, 1, NOW(), NOW())`,
        [orderOk, `${orderOk}:charge:1`],
      )).rejects.toMatchObject({ code: '23505' });
    });

    it('should be idempotent when the same webhook is redelivered', async () => {
      const segredo = process.env.PAYMENTS_WEBHOOK_SECRET;
      // Só corre se o .env tiver segredo — senão o handler recusa, e com razão
      if (!segredo) return;

      const r = await svc.handleWebhook(
        { transaction_id: pago.gateway_transaction_id, status: 'succeeded' },
        segredo,
      );

      expect(r.processed).toBe(false);
      expect(r.reason).toBe('já processado');
    });
  });

  describe('política de retentativa', () => {
    it('should not retry on a 4xx from the gateway', async () => {
      const recusado = await svc.chargeOrder({ order_id: order422, value: 2922 });

      expect(recusado.status).toBe('failed');
      expect(recusado.attempt_number).toBe(1);
    });

    it('should retry up to the max on a 5xx and rotate the key', async () => {
      const esgotado = await svc.chargeOrder({ order_id: order503, value: 2903 });

      expect(esgotado.status).toBe('failed');
      expect(esgotado.attempt_number).toBe(3);
      expect(esgotado.idempotency_key).toBe(`${order503}:charge:3`);
    });
  });

  describe('consultas e conciliação', () => {
    it('should return aggregates as numbers', async () => {
      const stats = await svc.getStats();

      expect(typeof stats.succeeded).toBe('number');
      expect(typeof stats.revenue_cents).toBe('number');
    });

    it('should find no succeeded payment without a transaction id', async () => {
      const rel = await svc.reconcile(new Date(Date.now() - 3_600_000).toISOString());

      expect(typeof rel.total_cents).toBe('number');
      expect(rel.missing_transaction).toEqual([]);
    });
  });

  describe('constraints', () => {
    it('should reject a non-positive amount at the database level', async () => {
      await expect(pool.query(
        `INSERT INTO payments (id, order_id, value, status, gateway, idempotency_key, attempt_number, created_at, updated_at)
         VALUES ('p-itest-neg', 'x', -100, 'pending', 'MERCADO_PAGO', 'x:charge:1', 1, NOW(), NOW())`,
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});
