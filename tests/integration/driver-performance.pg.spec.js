/**
 * @file driver-performance.pg.spec.js
 * @description Desempenho dos motoristas contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.43
 *
 * O cálculo é puro e está coberto em driver-performance.service.spec.ts. O que
 * só a base mostra é que as taxas saem do trabalho ATRIBUÍDO a cada motorista
 * (§ 3.34) — sem essa atribuição o denominador seria a operação inteira — e que
 * um motorista sem encomendas continua a aparecer, sem julgamento.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { DriverFactory } from '../harness/factories/driver.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const perf   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/driver-performance.service`) : null;
const tenant = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const repos  = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-perf';
const BOM     = 'driver-itest-perf-bom';
const NOVO    = 'driver-itest-perf-novo';
const OUTRO   = 'driver-itest-perf-outro';

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM orders WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM drivers WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

/** Encomenda já atribuída a um motorista. */
async function semear(id, driverId, status, extra = {}) {
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination,
      cod_amount, cod_status, value, history, created_at, updated_at, company_id,
      driver_id, delivery_attempts)
    VALUES ($1,'c@itest.mz',$2,$3,'{}'::jsonb,'{"city":"Maputo"}'::jsonb,
      $4,$5,1000,'[]'::jsonb,$6,$6,$7,$8,$9)
  `, [
    id, `TRK99${id.slice(-6)}BR`, status,
    extra.cod_amount ?? 0, extra.cod_status ?? 'none',
    now, EMPRESA, driverId, extra.delivery_attempts ?? 0,
  ]);
}

const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

describe.skipIf(!disponivel)('desempenho dos motoristas · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await pool.query(
      `INSERT INTO companies (id, name, slug, status) VALUES ($1,'Desempenho ITEST',$1,'active')`, [EMPRESA],
    );

    await naEmpresa(async () => {
      for (const [id, nome, email] of [
        [BOM, 'Motorista Bom', 'bom.perf@itest.mz'],
        [NOVO, 'Motorista Novo', 'novo.perf@itest.mz'],
        [OUTRO, 'Motorista Outro', 'outro.perf@itest.mz'],
      ]) {
        await repos.DriverRepository.create(DriverFactory.build({ id, name: nome, email }));
      }
    });

    // BOM: 3 entregues (uma delas só depois de reagendar) + 1 falhada.
    await semear('order-perf-b1', BOM, 'delivered');
    await semear('order-perf-b2', BOM, 'delivered');
    await semear('order-perf-b3', BOM, 'delivered', { delivery_attempts: 2 });
    await semear('order-perf-b4', BOM, 'failed');
    // COD cobrado e por acertar.
    await semear('order-perf-b5', BOM, 'delivered', { cod_amount: 50_000, cod_status: 'collected' });

    // OUTRO: só uma devolvida — para o ranking ter com quem comparar.
    await semear('order-perf-o1', OUTRO, 'returned');
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should compute the rates from the work assigned to the driver', async () => {
    // Sem a atribuição do § 3.34, o denominador seria a operação inteira.
    const p = await naEmpresa(() => perf.getDriverPerformance(BOM));

    expect(p.deliveries).toBe(4);
    expect(p.failures).toBe(1);
    expect(p.sample_size).toBe(5);
    expect(p.success_rate_pct).toBe(80);
  });

  it('should not count a rescheduled delivery as first-attempt success', async () => {
    const p = await naEmpresa(() => perf.getDriverPerformance(BOM));

    // 3 das 4 entregas foram à primeira.
    expect(p.first_attempt_rate_pct).toBe(75);
  });

  it('should report unsettled COD separately from service quality', async () => {
    const p = await naEmpresa(() => perf.getDriverPerformance(BOM));
    expect(p.unsettled_cod_cents).toBe(50_000);
  });

  it('should leave punctuality null while no zone has an agreed target', async () => {
    // As encomendas deste teste não têm zona com prazo (§ 3.42).
    const p = await naEmpresa(() => perf.getDriverPerformance(BOM));

    expect(p.punctuality_pct).toBeNull();
    expect(p.punctuality_sample).toBe(0);
  });

  it('should show a driver without orders, judging nothing', async () => {
    // Desaparecer da lista faria parecer que não existe; 0% seria uma acusação.
    const { drivers } = await naEmpresa(() => perf.getDriversPerformance());
    const novo = drivers.find((d) => d.driver_id === NOVO);

    expect(novo).toBeTruthy();
    expect(novo.sample_size).toBe(0);
    expect(novo.success_rate_pct).toBeNull();
  });

  it('should rank the measured drivers above the ones without a sample', async () => {
    const { drivers } = await naEmpresa(() => perf.getDriversPerformance());
    const posicaoNovo = drivers.findIndex((d) => d.driver_id === NOVO);
    const posicaoBom  = drivers.findIndex((d) => d.driver_id === BOM);

    expect(posicaoBom).toBeLessThan(posicaoNovo);
    expect(drivers[0].driver_name).toBeTruthy();
  });

  it('should never expose a customer rating', async () => {
    // Nunca existiu recolha de avaliações; os 5,0 do cadastro eram inventados.
    const p = await naEmpresa(() => perf.getDriverPerformance(BOM));
    expect(p).not.toHaveProperty('customer_rating');
  });

  it('should not see another company drivers', async () => {
    const { drivers } = await tenant.runWithCompany('company-itest-perf-outra', () =>
      perf.getDriversPerformance());
    expect(drivers.find((d) => d.driver_id === BOM)).toBeUndefined();
  });
});
