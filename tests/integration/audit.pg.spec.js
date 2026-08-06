/**
 * @file audit.pg.spec.js
 * @description Testes de integração do registo de auditoria contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * Prova, contra a base real (`track`): o evento grava-se com sequência e cadeia
 * por empresa; os segredos não chegam à base; uma falha de escrita não parte a
 * operação e fica contabilizada; os filtros e o resumo respondem; a integridade
 * apanha uma linha adulterada e outra apagada diretamente na base; e uma empresa
 * nunca vê os eventos da outra. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { AuditEventFactory } from '../harness/factories/audit.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const audit  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/audit.service`) : null;
const repo   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY_A = 'company-itest-audit-a';
const COMPANY_B = 'company-itest-audit-b';

function asCompany(companyId, fn) {
  return tenant.runWithCompany(companyId, fn);
}

async function cleanup() {
  const ids = [COMPANY_A, COMPANY_B];
  await pool.query('DELETE FROM audit_events WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}

describe.skipIf(!disponivel)('api-gateway · registo de auditoria · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    for (const [id, name] of [[COMPANY_A, 'Auditoria A'], [COMPANY_B, 'Auditoria B']]) {
      await repo.CompanyRepository.create(CompanyFactory.build({ id, name, slug: id }));
    }
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Escrita ───────────────────────────────────────────────────────────────

  it('should record an event with sequence and signature', async () => {
    const event = await asCompany(COMPANY_A, () => audit.record(AuditEventFactory.input()));

    expect(event.company_id).toBe(COMPANY_A);
    expect(event.seq).toBe(1);
    expect(event.previous_hash).toBe(audit.GENESIS_HASH);
    expect(event.hash).toBeTruthy();
    expect(event.action).toBe('invoices.void');
    expect(event.actor_email).toBe('ana.admin@example.mz');
  });

  it('should chain each event to the previous one of the same company', async () => {
    const second = await asCompany(COMPANY_A, () => audit.record(AuditEventFactory.input({ action: 'orders.create' })));
    const chain = await asCompany(COMPANY_A, () => repo.AuditRepository.listChain(COMPANY_A));

    expect(second.seq).toBe(2);
    expect(second.previous_hash).toBe(chain[0].hash);
    expect(second.hash).not.toBe(chain[0].hash);
  });

  it('should keep secrets out of the database', async () => {
    const event = await asCompany(COMPANY_A, () => audit.record(AuditEventFactory.withSecrets()));
    const stored = (await pool.query('SELECT metadata::text AS raw FROM audit_events WHERE id = $1', [event.id])).rows[0].raw;

    expect(stored).not.toContain('SenhaSuperSecreta1');
    expect(stored).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(stored).not.toContain('hash-do-diabo');
    expect(stored).toContain('isto fica');            // o contexto útil sobrevive
    expect(stored).toContain('cliente@example.mz');
  });

  it('should number sequences independently per company', async () => {
    const first = await asCompany(COMPANY_B, () => audit.record(AuditEventFactory.input({ action: 'companies.status' })));

    expect(first.company_id).toBe(COMPANY_B);
    expect(first.seq).toBe(1);                        // a empresa B começa do 1
    expect(first.previous_hash).toBe(audit.GENESIS_HASH);
  });

  it('should never throw when the write fails, and count the failure', async () => {
    const before = audit.getHealth().failed;
    // `action` é NOT NULL: força um erro real na base.
    const result = await asCompany(COMPANY_A, () => audit.record({ summary: 'sem ação' }));

    expect(result).toBeNull();                        // não rebenta o caso de uso
    expect(audit.getHealth().failed).toBe(before + 1);
    expect(audit.getHealth().last_error).toBeTruthy();
  });

  // ── Leitura ───────────────────────────────────────────────────────────────

  it('should filter by action, outcome and free text', async () => {
    await asCompany(COMPANY_A, () => audit.record(AuditEventFactory.input({
      action: 'orders.delete', summary: 'ana.admin@example.mz apagou o pedido TRK-AUD-1',
      outcome: audit.Outcome.DENIED, entity_label: 'TRK-AUD-1',
    })));

    const byAction = await asCompany(COMPANY_A, () => audit.listEvents({ action: 'orders.delete' }));
    expect(byAction.items).toHaveLength(1);

    const denied = await asCompany(COMPANY_A, () => audit.listEvents({ outcome: 'denied' }));
    expect(denied.items.every((e) => e.outcome === 'denied')).toBe(true);

    const search = await asCompany(COMPANY_A, () => audit.listEvents({ search: 'trk-aud-1' }));
    expect(search.items[0].entity_label).toBe('TRK-AUD-1');
  });

  it('should filter by entity so one document can be traced end to end', async () => {
    const list = await asCompany(COMPANY_A, () => audit.listEvents({ entity_type: 'invoice', entity_id: 'invoice-itest-0001' }));
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((e) => e.entity_id === 'invoice-itest-0001')).toBe(true);
  });

  it('should paginate newest first', async () => {
    const page = await asCompany(COMPANY_A, () => audit.listEvents({ page: 1, pageSize: 2 }));

    expect(page.items).toHaveLength(2);
    expect(page.pageSize).toBe(2);
    expect(page.total).toBeGreaterThan(2);
    expect(Date.parse(page.items[0].occurred_at)).toBeGreaterThanOrEqual(Date.parse(page.items[1].occurred_at));
  });

  it('should summarise the period with denials and top actions', async () => {
    const stats = await asCompany(COMPANY_A, () => audit.getStats({}));

    expect(stats.total).toBeGreaterThanOrEqual(4);
    expect(stats.denied).toBeGreaterThanOrEqual(1);
    expect(stats.actors).toBeGreaterThanOrEqual(1);
    expect(stats.top_actions[0]).toHaveProperty('action');
  });

  it('should list the distinct actions for the filter', async () => {
    const actions = await asCompany(COMPANY_A, () => audit.listActions());
    expect(actions).toContain('invoices.void');
    expect(actions).toContain('orders.delete');
  });

  // ── Inviolabilidade ───────────────────────────────────────────────────────

  it('should report a healthy chain', async () => {
    const report = await asCompany(COMPANY_A, () => audit.verifyIntegrity());
    expect(report.ok).toBe(true);
    expect(report.chains[0].company_id).toBe(COMPANY_A);
    expect(report.chains[0].checked).toBeGreaterThan(0);
  });

  it('should detect an event edited directly in the database', async () => {
    const target = (await pool.query(
      'SELECT id FROM audit_events WHERE company_id = $1 ORDER BY seq LIMIT 1', [COMPANY_A],
    )).rows[0];
    await pool.query("UPDATE audit_events SET action = 'orders.create' WHERE id = $1", [target.id]);

    const report = await asCompany(COMPANY_A, () => audit.verifyIntegrity());
    expect(report.ok).toBe(false);
    expect(report.chains[0].broken[0].reason).toMatch(/não corresponde/i);

    await pool.query("UPDATE audit_events SET action = 'invoices.void' WHERE id = $1", [target.id]);
  });

  it('should detect an event deleted from the middle of the chain', async () => {
    const middle = (await pool.query(
      'SELECT id, seq FROM audit_events WHERE company_id = $1 ORDER BY seq OFFSET 1 LIMIT 1', [COMPANY_A],
    )).rows[0];
    const backup = (await pool.query('SELECT * FROM audit_events WHERE id = $1', [middle.id])).rows[0];
    await pool.query('DELETE FROM audit_events WHERE id = $1', [middle.id]);

    const report = await asCompany(COMPANY_A, () => audit.verifyIntegrity());
    expect(report.ok).toBe(false);
    expect(report.chains[0].gaps.length).toBeGreaterThan(0);

    // Repõe a linha para os testes seguintes verem a cadeia inteira.
    const cols = Object.keys(backup);
    await pool.query(
      `INSERT INTO audit_events (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      cols.map((c) => backup[c]),
    );
  });

  // ── Multiempresa ──────────────────────────────────────────────────────────

  it('should never show one company the events of another', async () => {
    const seenByB = await asCompany(COMPANY_B, () => audit.listEvents({}));

    expect(seenByB.items.every((e) => e.company_id === COMPANY_B)).toBe(true);
    expect(seenByB.items.some((e) => e.action === 'orders.delete')).toBe(false);

    const statsB = await asCompany(COMPANY_B, () => audit.getStats({}));
    const statsA = await asCompany(COMPANY_A, () => audit.getStats({}));
    expect(statsB.total).toBeLessThan(statsA.total);
  });

  it('should expose no way to change or delete an event through the service', () => {
    // O contrato do módulo é append-only: se um dia aparecer aqui um `update`
    // ou `remove`, este teste obriga a decisão a ser deliberada.
    expect(Object.keys(audit).filter((k) => /update|delete|remove|edit/i.test(k))).toEqual([]);
    expect(Object.keys(repo.AuditRepository).filter((k) => /update|delete|remove/i.test(k))).toEqual([]);
  });
});
