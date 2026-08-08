/**
 * @file user-access.pg.spec.js
 * @description Testes de integração das contas e acessos contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * Prova, contra a base real (`track`), o que faltava para uma empresa se
 * administrar sozinha: criar contas de painel, reemitir senhas, cortar acessos —
 * e, o mais importante, **dar acesso à aplicação a um motorista com o id certo**,
 * sem o qual a conta autentica e não encontra rota nem entregas.
 *
 * Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { DriverFactory } from '../harness/factories/driver.factory';
import { UserAccessFactory } from '../harness/factories/user-access.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const users   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/users.service`) : null;
const drivers = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/drivers.service`) : null;
const auth    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/auth.service`) : null;
const audit   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/audit.service`) : null;
const reset   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/password-reset.service`) : null;
const repo    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pw      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/password.utils`) : null;
const tenant  = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const crypto = require('node:crypto');

const COMPANY = 'company-itest-access';
const OTHER   = 'company-itest-access-other';
/** Empresa com UM único administrador — a guarda do último ADMIN só se prova aqui. */
const SOLO    = 'company-itest-access-solo';

/** Corre um caso de uso dentro do contexto de uma empresa (multiempresa, § 2.4). */
const inCompany = (companyId, fn) => tenant.runWithCompany(companyId, fn);

/** ADMIN semeado diretamente — é o dono da empresa no arranque de cada teste. */
async function seedAdmin(companyId = COMPANY, overrides = {}) {
  const input = UserAccessFactory.adminUser(overrides);
  const user = await repo.UserRepository.create({
    id: crypto.randomUUID(),
    name: input.name,
    email: input.email,
    password_hash: pw.hashPassword(input.password),
    role: 'ADMIN',
    company_id: companyId,
  });
  return { ...user, plainPassword: input.password };
}

/** Motorista sem acesso — o estado em que a página de motoristas o cria. */
async function seedDriver(companyId = COMPANY, overrides = {}) {
  const driver = DriverFactory.build({ id: crypto.randomUUID(), ...overrides });
  await pool.query(`
    INSERT INTO drivers (id, name, email, phone, vehicle, current_status, performance_metrics, gps, created_at, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
  `, [
    driver.id, driver.name, driver.email, driver.phone,
    JSON.stringify(driver.vehicle), driver.current_status,
    JSON.stringify(driver.performance_metrics), null, companyId,
  ]);
  return driver;
}

async function cleanup() {
  const ids = [COMPANY, OTHER, SOLO];
  await pool.query('DELETE FROM audit_events WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM password_reset_tokens WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM drivers WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}

describe.skipIf(!disponivel)('api-gateway · contas e acessos · PostgreSQL', () => {
  /** @type {object} ADMIN da empresa em teste */
  let owner;
  /** @type {object} ator ADMIN como chega do JWT */
  let actor;

  beforeAll(async () => {
    await cleanup();
    await repo.UserRepository.ensureTable();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY, name: 'Acessos Lda', slug: COMPANY }));
    await repo.CompanyRepository.create(CompanyFactory.build({ id: OTHER, name: 'Outra Lda', slug: OTHER }));

    owner = await seedAdmin();
    actor = { sub: owner.id, email: owner.email, role: 'ADMIN', company_id: COMPANY };
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Contas de painel ───────────────────────────────────────────────────────

  describe('contas de painel', () => {
    it('should create a SUPPORT account that can actually log in', async () => {
      const input = UserAccessFactory.panelUser();

      const created = await inCompany(COMPANY, () => users.createPanelUser(input, { actor }));

      expect(created.role).toBe('SUPPORT');
      expect(created.company_id).toBe(COMPANY);
      expect(created.status).toBe('active');
      expect(created).not.toHaveProperty('password_hash');

      const session = await auth.login(input.email, input.password);
      expect(session.user.role).toBe('SUPPORT');
      expect(session.user.company_id).toBe(COMPANY);
    });

    it.each(UserAccessFactory.weakPasswords())(
      'should refuse an issued password that is $because',
      async ({ password }) => {
        const input = UserAccessFactory.panelUser({ password });
        await expect(inCompany(COMPANY, () => users.createPanelUser(input, { actor })))
          .rejects.toMatchObject({ name: 'UsersError', statusCode: 400 });
      },
    );

    it('should refuse a DRIVER account here and point at the right door', async () => {
      // Uma conta DRIVER criada por aqui teria um id próprio e a aplicação do
      // motorista não encontrava nem rota nem entregas.
      const input = UserAccessFactory.panelUser({ role: 'DRIVER' });

      await expect(inCompany(COMPANY, () => users.createPanelUser(input, { actor })))
        .rejects.toThrow(/página Motoristas/i);
    });

    it('should refuse a duplicate email with 409', async () => {
      const input = UserAccessFactory.panelUser();
      await inCompany(COMPANY, () => users.createPanelUser(input, { actor }));

      await expect(inCompany(COMPANY, () => users.createPanelUser(input, { actor })))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('should list every account of the company, drivers included', async () => {
      const driver = await seedDriver();
      await inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, UserAccessFactory.driverAccess(), { actor }));

      const list = await inCompany(COMPANY, () => users.listUsers());
      const roles = list.map((row) => row.role);

      expect(roles).toContain('ADMIN');
      expect(roles).toContain('DRIVER');
      // "Quem tem acesso ao sistema?" não pode deixar ninguém de fora.
      expect(list.find((row) => row.id === driver.id)).toBeTruthy();
      for (const row of list) expect(row).not.toHaveProperty('password_hash');
    });

    it('should not see accounts from another company', async () => {
      const stranger = await seedAdmin(OTHER);

      const list = await inCompany(COMPANY, () => users.listUsers());
      expect(list.map((row) => row.id)).not.toContain(stranger.id);

      // E não os pode tocar: para este ADMIN a conta simplesmente não existe.
      await expect(inCompany(COMPANY, () => users.setUserPassword(stranger.id, { password: 'OutraEmpresa2026' }, { actor })))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── Reemissão de senha ─────────────────────────────────────────────────────

  describe('reemissão de senha', () => {
    it('should let the reissued password in and keep the old one out', async () => {
      const input = UserAccessFactory.panelUser();
      const created = await inCompany(COMPANY, () => users.createPanelUser(input, { actor }));

      await inCompany(COMPANY, () => users.setUserPassword(created.id, { password: 'SenhaReemitida2026' }, { actor }));

      const session = await auth.login(input.email, 'SenhaReemitida2026');
      expect(session.token).toBeTruthy();
      await expect(auth.login(input.email, input.password))
        .rejects.toMatchObject({ name: 'InvalidCredentialsError' });
    });

    it('should apply the same strength policy as the initial password', async () => {
      const created = await inCompany(COMPANY, () => users.createPanelUser(UserAccessFactory.panelUser(), { actor }));

      await expect(inCompany(COMPANY, () => users.setUserPassword(created.id, { password: 'fraca' }, { actor })))
        .rejects.toMatchObject({ name: 'UsersError' });
    });

    it('should refuse to touch the platform SUPERADMIN', async () => {
      const platform = await repo.UserRepository.create({
        id: crypto.randomUUID(), name: 'Plataforma', email: `super.itest.${Date.now()}@example.mz`,
        password_hash: pw.hashPassword('Plataforma2026'), role: 'SUPERADMIN', company_id: COMPANY,
      });

      await expect(inCompany(COMPANY, () => users.setUserPassword(platform.id, { password: 'Tentativa2026' }, { actor })))
        .rejects.toMatchObject({ statusCode: 403 });
    });
  });

  // ── Cortar e devolver o acesso ─────────────────────────────────────────────

  describe('suspensão de acesso', () => {
    it('should block the login of a suspended account and let it back after reactivation', async () => {
      const input = UserAccessFactory.panelUser();
      const created = await inCompany(COMPANY, () => users.createPanelUser(input, { actor }));

      const blocked = await inCompany(COMPANY, () => users.setUserStatus(created.id, { status: 'blocked' }, { actor }));
      expect(blocked.status).toBe('blocked');
      expect(blocked.blocked_at).toBeTruthy();

      await expect(auth.login(input.email, input.password))
        .rejects.toMatchObject({ name: 'AccountBlockedError', statusCode: 403 });

      await inCompany(COMPANY, () => users.setUserStatus(created.id, { status: 'active' }, { actor }));
      expect((await auth.login(input.email, input.password)).token).toBeTruthy();
    });

    it('should not let a suspended account recover its password by email either', async () => {
      const input = UserAccessFactory.panelUser();
      const created = await inCompany(COMPANY, () => users.createPanelUser(input, { actor }));
      await inCompany(COMPANY, () => users.setUserStatus(created.id, { status: 'blocked' }, { actor }));

      const request = await reset.requestReset({ email: input.email }, {});

      // Resposta neutra (§ 3.22) mas sem envio: recuperar não contorna o corte.
      expect(request.ok).toBe(true);
      expect(request.delivered).toBe(false);
      expect(request.debug_link).toBeUndefined();
    });

    it('should refuse to suspend your own account', async () => {
      await expect(inCompany(COMPANY, () => users.setUserStatus(owner.id, { status: 'blocked' }, { actor })))
        .rejects.toMatchObject({ code: 'SELF_BLOCK' });
    });

    it('should refuse to suspend the last active ADMIN', async () => {
      // Uma empresa sem administrador ativo não se recupera de dentro: nem o
      // SUPERADMIN reemite senhas sem passar por estes casos de uso. A empresa
      // desta prova é própria — nas outras já há mais de um ADMIN.
      await repo.CompanyRepository.create(CompanyFactory.build({ id: SOLO, name: 'Só Um Lda', slug: SOLO }));
      const soleAdmin = await seedAdmin(SOLO);
      const platformActor = UserAccessFactory.superadmin();

      await expect(inCompany(SOLO, () => users.setUserStatus(soleAdmin.id, { status: 'blocked' }, { actor: platformActor })))
        .rejects.toMatchObject({ code: 'LAST_ADMIN', statusCode: 409 });

      // Com um segundo administrador, o mesmo ato passa a ser legítimo.
      await seedAdmin(SOLO);
      const blocked = await inCompany(SOLO, () => users.setUserStatus(soleAdmin.id, { status: 'blocked' }, { actor: platformActor }));
      expect(blocked.status).toBe('blocked');
    });
  });

  // ── Cadastro do motorista ──────────────────────────────────────────────────

  describe('cadastro do motorista', () => {
    it('should persist a new driver instead of only living in the browser', async () => {
      // O botão do painel escrevia no estado do React e o motorista desaparecia
      // ao recarregar; não existia endpoint nenhum.
      const created = await inCompany(COMPANY, () => drivers.createDriver({
        name: 'Motorista Cadastrado ITEST',
        email: 'motorista.cadastrado.itest@example.mz',
        phone: '+258 84 000 0000',
        vehicle: { type: 'VAN', plate: 'abc-123-mp', capacity_kg: 800 },
      }, { actor }));

      expect(created.has_access).toBe(false);
      // Nasce offline: sem conta não pode estar disponível para rota.
      expect(created.current_status).toBe('offline');
      expect(created.vehicle.plate).toBe('ABC-123-MP');   // normalizada

      const reread = await inCompany(COMPANY, () => drivers.listDrivers());
      expect(reread.map((row) => row.id)).toContain(created.id);
    });

    it.each([
      ['sem nome', { name: 'Ok', email: 'a@example.mz', vehicle: { type: 'MOTO', plate: 'AAA-111-MP' } }],
      ['sem e-mail', { name: 'Motorista Sem E-mail', vehicle: { type: 'MOTO', plate: 'AAA-111-MP' } }],
      ['sem matrícula', { name: 'Motorista Sem Matrícula', email: 'b@example.mz', vehicle: { type: 'MOTO', plate: '' } }],
      ['com veículo inválido', { name: 'Motorista Inválido', email: 'c@example.mz', vehicle: { type: 'BARCO', plate: 'AAA-111-MP' } }],
    ])('should refuse a driver %s', async (_case, dto) => {
      await expect(inCompany(COMPANY, () => drivers.createDriver(dto, { actor })))
        .rejects.toMatchObject({ name: 'DriverAccessError' });
    });

    it('should walk the whole onboarding a real company walks', async () => {
      const created = await inCompany(COMPANY, () => drivers.createDriver({
        name: 'Motorista Completo ITEST',
        email: 'motorista.completo.itest@example.mz',
        vehicle: { type: 'MOTO', plate: 'FIM-999-MP' },
      }, { actor }));

      const credentials = UserAccessFactory.driverAccess();
      await inCompany(COMPANY, () => drivers.grantDriverAccess(created.id, credentials, { actor }));

      const session = await auth.login(credentials.email, credentials.password);
      const payload = auth.verifyToken(session.token);

      // O que a aplicação do motorista precisa: papel DRIVER e `sub` = id do
      // motorista, para /v1/routes/me encontrar a rota dele.
      expect(payload.role).toBe('DRIVER');
      expect(payload.sub).toBe(created.id);
    });
  });

  // ── Acesso do motorista (o item que desbloqueia a operação) ────────────────

  describe('acesso do motorista', () => {
    it('should create the account with the DRIVER id, which is what the app resolves by', async () => {
      const driver = await seedDriver();
      const access = UserAccessFactory.driverAccess();

      const account = await inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, access, { actor }));

      // O contrato: `sub` do token == id do motorista. Sem isto, /v1/routes/me e
      // /v1/drivers/:id/gps não encontram nada.
      expect(account.id).toBe(driver.id);
      expect(account.driver_id).toBe(driver.id);
      expect(account.role).toBe('DRIVER');

      const session = await auth.login(access.email, access.password);
      const payload = auth.verifyToken(session.token);
      expect(payload.sub).toBe(driver.id);
      expect(payload.role).toBe('DRIVER');
      expect(payload.company_id).toBe(COMPANY);
    });

    it('should refuse a second access for the same driver', async () => {
      const driver = await seedDriver();
      await inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, UserAccessFactory.driverAccess(), { actor }));

      await expect(inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, UserAccessFactory.driverAccess(), { actor })))
        .rejects.toMatchObject({ name: 'DriverAccessError', statusCode: 409 });
    });

    it('should refuse an email already used by another account', async () => {
      const driver = await seedDriver();
      const taken = UserAccessFactory.panelUser();
      await inCompany(COMPANY, () => users.createPanelUser(taken, { actor }));

      await expect(inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, { email: taken.email, password: 'OutraSenha2026' }, { actor })))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it('should refuse a driver from another company', async () => {
      const stranger = await seedDriver(OTHER);

      await expect(inCompany(COMPANY, () => drivers.grantDriverAccess(stranger.id, UserAccessFactory.driverAccess(), { actor })))
        .rejects.toMatchObject({ name: 'DriverNotFoundError' });
    });

    it('should tell the panel which drivers still have no access', async () => {
      const withAccess = await seedDriver();
      const without = await seedDriver();
      await inCompany(COMPANY, () => drivers.grantDriverAccess(withAccess.id, UserAccessFactory.driverAccess(), { actor }));

      const list = await inCompany(COMPANY, () => drivers.listDrivers());

      expect(list.find((row) => row.id === withAccess.id).has_access).toBe(true);
      expect(list.find((row) => row.id === without.id).has_access).toBe(false);
    });

    it('should apply the issued-password policy to the driver too', async () => {
      const driver = await seedDriver();

      await expect(inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, { email: 'motorista.fraco@example.mz', password: 'curta' }, { actor })))
        .rejects.toMatchObject({ name: 'DriverAccessError' });
    });
  });

  // ── Auditoria (§ 3.21) ─────────────────────────────────────────────────────

  it('should leave an audit trail of every access decision', async () => {
    const input = UserAccessFactory.panelUser();
    const created = await inCompany(COMPANY, () => users.createPanelUser(input, { actor, ip: '10.0.0.7' }));
    await inCompany(COMPANY, () => users.setUserPassword(created.id, { password: 'AuditadaAgora2026' }, { actor }));
    await inCompany(COMPANY, () => users.setUserStatus(created.id, { status: 'blocked' }, { actor }));

    const driver = await seedDriver();
    await inCompany(COMPANY, () => drivers.grantDriverAccess(driver.id, UserAccessFactory.driverAccess(), { actor }));

    const events = await inCompany(COMPANY, () => audit.listEvents({ pageSize: 100 }));
    const actions = events.items.map((event) => event.action);

    expect(actions).toContain('users.create');
    expect(actions).toContain('users.password_reissued');
    expect(actions).toContain('users.blocked');
    expect(actions).toContain('drivers.access_granted');

    // A senha nunca entra no registo — nem em claro nem em hash.
    const trail = JSON.stringify(events.items);
    expect(trail).not.toContain('AuditadaAgora2026');
    expect(trail).not.toContain(input.password);
  });
});
