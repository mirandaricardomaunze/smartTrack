/**
 * @file predictions.pg.spec.js
 * @description Previsão e risco contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.46 e § 3.47
 *
 * As decisões são puras e estão cobertas nos respetivos .spec.ts. O que só a
 * base mostra é se a amostra é mesmo recolhida como se pensa — e, sobretudo, o
 * comportamento numa instalação nova, que é o estado em que este sistema vai
 * estar no primeiro dia: sem histórico nenhum. É aí que um módulo de previsão
 * mal feito começa a inventar.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const predictions = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/predictions.service`) : null;
const risks       = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/risks.service`) : null;
const tenant      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool        = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-pred';
const VAZIA   = 'company-itest-pred-vazia';
const ZONA    = 'Maputo Cidade ITEST';

const naEmpresa = (cid, fn) => tenant.runWithCompany(cid, fn);

/** Uma entrega concluída com a duração pedida, terminada há `haDias` dias. */
async function semearEntrega(i, horas, { servico = 'normal', haDias = 10 } = {}) {
  const fim = new Date(Date.now() - haDias * 86_400_000);
  const inicio = new Date(fim.getTime() - horas * 3_600_000);

  await pool.query(`
    INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination,
      value, history, created_at, updated_at, company_id, pricing, pod)
    VALUES ($1,'cli-itest-pred',$2,'delivered','{}'::jsonb,$3,0,'[]'::jsonb,$4,$5,$6,$7,$8)
  `, [
    `ord-pred-${i}`, `TRK91${String(i).padStart(7, '0')}BR`,
    JSON.stringify({ city: 'Maputo' }), inicio.toISOString(), fim.toISOString(), EMPRESA,
    JSON.stringify({ zone_name: ZONA, service_level: servico }),
    JSON.stringify({ captured_at: fim.toISOString(), recipient_name: 'ITEST' }),
  ]);
}

/** Uma encomenda ainda em curso, registada há `horas` horas. */
async function semearEmCurso(id, horas, estado = 'in_transit') {
  const inicio = new Date(Date.now() - horas * 3_600_000).toISOString();
  await pool.query(`
    INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination,
      value, history, created_at, updated_at, company_id, pricing)
    VALUES ($1,'cli-itest-pred',$2,$3,'{}'::jsonb,$4,0,'[]'::jsonb,$5,$5,$6,$7)
  `, [
    id, `TRK92${id.slice(-7)}BR`, estado, JSON.stringify({ city: 'Maputo' }),
    inicio, EMPRESA, JSON.stringify({ zone_name: ZONA, service_level: 'normal' }),
  ]);
}

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM orders WHERE company_id = ANY($1)', [[EMPRESA, VAZIA]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[EMPRESA, VAZIA]]);
}

describe.skipIf(!disponivel)('previsão e risco · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    for (const c of [EMPRESA, VAZIA]) {
      await pool.query(`INSERT INTO companies (id, name, slug, status) VALUES ($1,$1,$1,'active')`, [c]);
    }
    // 24 entregas normais entre 10 e 33 horas: amostra suficiente.
    for (let i = 0; i < 24; i += 1) await semearEntrega(i, 10 + i);
    // 3 expressas: de propósito abaixo do mínimo, para exercitar o recurso.
    for (let i = 0; i < 3; i += 1) await semearEntrega(100 + i, 4 + i, { servico: 'express' });

    await semearEmCurso('ord-pred-curso-1', 4);     // longe do prazo
    await semearEmCurso('ord-pred-curso-2', 25);    // passou a mediana
    await semearEmCurso('ord-pred-curso-3', 500);   // muito para lá do P90
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should predict from the measured history of the segment', async () => {
    const { segments } = await naEmpresa(EMPRESA, () => predictions.getDeliveryPredictions({ days: 180 }));
    const normal = segments.find((s) => s.zone === ZONA && s.service_level === 'normal');

    expect(normal.basis).toBe('segment');
    expect(normal.sample_size).toBe(24);
    expect(normal.p50_hours).toBeGreaterThan(20);
    expect(normal.p50_hours).toBeLessThan(23);
    expect(normal.p90_hours).toBeGreaterThan(normal.p50_hours);
  });

  it('should fall back to the zone for the thin express segment', async () => {
    // Três entregas expressas não dão previsão própria; a zona dá — e o número
    // passa a misturar níveis de serviço, o que fica assinalado.
    const { segments } = await naEmpresa(EMPRESA, () => predictions.getDeliveryPredictions({ days: 180 }));
    const expresso = segments.find((s) => s.zone === ZONA && s.basis === 'zone');

    expect(expresso).toBeDefined();
    expect(expresso.service_level).toBe(null);
  });

  it('should predict nothing at all for a brand new company', async () => {
    // O estado do primeiro dia. É aqui que um módulo mal feito começa a
    // inventar — e é a única coisa que não pode acontecer.
    const r = await naEmpresa(VAZIA, () => predictions.getDeliveryPredictions({ days: 180 }));

    expect(r.measured_deliveries).toBe(0);
    expect(r.segments).toEqual([]);
  });

  it('should sort the in-flight orders into risk and delay', async () => {
    const r = await naEmpresa(EMPRESA, () => risks.getRisks({ days: 180 }));

    expect(r.late.map((o) => o.id)).toContain('ord-pred-curso-3');
    expect(r.at_risk.map((o) => o.id)).toContain('ord-pred-curso-2');
    expect([...r.late, ...r.at_risk].map((o) => o.id)).not.toContain('ord-pred-curso-1');
  });

  it('should show what each judgement rests on', async () => {
    // Sem a base à vista, "atrasada" é uma afirmação que ninguém pode contestar.
    const r = await naEmpresa(EMPRESA, () => risks.getRisks({ days: 180 }));
    const atrasada = r.late.find((o) => o.id === 'ord-pred-curso-3');

    expect(atrasada.basis).toBe('p90');
    expect(atrasada.limit_hours).toBeGreaterThan(0);
  });

  it('should declare no order late in a company with no history', async () => {
    await semearEmCurso('ord-pred-vazia-1', 900);
    await pool.query('UPDATE orders SET company_id = $1 WHERE id = $2', [VAZIA, 'ord-pred-vazia-1']);

    const r = await naEmpresa(VAZIA, () => risks.getRisks({ days: 180 }));

    // 900 horas e mesmo assim não há atraso a declarar: nada foi prometido nem
    // medido. A encomenda aparece como parada, que é o que se sabe dela.
    expect(r.late).toEqual([]);
    expect(r.stalled.map((o) => o.id)).toContain('ord-pred-vazia-1');
    expect(r.basis.measured_deliveries).toBe(0);
  });

  it('should state that geographic deviation is not detected', async () => {
    // A ausência de desvios geográficos não é ausência de desvios, e quem
    // consome a API tem de o saber sem ir ler a spec.
    const r = await naEmpresa(EMPRESA, () => risks.getRisks({ days: 180 }));

    expect(r.geographic_deviation.detected).toBe(false);
    expect(r.geographic_deviation.reason).toContain('não o rasto do percurso');
  });

  it('should not mix another company into the sample', async () => {
    const r = await naEmpresa(VAZIA, () => predictions.getDeliveryPredictions({ days: 180 }));
    expect(r.measured_deliveries).toBe(0);
  });
});
