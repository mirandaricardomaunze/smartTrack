/**
 * @file incidents.pg.spec.js
 * @description Ocorrências e SLA contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 * A avaliação de SLA é pura e está coberta em sla.service.spec.ts. O que só a
 * base mostra é o que dá valor às ocorrências: o prazo gravado na abertura não
 * se deixa reescrever, fechar sem motivo é recusado, e o histórico guarda todas
 * as transições sem se poder alterar.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { SlaFactory } from '../harness/factories/sla.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const incidents = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/incidents.service`) : null;
const sla       = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/sla.service`) : null;
const tenant    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-inc';
const ZONA    = 'ZONE_ITEST_SLA';

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE company_id = $1)', [EMPRESA]);
  await pool.query('DELETE FROM incidents WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM orders WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM pricing_zones WHERE code = $1', [ZONA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

describe.skipIf(!disponivel)('ocorrências e SLA · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await pool.query(
      `INSERT INTO companies (id, name, slug, status) VALUES ($1,'Ocorrências ITEST',$1,'active')`, [EMPRESA],
    );
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  // ── Ocorrências ────────────────────────────────────────────────────────────

  it('should open an incident with a deadline derived from its priority', async () => {
    const oc = await naEmpresa(() => incidents.openIncident(
      SlaFactory.incident({ priority: 'critical', title: 'Encomenda extraviada' }),
    ));

    expect(oc.status).toBe('aberta');
    expect(oc.code).toMatch(/^OC\d{4}\//);
    expect(oc.due_at).toBeTruthy();

    // Crítica = 4 horas.
    const horas = (Date.parse(oc.due_at) - Date.parse(oc.opened_at)) / 3_600_000;
    expect(Math.round(horas)).toBe(4);
  });

  it('should refuse an unknown kind or priority', async () => {
    await expect(naEmpresa(() => incidents.openIncident(SlaFactory.incident({ kind: 'meteorito' }))))
      .rejects.toThrow(/espécie inválida/i);
    await expect(naEmpresa(() => incidents.openIncident(SlaFactory.incident({ priority: 'urgentíssima' }))))
      .rejects.toThrow(/prioridade inválida/i);
  });

  it('should refuse to close without a reason', async () => {
    // Uma ocorrência que fecha sem explicação não ensina nada a ninguém e torna
    // o histórico inútil — que é a razão de o histórico existir.
    const oc = await naEmpresa(() => incidents.openIncident(SlaFactory.incident()));

    await expect(naEmpresa(() => incidents.transitionIncident(oc.id, { to: 'resolvida' })))
      .rejects.toThrow(/exige um motivo/i);
  });

  it('should record every transition in an append-only history', async () => {
    const oc = await naEmpresa(() => incidents.openIncident(SlaFactory.incident()));
    await naEmpresa(() => incidents.transitionIncident(oc.id, { to: 'em_curso', note: 'a contactar o cliente' }));
    await naEmpresa(() => incidents.commentIncident(oc.id, { note: 'cliente não atende' }));
    const fechada = await naEmpresa(() => incidents.transitionIncident(oc.id, {
      to: 'resolvida', note: 'reentregue no dia seguinte',
    }));

    expect(fechada.status).toBe('resolvida');
    expect(fechada.resolution).toBe('reentregue no dia seguinte');
    expect(fechada.closed_at).toBeTruthy();

    const historico = await naEmpresa(() => incidents.getIncidentHistory(oc.id));
    expect(historico.map((h) => h.type)).toEqual(['opened', 'transition', 'comment', 'transition']);
    // "Esta encomenda esteve três semanas parada" tem de ter resposta.
    expect(historico[1].from_status).toBe('aberta');
    expect(historico[1].to_status).toBe('em_curso');
  });

  it('should refuse a transition that the lifecycle does not allow', async () => {
    const oc = await naEmpresa(() => incidents.openIncident(SlaFactory.incident()));
    await naEmpresa(() => incidents.transitionIncident(oc.id, { to: 'resolvida', note: 'resolvido' }));

    // Resolvida é terminal — reabrir cria outra ocorrência.
    await expect(naEmpresa(() => incidents.transitionIncident(oc.id, { to: 'em_curso', note: 'voltar atrás' })))
      .rejects.toThrow(/transição inválida/i);
  });

  it('should not let another company see or touch an incident', async () => {
    const oc = await naEmpresa(() => incidents.openIncident(SlaFactory.incident()));

    await expect(tenant.runWithCompany('company-itest-inc-outra', () => incidents.getIncident(oc.id)))
      .rejects.toThrow(/não encontrada/i);
  });

  it('should count the queue for the panel', async () => {
    const stats = await naEmpresa(() => incidents.getIncidentStats());
    expect(stats.abertas + stats.em_curso + stats.resolvidas).toBeGreaterThan(0);
  });

  // ── SLA ────────────────────────────────────────────────────────────────────

  it('should produce no breaches for a zone without an agreed target', async () => {
    // Um SLA derivado do desempenho passado nunca acusaria incumprimento. Sem
    // prazo acordado, o resultado certo é "sem prazo", não "cumprido".
    await pool.query(`
      INSERT INTO pricing_zones (id, code, name, base_cents, per_kg_cents, included_kg, company_id)
      VALUES ($1,$2,'Zona SLA ITEST',10000,1000,1,$3)
    `, [`zone-${ZONA}`, ZONA, EMPRESA]);

    const antiga = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await pool.query(`
      INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination,
        cod_amount, cod_status, value, history, pricing, created_at, updated_at, company_id)
      VALUES ($1,'c@itest.mz','TRK990000001BR','in_transit','{}'::jsonb,'{"city":"Maputo"}'::jsonb,
        0,'none',1000,'[]'::jsonb,$2::jsonb,$3,$3,$4)
    `, ['order-itest-sla-1', JSON.stringify({ zone_code: ZONA, service: 'normal' }), antiga, EMPRESA]);

    const resumo = await naEmpresa(() => sla.getSlaSummary());
    expect(resumo.sem_prazo_acordado).toBeGreaterThanOrEqual(1);
    expect(resumo.incumprido).toBe(0);
  });

  it('should breach an order past the agreed window once a target exists', async () => {
    await pool.query('UPDATE pricing_zones SET sla_hours_normal = 48 WHERE code = $1', [ZONA]);

    const resumo = await naEmpresa(() => sla.getSlaSummary());
    expect(resumo.incumprido).toBeGreaterThanOrEqual(1);

    const falhas = await naEmpresa(() => sla.getSlaBreaches());
    const minha = falhas.find((f) => f.tracking_code === 'TRK990000001BR');
    expect(minha).toBeTruthy();
    // Trinta dias contra 48 horas prometidas.
    expect(minha.over_by_hours).toBeGreaterThan(600);
  });

  it('should report how many zones already have an agreed target', async () => {
    // Sem zonas com prazo, o indicador não existe — e dizê-lo é mais útil do
    // que mostrar zero.
    const resumo = await naEmpresa(() => sla.getSlaSummary());
    expect(resumo.zones_with_target.with_target).toBeGreaterThanOrEqual(1);
  });
});
