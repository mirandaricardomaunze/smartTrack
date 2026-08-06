/**
 * @file password-reset.pg.spec.js
 * @description Testes de integração da recuperação de senha contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * Prova, contra a base real (`track`): o fluxo completo troca mesmo a senha; a
 * resposta é idêntica para contas que existem e que não existem; o token só vive
 * em hash e serve uma vez; um pedido novo invalida o anterior; empresa suspensa
 * não recupera; o abuso é travado; e ficam eventos de auditoria dos dois lados.
 * Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { PasswordResetFactory } from '../harness/factories/password-reset.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const reset  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/password-reset.service`) : null;
const auth   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/auth.service`) : null;
const audit  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/audit.service`) : null;
const repo   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pw     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/password.utils`) : null;
const tenant = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY = 'company-itest-reset';
const SUSPENDED = 'company-itest-reset-susp';
const crypto = require('node:crypto');

/** Cria um utilizador diretamente, sem passar pelas regras do registo. */
async function seedUser({ email, password, companyId = COMPANY, name = 'Utilizador Recuperação' }) {
  const user = await repo.UserRepository.create({
    id: crypto.randomUUID(), name, email,
    password_hash: pw.hashPassword(password), role: 'ADMIN', company_id: companyId,
  });
  return user;
}

/** Conta nova por teste: o travão de 5 pedidos/hora é por utilizador. */
async function freshAccount() {
  const account = PasswordResetFactory.account();
  await seedUser({ email: account.email, password: account.password });
  return account;
}

async function cleanup() {
  const ids = [COMPANY, SUSPENDED];
  await pool.query('DELETE FROM password_reset_tokens WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM audit_events WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM users WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}

describe.skipIf(!disponivel)('api-gateway · recuperação de senha · PostgreSQL', () => {
  let account;

  beforeAll(async () => {
    await cleanup();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY, name: 'Recuperação Lda', slug: COMPANY }));
    await repo.CompanyRepository.create(CompanyFactory.build({ id: SUSPENDED, name: 'Suspensa Lda', slug: SUSPENDED }));
    await repo.CompanyRepository.update(SUSPENDED, { status: 'suspended' });

    account = PasswordResetFactory.account();
    await seedUser({ email: account.email, password: account.password });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Fluxo completo ────────────────────────────────────────────────────────

  it('should complete the round trip: request, link, new password, login', async () => {
    const request = await reset.requestReset({ email: account.email }, { ip: '::1' });
    expect(request.ok).toBe(true);
    expect(request.debug_link).toBeTruthy();   // modo simulado, fora de produção

    const token = new URL(request.debug_link).searchParams.get('token');
    expect((await reset.checkToken(token)).valid).toBe(true);

    const done = await reset.resetPassword({ token, password: account.newPassword }, { ip: '::1' });
    expect(done.ok).toBe(true);

    // A senha nova entra; a antiga deixa de entrar.
    const session = await auth.login(account.email, account.newPassword);
    expect(session.token).toBeTruthy();
    await expect(auth.login(account.email, account.password))
      .rejects.toMatchObject({ name: 'InvalidCredentialsError' });
  });

  it('should keep only the hash of the token in the database', async () => {
    const account = await freshAccount();
    const request = await reset.requestReset({ email: account.email }, {});
    const token = new URL(request.debug_link).searchParams.get('token');

    const stored = (await pool.query(
      'SELECT token_hash FROM password_reset_tokens WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1', [COMPANY],
    )).rows[0];

    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toBe(reset.hashToken(token));
  });

  it('should refuse to use the same link twice', async () => {
    const account = await freshAccount();
    const request = await reset.requestReset({ email: account.email }, {});
    const token = new URL(request.debug_link).searchParams.get('token');

    await reset.resetPassword({ token, password: 'primeira2026' }, {});
    await expect(reset.resetPassword({ token, password: 'segunda2026' }, {}))
      .rejects.toThrowError(/já foi utilizado/i);
  });

  it('should invalidate the previous link when a new one is requested', async () => {
    const account = await freshAccount();
    const first = await reset.requestReset({ email: account.email }, {});
    const firstToken = new URL(first.debug_link).searchParams.get('token');

    await reset.requestReset({ email: account.email }, {});     // pedido novo

    expect((await reset.checkToken(firstToken)).valid).toBe(false);
    await expect(reset.resetPassword({ token: firstToken, password: 'qualquer2026' }, {}))
      .rejects.toThrowError(/substituído/i);
  });

  it('should refuse an expired link', async () => {
    const account = await freshAccount();
    const request = await reset.requestReset({ email: account.email }, {});
    const token = new URL(request.debug_link).searchParams.get('token');
    await pool.query(
      "UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1",
      [reset.hashToken(token)],
    );

    expect((await reset.checkToken(token)).valid).toBe(false);
    await expect(reset.resetPassword({ token, password: 'valida2026' }, {}))
      .rejects.toThrowError(/expirou/i);
  });

  it('should refuse an invented token', async () => {
    expect((await reset.checkToken('token-que-nunca-existiu')).valid).toBe(false);
    await expect(reset.resetPassword({ token: 'token-que-nunca-existiu', password: 'valida2026' }, {}))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('should refuse a weak new password and leave the old one working', async () => {
    const account = await freshAccount();
    const request = await reset.requestReset({ email: account.email }, {});
    const token = new URL(request.debug_link).searchParams.get('token');

    await expect(reset.resetPassword({ token, password: 'abc' }, {})).rejects.toThrowError(/pelo menos 8/i);
    // O token continua utilizável: a falha foi da senha, não do link.
    expect((await reset.checkToken(token)).valid).toBe(true);
  });

  // ── Não revelar quem existe ───────────────────────────────────────────────

  it('should answer identically for an account that does not exist', async () => {
    const known = await freshAccount();
    const real = await reset.requestReset({ email: known.email }, {});
    const fake = await reset.requestReset({ email: 'nao-existe.itest@example.mz' }, {});

    expect(fake.message).toBe(real.message);
    expect(fake.ok).toBe(true);
    expect(fake.debug_link).toBeUndefined();   // nada foi criado nem enviado

    const created = await pool.query(
      "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE email = 'nao-existe.itest@example.mz')",
    );
    expect(Number(created.rows[0].n)).toBe(0);
  });

  it('should still validate the email format', async () => {
    await expect(reset.requestReset({ email: 'nao-e-email' }, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── Regras de negócio ─────────────────────────────────────────────────────

  it('should not let a suspended company recover its way back in', async () => {
    const blocked = PasswordResetFactory.account();
    await seedUser({ email: blocked.email, password: blocked.password, companyId: SUSPENDED });

    const request = await reset.requestReset({ email: blocked.email }, {});
    expect(request.message).toBe(reset.NEUTRAL_RESPONSE.message);   // resposta neutra
    expect(request.debug_link).toBeUndefined();                     // mas sem link

    const created = await pool.query(
      'SELECT COUNT(*) AS n FROM password_reset_tokens WHERE company_id = $1', [SUSPENDED],
    );
    expect(Number(created.rows[0].n)).toBe(0);
  });

  it('should throttle repeated requests for the same account', async () => {
    const heavy = PasswordResetFactory.account();
    await seedUser({ email: heavy.email, password: heavy.password });

    const results = [];
    for (let i = 0; i < reset.MAX_REQUESTS_PER_HOUR + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await reset.requestReset({ email: heavy.email }, {}));
    }

    expect(results.filter((r) => r.debug_link).length).toBe(reset.MAX_REQUESTS_PER_HOUR);
    const throttled = results[results.length - 1];
    expect(throttled.throttled).toBe(true);
    // Mesmo travado, a resposta continua indistinguível.
    expect(throttled.message).toBe(reset.NEUTRAL_RESPONSE.message);
  });

  // ── Auditoria ─────────────────────────────────────────────────────────────

  it('should leave an audit trail of the request and of the change', async () => {
    const audited = PasswordResetFactory.account();
    await seedUser({ email: audited.email, password: audited.password });

    const request = await reset.requestReset({ email: audited.email }, { ip: '10.0.0.9' });
    const token = new URL(request.debug_link).searchParams.get('token');
    await reset.resetPassword({ token, password: 'auditada2026' }, { ip: '10.0.0.9' });

    const events = await tenant.runWithCompany(COMPANY, () => audit.listEvents({ pageSize: 50 }));
    const actions = events.items.map((e) => e.action);

    expect(actions).toContain('auth.password_reset_requested');
    expect(actions).toContain('auth.password_reset_completed');

    const requested = events.items.find((e) => e.action === 'auth.password_reset_requested');
    expect(requested.entity_label).toBe(audited.email);
    expect(requested.ip).toBe('10.0.0.9');
    // O token nunca aparece no registo de auditoria.
    expect(JSON.stringify(requested.metadata)).not.toContain(token);
  });
});
