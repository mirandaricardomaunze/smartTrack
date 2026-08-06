/**
 * @file hr.pg.spec.js
 * @description Testes de integração dos Recursos Humanos contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.18 (Recursos Humanos)
 *
 * Cobre o que a revisão do módulo apanhou como frágil e foi corrigido: a folha
 * incluir TODOS os colaboradores ativos (não só os primeiros 100); número de
 * colaborador duplicado responder 409 em vez de 500; o saldo de férias descer
 * de facto ao aprovar e travar quando não chega; uma licença só poder ser
 * decidida uma vez; licenças sobrepostas serem recusadas; o ciclo da folha
 * (rascunho → aprovada → paga); a conta do portal contar para a quota do plano;
 * e o isolamento entre empresas. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import {
  HrEmployeeFactory, HrLeaveFactory, HrLeaveBalanceFactory, HrPortalAccountFactory, HrShiftFactory, HrChecklistFactory, HrTrainingFactory,
} from '../harness/factories/hr.factory';
import { PlanFactory } from '../harness/factories/subscription.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const hr       = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/hr.service`) : null;
const hrOps    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/hr-operations.service`) : null;
const portal   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/hr-portal.service`) : null;
const subs     = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/subscriptions.service`) : null;
const repo     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY_A = 'company-itest-hr-a';
const COMPANY_B = 'company-itest-hr-b';
const COMPANY_EMPTY = 'company-itest-hr-vazia';
const PLAN_CODE = 'plan_itest_hr';

function asCompany(companyId, fn) {
  return tenant.runWithCompany(companyId, fn);
}

async function cleanup() {
  const ids = [COMPANY_A, COMPANY_B, COMPANY_EMPTY];
  for (const table of [
    'hr_payroll_items', 'hr_payroll_runs', 'hr_leave_balances', 'hr_time_bank', 'hr_documents',
    'hr_checklists', 'hr_trainings', 'hr_benefits', 'hr_shifts', 'hr_attendance',
    'hr_leave_requests', 'hr_performance_reviews', 'hr_candidates', 'hr_jobs',
    'hr_employees', 'hr_departments', 'users', 'subscriptions', 'usage_counters',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE company_id = ANY($1)`, [ids]);
  }
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM plans WHERE code = $1', [PLAN_CODE]);
}

describe.skipIf(!disponivel)('api-gateway · recursos humanos · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_A, name: 'Logística RH A', slug: COMPANY_A }));
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_B, name: 'Logística RH B', slug: COMPANY_B }));
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Colaboradores ─────────────────────────────────────────────────────────

  it('should create an employee scoped to the company', async () => {
    const created = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-001' })));
    expect(created.company_id).toBe(COMPANY_A);
    expect(created.salary_cents).toBe(8500000);
  });

  it('should answer 409 on a duplicate employee number, not 500', async () => {
    await expect(asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-001' }))))
      .rejects.toMatchObject({ name: 'HrConflictError', statusCode: 409 });
  });

  it('should allow the same employee number in another company', async () => {
    const created = await asCompany(COMPANY_B, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-001', full_name: 'Outro Colaborador' })));
    expect(created.company_id).toBe(COMPANY_B);
  });

  it('should reject required fields and negative salary', async () => {
    await expect(asCompany(COMPANY_A, () => hr.createEmployee({ full_name: 'Sem número' })))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-NEG', salary_cents: -1 }))))
      .rejects.toThrowError(/negativo/i);
  });

  // ── Licenças e saldo de férias ────────────────────────────────────────────

  it('should refuse overlapping leave for the same employee', async () => {
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-LIC', full_name: 'Colaborador Licença' })));
    await asCompany(COMPANY_A, () => hr.createLeave(HrLeaveFactory.build({ employee_id: employee.id, start_date: '2026-08-10', end_date: '2026-08-14' })));

    await expect(asCompany(COMPANY_A, () => hr.createLeave(HrLeaveFactory.build({ employee_id: employee.id, start_date: '2026-08-12', end_date: '2026-08-16' }))))
      .rejects.toMatchObject({ name: 'HrConflictError', statusCode: 409 });
  });

  it('should consume the annual balance when the leave is approved', async () => {
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-SAL', full_name: 'Colaborador Saldo' })));
    await asCompany(COMPANY_A, () => hrOps.saveLeaveBalance(
      HrLeaveBalanceFactory.build({ employee_id: employee.id, year: 2026, entitled_days: 10, carried_days: 0, used_days: 0 }), 'admin'));

    const leave = await asCompany(COMPANY_A, () => hr.createLeave(HrLeaveFactory.build({ employee_id: employee.id, start_date: '2026-09-01', end_date: '2026-09-05' })));
    await asCompany(COMPANY_A, () => hr.decideLeave(leave.id, { status: 'approved' }, 'admin'));

    const balance = await asCompany(COMPANY_A, () => repo.HrRepository.findLeaveBalance(employee.id, 2026));
    expect(Number(balance.used_days)).toBe(5);       // 5 dias de 01 a 05
    expect(Number(balance.available_days)).toBe(5);
  });

  it('should refuse an approval that exceeds the remaining balance', async () => {
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-EXC', full_name: 'Colaborador Excesso' })));
    await asCompany(COMPANY_A, () => hrOps.saveLeaveBalance(
      HrLeaveBalanceFactory.build({ employee_id: employee.id, year: 2026, entitled_days: 3, carried_days: 0, used_days: 0 }), 'admin'));

    const leave = await asCompany(COMPANY_A, () => hr.createLeave(HrLeaveFactory.build({ employee_id: employee.id, start_date: '2026-10-01', end_date: '2026-10-10' })));
    await expect(asCompany(COMPANY_A, () => hr.decideLeave(leave.id, { status: 'approved' }, 'admin')))
      .rejects.toThrowError(/insuficiente/i);

    // A licença continua pendente e o saldo intacto.
    const balance = await asCompany(COMPANY_A, () => repo.HrRepository.findLeaveBalance(employee.id, 2026));
    expect(Number(balance.used_days)).toBe(0);
    const stored = await asCompany(COMPANY_A, () => repo.HrRepository.findLeave(leave.id));
    expect(stored.status).toBe('pending');
  });

  it('should approve without a configured balance (no policy, no block)', async () => {
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-SEM', full_name: 'Colaborador Sem Saldo' })));
    const leave = await asCompany(COMPANY_A, () => hr.createLeave(HrLeaveFactory.build({ employee_id: employee.id, start_date: '2026-11-02', end_date: '2026-11-03' })));

    const decided = await asCompany(COMPANY_A, () => hr.decideLeave(leave.id, { status: 'approved' }, 'admin'));
    expect(decided.status).toBe('approved');
  });

  it('should decide a leave only once', async () => {
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-DEC', full_name: 'Colaborador Decisão' })));
    const leave = await asCompany(COMPANY_A, () => hr.createLeave(HrLeaveFactory.build({ employee_id: employee.id, start_date: '2026-12-01', end_date: '2026-12-02' })));
    await asCompany(COMPANY_A, () => hr.decideLeave(leave.id, { status: 'rejected' }, 'admin'));

    await expect(asCompany(COMPANY_A, () => hr.decideLeave(leave.id, { status: 'approved' }, 'admin')))
      .rejects.toMatchObject({ name: 'HrConflictError', statusCode: 409 });
  });

  // ── Folha salarial ────────────────────────────────────────────────────────

  it('should put EVERY active employee on the payroll, past the page limit', async () => {
    // 105 colaboradores: acima do teto de 100 da listagem paginada.
    for (let i = 1; i <= 105; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await asCompany(COMPANY_B, () => hr.createEmployee(HrEmployeeFactory.build({
        employee_number: `B-${String(i).padStart(3, '0')}`, full_name: `Colaborador B ${i}`, salary_cents: 100000,
      })));
    }
    const active = await asCompany(COMPANY_B, () => repo.HrRepository.listActiveEmployeesForPayroll());
    const run = await asCompany(COMPANY_B, () => hr.createPayroll('2099-01'));

    expect(run.items).toHaveLength(active.length);
    expect(run.items.length).toBeGreaterThan(100);
    // O bruto inicial é a soma dos salários base de todos — nenhum fica de fora.
    expect(run.gross_cents).toBe(active.reduce((sum, e) => sum + e.salary_cents, 0));
  });

  it('should be idempotent per period', async () => {
    const first = await asCompany(COMPANY_B, () => hr.createPayroll('2099-01'));
    const again = await asCompany(COMPANY_B, () => hr.createPayroll('2099-01'));
    expect(again.id).toBe(first.id);
  });

  it('should refuse a payroll with no active employees', async () => {
    // Empresa sem quadro de pessoal: uma folha vazia seria um documento inútil.
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_EMPTY, name: 'Logística RH Vazia', slug: COMPANY_EMPTY }));
    await expect(asCompany(COMPANY_EMPTY, () => hr.createPayroll('2098-01')))
      .rejects.toThrowError(/colaboradores ativos/i);
  });

  it('should recalculate totals when a line changes and follow the status cycle', async () => {
    const runs = await asCompany(COMPANY_B, () => hr.listPayroll());
    const run = await asCompany(COMPANY_B, () => hr.getPayroll(runs[0].id));
    const line = run.items[0];

    const updated = await asCompany(COMPANY_B, () => hr.updatePayrollItem(run.id, line.employee_id, { allowances_cents: 50000, tax_cents: 10000 }));
    const changed = updated.items.find((i) => i.employee_id === line.employee_id);
    expect(changed.gross_cents).toBe(150000);   // 100000 base + 50000 subsídio
    expect(changed.net_cents).toBe(140000);
    expect(updated.gross_cents).toBe(run.gross_cents + 50000);

    // Rascunho → aprovada → paga, sem saltos.
    await expect(asCompany(COMPANY_B, () => hr.setPayrollStatus(run.id, 'paid', 'admin')))
      .rejects.toThrowError(/aprovada antes/i);
    await asCompany(COMPANY_B, () => hr.setPayrollStatus(run.id, 'approved', 'admin'));
    await expect(asCompany(COMPANY_B, () => hr.updatePayrollItem(run.id, line.employee_id, { bonus_cents: 1 })))
      .rejects.toThrowError(/rascunho/i);
    const paid = await asCompany(COMPANY_B, () => hr.setPayrollStatus(run.id, 'paid', 'admin'));
    expect(paid.status).toBe('paid');
  });

  // ── Assiduidade contra o turno ────────────────────────────────────────────

  it('should measure attendance against the employee shift, not a fixed hour', async () => {
    const shift = await asCompany(COMPANY_A, () => hrOps.create('shifts', HrShiftFactory.build({
      name: 'Turno Maputo', start_time: '08:00', end_time: '17:00', break_minutes: 60, work_days: [1, 2, 3, 4, 5],
    }), 'admin'));
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-TUR', full_name: 'Colaborador Turno' })));
    await asCompany(COMPANY_A, () => hr.updateEmployee(employee.id, { shift_id: shift.id }));

    // 08:30 em Maputo (UTC+2) = 06:30 UTC → 30 minutos de atraso.
    const record = await asCompany(COMPANY_A, () => hr.recordAttendance({
      employee_id: employee.id, work_date: '2026-08-03',
      clock_in: '2026-08-03T06:30:00.000Z', clock_out: '2026-08-03T15:30:00.000Z', break_minutes: 60,
    }, 'admin'));

    expect(record.late_minutes).toBe(30);
    expect(record.worked_minutes).toBe(480);   // 9h de presença - 1h de pausa
    expect(record.overtime_minutes).toBe(0);   // exatamente a jornada do turno
  });

  it('should treat a shift rest day as fully extraordinary', async () => {
    const found = await asCompany(COMPANY_A, () => hr.listEmployees({ search: 'Colaborador Turno' }));
    const employee = found.items[0];

    // 2026-08-02 é domingo e o turno é de segunda a sexta.
    const record = await asCompany(COMPANY_A, () => hr.recordAttendance({
      employee_id: employee.id, work_date: '2026-08-02',
      clock_in: '2026-08-02T06:00:00.000Z', clock_out: '2026-08-02T12:00:00.000Z', break_minutes: 0,
    }, 'admin'));

    expect(record.status).toBe('rest_day');
    expect(record.late_minutes).toBe(0);
    expect(record.overtime_minutes).toBe(360);
  });

  it('should store JSONB lists as real arrays, not Postgres array literals', async () => {
    // Regressão: o driver convertia `[1,2]` em `{1,2}` (literal de array do
    // Postgres) e o JSONB recusava; um array vazio entrava como `{}`, objeto.
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-JSON', full_name: 'Colaborador JSON' })));
    const checklist = await asCompany(COMPANY_A, () => hrOps.create('checklists', HrChecklistFactory.build({ employee_id: employee.id }), 'admin'));
    const training = await asCompany(COMPANY_A, () => hrOps.create('trainings', HrTrainingFactory.build({ participant_ids: [employee.id] }), 'admin'));

    expect(Array.isArray(checklist.items)).toBe(true);
    expect(checklist.items).toHaveLength(2);
    expect(hrOps.checklistProgress(checklist.items)).toMatchObject({ total: 2, completed: 1, percent: 50 });
    expect(Array.isArray(training.participant_ids)).toBe(true);
    expect(training.participant_ids).toContain(employee.id);
  });

  // ── Portal do colaborador ─────────────────────────────────────────────────

  it('should count a portal account against the plan user limit', async () => {
    await subs.createPlan(PlanFactory.build({ code: PLAN_CODE, name: 'Plano RH ITEST', max_users: 1, max_orders_per_month: null, max_warehouses: null }));
    await subs.assignPlan(COMPANY_A, PLAN_CODE);

    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-PORT', full_name: 'Colaborador Portal' })));
    const first = await asCompany(COMPANY_A, () => portal.provision(
      HrPortalAccountFactory.build({ employee_id: employee.id, email: 'portal.itest.a@example.mz' })));
    expect(first.role).toBe('EMPLOYEE');

    // O limite do plano (1 utilizador) já está gasto pela conta acima.
    const other = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-PORT2', full_name: 'Segundo Portal' })));
    await expect(asCompany(COMPANY_A, () => portal.provision(
      HrPortalAccountFactory.build({ employee_id: other.id, email: 'portal.itest.b@example.mz' }))))
      .rejects.toMatchObject({ name: 'QuotaExceededError', statusCode: 402 });
  });

  it('should show the employee only their own data', async () => {
    const found = await asCompany(COMPANY_A, () => hr.listEmployees({ search: 'Colaborador Portal' }));
    const employee = found.items[0];
    const user = (await pool.query('SELECT id FROM users WHERE email=$1', ['portal.itest.a@example.mz'])).rows[0];
    const account = await asCompany(COMPANY_A, () => repo.HrPortalRepository.findEmployeeByUser(user.id));

    expect(account.id).toBe(employee.id);
    const dashboard = await asCompany(COMPANY_A, () => repo.HrPortalRepository.dashboard(employee.id));
    expect(dashboard.profile.employee_number).toBe('RH-PORT');
    expect(dashboard.leaves.every((l) => l.employee_id === employee.id)).toBe(true);
    // Folhas em rascunho não aparecem ao colaborador.
    expect(dashboard.payslips.every((p) => ['approved', 'paid'].includes(p.status))).toBe(true);
  });

  it('should reject a weak portal password', async () => {
    const employee = await asCompany(COMPANY_A, () => hr.createEmployee(HrEmployeeFactory.build({ employee_number: 'RH-FRACA', full_name: 'Senha Fraca' })));
    await expect(asCompany(COMPANY_A, () => portal.provision({ employee_id: employee.id, email: 'fraca.itest@example.mz', password: 'abc' })))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Isolamento ────────────────────────────────────────────────────────────

  it('should keep employees, leaves and payroll isolated per company', async () => {
    const listA = await asCompany(COMPANY_A, () => hr.listEmployees({ pageSize: 100 }));
    const listB = await asCompany(COMPANY_B, () => hr.listEmployees({ pageSize: 100 }));

    expect(listA.items.every((e) => e.company_id === COMPANY_A)).toBe(true);
    expect(listB.items.every((e) => e.company_id === COMPANY_B)).toBe(true);

    // A empresa A não alcança um colaborador da B, nem pela via direta do id.
    const employeeB = listB.items[0];
    expect(await asCompany(COMPANY_A, () => repo.HrRepository.findEmployee(employeeB.id))).toBeUndefined();

    const payrollA = await asCompany(COMPANY_A, () => hr.listPayroll());
    expect(payrollA).toHaveLength(0);   // a folha 2099-01 é da empresa B
  });

  it('should report stats only for the company in context', async () => {
    const statsB = await asCompany(COMPANY_B, () => hr.getStats());
    expect(statsB.total).toBeGreaterThanOrEqual(105);
    expect(statsB.payroll_cents).toBeGreaterThan(0);

    const statsA = await asCompany(COMPANY_A, () => hr.getStats());
    expect(statsA.total).toBeLessThan(statsB.total);
  });
});
