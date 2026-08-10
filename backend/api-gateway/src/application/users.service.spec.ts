/**
 * @file users.service.spec.ts
 * @description Testes unitários das decisões puras das contas de acesso.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * Só o que decide sem base de dados: a política das senhas emitidas por um
 * administrador e quem pode administrar quem. O resto (login recusado, acesso do
 * motorista com o id certo, auditoria) está em `tests/integration/user-access.pg.spec.js`.
 */
import { describe, expect, it } from 'vitest';
import { UserAccessFactory } from '../../../../tests/harness';

const {
  checkIssuedPassword, canManage, normalizeEmail, PANEL_ROLES, ROLE_DOORS,
} = require('./users.service');

describe('Contas · política das senhas emitidas', () => {
  it('should accept a password that meets the issued policy', () => {
    expect(checkIssuedPassword(UserAccessFactory.panelUser().password)).toEqual({ ok: true });
  });

  it.each(UserAccessFactory.weakPasswords())('should refuse a password that is $because', ({ password }) => {
    const result = checkIssuedPassword(password);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('should be stricter than the six characters the old register accepted', () => {
    // A senha é escolhida por uma pessoa PARA OUTRA e comunicada por fora do
    // sistema; vive mais tempo em mensagens do que uma senha escolhida por quem a usa.
    expect(checkIssuedPassword('Curta1').ok).toBe(false);
  });
});

describe('Contas · quem administra quem', () => {
  const target = { id: 'user-1', role: 'SUPPORT', company_id: 'company-a' };

  it('should let a company ADMIN manage an account of the same company', () => {
    expect(canManage(UserAccessFactory.admin('company-a'), target)).toEqual({ ok: true });
  });

  it('should let the platform SUPERADMIN manage anything', () => {
    expect(canManage(UserAccessFactory.superadmin(), target)).toEqual({ ok: true });
  });

  it('should never let a company ADMIN touch the platform SUPERADMIN', () => {
    const platform = { id: 'super', role: 'SUPERADMIN', company_id: undefined };
    const decision = canManage(UserAccessFactory.admin('company-a'), platform);

    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/plataforma/i);
  });

  it('should refuse when there is no target account', () => {
    expect(canManage(UserAccessFactory.admin('company-a'), null).ok).toBe(false);
  });
});

describe('Contas · portas de cada papel', () => {
  it('should only offer the panel roles that endpoints actually honour', () => {
    // OPERATOR não existe no sistema: uma conta com um papel que nenhum endpoint
    // reconhece autentica e não faz nada — pior do que não existir.
    expect(PANEL_ROLES).toEqual(['ADMIN', 'SUPPORT']);
  });

  it('should send DRIVER and EMPLOYEE to the door that creates their link', () => {
    expect(ROLE_DOORS.DRIVER).toMatch(/Motoristas/i);
    expect(ROLE_DOORS.EMPLOYEE).toMatch(/portal/i);
  });
});

describe('Contas · normalização do e-mail', () => {
  it('should treat the email as a case-insensitive global identity', () => {
    expect(normalizeEmail('  Joao.Silva@Example.MZ ')).toBe('joao.silva@example.mz');
  });

  it('should survive a missing value', () => {
    expect(normalizeEmail(undefined)).toBe('');
  });
});
