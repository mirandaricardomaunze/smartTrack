/**
 * @file monitoring.pg.spec.js
 * @description Registo central de erros e alertas, contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * O que aqui se prova só se prova com base: que o erro fica gravado com o id de
 * correlação que o cliente recebeu (é assim que uma queixa chega à linha certa),
 * que a listagem não devolve a pilha de chamadas, e que os alertas descrevem o
 * estado real em vez de repetirem um valor fixo.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { MonitoringFactory } from '../harness/factories/monitoring.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const monitoring = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/monitoring.service`) : null;
const contexto   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const CAMINHO = '/v1/itest-monitoring';
const CORRELACAO = 'corr-itest-monitoring-0001';

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM error_events WHERE path = $1', [CAMINHO]);
}

describe.skipIf(!disponivel)('observabilidade · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    monitoring.resetMetrics();
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should store an unexpected error under the correlation id the client saw', async () => {
    const erro = new TypeError('Cannot read properties of undefined');

    const id = await contexto.runWithContext({ companyId: null, correlationId: CORRELACAO }, () =>
      monitoring.recordError(erro, { method: 'POST', path: CAMINHO, status: 500, user_id: 'user-itest-0001' }));

    expect(id).toBeTruthy();

    const { rows } = await pool.query('SELECT * FROM error_events WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(CORRELACAO);
    expect(rows[0].error_name).toBe('TypeError');
    expect(rows[0].path).toBe(CAMINHO);
    // A pilha fica guardada — é o que torna o erro diagnosticável.
    expect(rows[0].stack).toContain('TypeError');
  });

  it('should count the write in the sink health', () => {
    expect(monitoring.getMetrics().error_sink.recorded).toBeGreaterThan(0);
    expect(monitoring.getMetrics().error_sink.failed).toBe(0);
  });

  it('should list recent errors without leaking the stack trace', async () => {
    const erros = await monitoring.listErrors({ limit: 10 });
    const meu = erros.find((e) => e.path === CAMINHO);

    expect(meu).toBeTruthy();
    // O caminho dos ficheiros do servidor não vai para o navegador de quem
    // consulta a lista; a pilha lê-se pelo id, não na listagem.
    expect(meu).not.toHaveProperty('stack');
    expect(meu.message).toContain('Cannot read properties');
  });

  it('should cap the limit instead of letting a caller ask for the whole table', async () => {
    // `limit=100000` numa tabela de erros de meses é uma forma barata de deitar
    // o processo abaixo a partir de um pedido autenticado.
    const erros = await monitoring.listErrors({ limit: 100_000 });
    expect(erros.length).toBeLessThanOrEqual(200);
  });

  it('should report the database as reachable, with a latency', async () => {
    const base = await monitoring.checkDatabase();

    expect(base.ok).toBe(true);
    expect(base.latency_ms).toBeGreaterThanOrEqual(0);
    expect(base.error).toBeNull();
  });

  it('should stay quiet when nothing is wrong', async () => {
    const { status, alerts } = await monitoring.getAlerts({
      auditHealth: () => ({ recorded: 10, failed: 0, last_error: null }),
      providers:   () => [{ name: 'email', simulated: true }],
    });

    // Provedor simulado FORA de produção não é alerta: é o modo de trabalho
    // normal em desenvolvimento. Alertar aqui ensinaria a ignorar alertas.
    expect(status).toBe('ok');
    expect(alerts).toEqual([]);
  });

  it('should raise a critical alert when the audit trail has holes', async () => {
    const { status, alerts } = await monitoring.getAlerts({
      auditHealth: () => ({ recorded: 4, failed: 3, last_error: 'ligação recusada' }),
    });

    expect(status).toBe('critical');
    const alerta = alerts.find((a) => a.key === 'audit_write_failing');
    expect(alerta.severity).toBe('critical');
    // Um alerta sem ação é um gráfico — e gráficos não resolvem incidentes.
    expect(alerta.action).toBeTruthy();
  });

  it('should raise an alert when the error rate crosses the threshold', async () => {
    monitoring.resetMetrics();
    const total = monitoring.ERROR_RATE_MIN_SAMPLE + 10;
    for (let i = 0; i < total; i += 1) {
      const falha = i % 2 === 0; // 50% — bem acima do limiar
      monitoring.observeRequest(MonitoringFactory.request(), falha ? 500 : 200, 12);
    }

    const { status, alerts } = await monitoring.getAlerts();
    expect(status).toBe('critical');
    expect(alerts.some((a) => a.key === 'error_rate_high')).toBe(true);
  });

  it('should not raise the rate alert on a sample too small to mean anything', async () => {
    monitoring.resetMetrics();
    // Dois pedidos, um falhado: 50% de "taxa de erro" que não diz nada. Alertar
    // aqui é acordar alguém por causa de um único pedido.
    monitoring.observeRequest(MonitoringFactory.request(), 500, 12);
    monitoring.observeRequest(MonitoringFactory.request(), 200, 12);

    const { alerts } = await monitoring.getAlerts();
    expect(alerts.some((a) => a.key === 'error_rate_high')).toBe(false);
  });
});
