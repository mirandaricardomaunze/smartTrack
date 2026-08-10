/**
 * @file operations.pg.spec.js
 * @description Dashboard operacional contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.39
 *
 * O defeito que motivou esta secção era o painel contar sobre a primeira página
 * de encomendas. O teste central aqui é por isso o que semeia mais encomendas do
 * que cabem numa página e confirma que a contagem não muda: se voltar a
 * agregar-se no navegador, este teste cai.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const operations = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/operations.service`) : null;
const tenant     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const repos      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

/** Empresa própria: as contagens são globais, e sem isolamento o teste mediria a base toda. */
const EMPRESA = 'company-itest-ops';
const PREFIXO = 'order-itest-ops-';

/** Mais do que a página de 200 que o painel antigo carregava. */
const TOTAL_SEMEADO = 210;

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM orders WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM drivers WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

/** Insere direto: 210 encomendas pelo caso de uso seria lento e desnecessário. */
async function semear(n, status, extra = {}) {
  const base = OrderFactory.build({ tracking_code: `TRK97${String(n).padStart(7, '0')}BR` });
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO orders (
      id, client_id, tracking_code, current_status, origin, destination,
      cod_amount, cod_status, value, history, created_at, updated_at, company_id,
      delivery_attempts, next_attempt_on, return_info
    ) VALUES ($1,$2,$3,$4,'{}'::jsonb,'{"city":"Maputo"}'::jsonb,$5,$6,1000,'[]'::jsonb,$7,$8,$9,$10,$11,$12)
  `, [
    `${PREFIXO}${String(n).padStart(4, '0')}`,
    base.client_id ?? 'cliente@itest.mz',
    base.tracking_code,
    status,
    extra.cod_amount ?? 0,
    extra.cod_status ?? 'none',
    now,
    extra.updated_at ?? now,
    EMPRESA,
    extra.delivery_attempts ?? 0,
    extra.next_attempt_on ?? null,
    extra.return_info ? JSON.stringify(extra.return_info) : null,
  ]);
}

/** Corre dentro do contexto da empresa do teste. */
const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

describe.skipIf(!disponivel)('dashboard operacional · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await repos.CompanyRepository.create({
      id: EMPRESA, name: 'Operações ITEST', slug: EMPRESA,
      status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    // 205 entregues + 5 falhadas = 210, acima da página de 200.
    for (let i = 1; i <= TOTAL_SEMEADO - 5; i += 1) await semear(i, 'delivered');
    for (let i = TOTAL_SEMEADO - 4; i <= TOTAL_SEMEADO; i += 1) await semear(i, 'failed');
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should count over the whole company, not over one page', async () => {
    // ESTE é o teste que impede a regressão: o painel antigo carregava 200 e
    // apresentava-as como o retrato da operação.
    const resumo = await naEmpresa(() => operations.getSummary());

    expect(resumo.orders.total).toBe(TOTAL_SEMEADO);
    expect(resumo.orders.delivered).toBe(TOTAL_SEMEADO - 5);
    expect(resumo.orders.failed).toBe(5);
  });

  it('should compute the success rate over what has finished, not over everything', async () => {
    // Contar as que ainda estão a caminho como insucesso dava uma taxa que
    // melhora sozinha com o tempo, sem ninguém fazer nada.
    const resumo = await naEmpresa(() => operations.getSummary());
    const esperada = Math.round(((TOTAL_SEMEADO - 5) / TOTAL_SEMEADO) * 1000) / 10;

    expect(resumo.orders.success_rate_pct).toBe(esperada);
  });

  it('should report the configured thresholds so the panel can explain itself', async () => {
    const resumo = await naEmpresa(() => operations.getSummary());

    expect(resumo.thresholds.stale_warehouse_days).toBe(operations.STALE_WAREHOUSE_DAYS);
    expect(resumo.thresholds.stale_transit_days).toBe(operations.STALE_TRANSIT_DAYS);
  });

  it('should not see another company orders', async () => {
    // As contagens são globais por natureza; sem o filtro de empresa este painel
    // seria uma fuga de dados entre clientes (§ 2.4).
    const resumo = await tenant.runWithCompany('company-itest-ops-outra', () => operations.getSummary());
    expect(resumo.orders.total).toBe(0);
  });

  // ── Fila de exceções ───────────────────────────────────────────────────────

  it('should list a failed delivery that nobody decided on', async () => {
    const fila = await naEmpresa(() => operations.getExceptions());
    const semDecisao = fila.exceptions.filter((e) => e.kind === 'failed_without_decision');

    expect(semDecisao.length).toBe(5);
    expect(semDecisao[0].label).toMatch(/^TRK97/);
    expect(semDecisao[0].detail).toMatch(/sem reagendamento nem devolução/i);
  });

  it('should drop it from the queue once it has been rescheduled', async () => {
    // É o que distingue "falhou e alguém já tratou" de "falhou e está parado" —
    // a pergunta que só o § 3.37 tornou respondível.
    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await pool.query(
      `UPDATE orders SET next_attempt_on = $1 WHERE id = $2`,
      [amanha, `${PREFIXO}${String(TOTAL_SEMEADO).padStart(4, '0')}`],
    );

    const fila = await naEmpresa(() => operations.getExceptions());
    const semDecisao = fila.exceptions.filter((e) => e.kind === 'failed_without_decision');

    expect(semDecisao.length).toBe(4);
  });

  it('should list a reschedule whose date has passed', async () => {
    const ontem = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await semear(900, 'in_transit', { next_attempt_on: ontem });

    const fila = await naEmpresa(() => operations.getExceptions());
    const vencidos = fila.exceptions.filter((e) => e.kind === 'overdue_reschedule');

    expect(vencidos.length).toBeGreaterThanOrEqual(1);
    expect(vencidos[0].age_days).toBeGreaterThanOrEqual(1);
    expect(vencidos[0].detail).toMatch(/atraso/i);
  });

  it('should not flag a future reschedule as overdue', async () => {
    const daquiATres = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await semear(901, 'in_transit', { next_attempt_on: daquiATres });

    const fila = await naEmpresa(() => operations.getExceptions());
    const labels = fila.exceptions.filter((e) => e.kind === 'overdue_reschedule').map((e) => e.label);

    expect(labels).not.toContain('TRK970000901BR');
  });

  it('should list cargo sitting in the warehouse beyond the threshold', async () => {
    const haMuito = new Date(Date.now() - (operations.STALE_WAREHOUSE_DAYS + 3) * 86_400_000).toISOString();
    await semear(902, 'at_warehouse', { updated_at: haMuito });
    // E uma acabada de chegar, que NÃO deve aparecer.
    await semear(903, 'at_warehouse');

    const fila = await naEmpresa(() => operations.getExceptions());
    const paradas = fila.exceptions.filter((e) => e.kind === 'stale_in_warehouse').map((e) => e.label);

    expect(paradas).toContain('TRK970000902BR');
    expect(paradas).not.toContain('TRK970000903BR');
  });

  it('should rank the queue with the most urgent first', async () => {
    const fila = await naEmpresa(() => operations.getExceptions());

    for (let i = 1; i < fila.exceptions.length; i += 1) {
      expect(fila.exceptions[i - 1].severity).toBeGreaterThanOrEqual(fila.exceptions[i].severity);
    }
  });

  it('should count the queue by kind', async () => {
    const fila = await naEmpresa(() => operations.getExceptions());

    expect(fila.total).toBe(fila.exceptions.length);
    const somaPorEspecie = Object.values(fila.counts).reduce((a, b) => a + b, 0);
    expect(somaPorEspecie).toBe(fila.total);
  });
});
