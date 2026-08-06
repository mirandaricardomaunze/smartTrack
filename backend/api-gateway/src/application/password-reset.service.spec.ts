/**
 * @file password-reset.service.spec.ts
 * @description Testes unitários do núcleo da recuperação de senha.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * Prova, sem base de dados nem email, o que sustenta a segurança do mecanismo:
 * o token é imprevisível e só viaja em hash, um link usado/substituído/expirado
 * deixa de servir, e a política de senha recusa o que é fraco. Dados via
 * factories do harness.
 */
import { describe, expect, it } from 'vitest';
import { PasswordResetFactory } from '../../../../tests/harness';

const { generateToken, hashToken, evaluateToken, buildEmail, TTL_MINUTES } = require('./password-reset.service');
const { passwordStrength, hashPassword, verifyPassword } = require('../infrastructure/password.utils');

describe('Recuperação · token', () => {
  it('should never repeat a token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(tokens.size).toBe(200);
  });

  it('should be long enough to resist guessing', () => {
    // 32 bytes em base64url — o que se envia no link.
    expect(generateToken().token.length).toBeGreaterThanOrEqual(43);
  });

  it('should be URL-safe so the link does not break', () => {
    expect(generateToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should hand out the hash, never letting the plain token be derived from it', () => {
    const { token, token_hash: hash } = generateToken();
    expect(hash).toHaveLength(64);            // sha256 em hexadecimal
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);      // a verificação recalcula o mesmo
  });

  it('should give a different hash for a different token', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('Recuperação · validade do link', () => {
  it('should accept a fresh token', () => {
    expect(evaluateToken(PasswordResetFactory.token())).toEqual({ valid: true });
  });

  it('should refuse a token that was already used', () => {
    const result = evaluateToken(PasswordResetFactory.used());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/já foi utilizado/i);
  });

  it('should refuse a token replaced by a newer request', () => {
    const result = evaluateToken(PasswordResetFactory.invalidated());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/substituído/i);
  });

  it('should refuse an expired token', () => {
    const result = evaluateToken(PasswordResetFactory.expired());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expirou/i);
  });

  it('should refuse a token that does not exist at all', () => {
    expect(evaluateToken(undefined)).toMatchObject({ valid: false });
  });

  it('should expire exactly at the deadline, not a second later', () => {
    const at = '2026-08-03T10:00:00.000Z';
    const token = PasswordResetFactory.token({ expires_at: at });

    expect(evaluateToken(token, new Date('2026-08-03T09:59:59.000Z')).valid).toBe(true);
    expect(evaluateToken(token, new Date(at)).valid).toBe(false);
  });
});

describe('Recuperação · email', () => {
  const link = 'https://admin.example.com/redefinir-senha?token=abc';

  it('should carry the link and the validity window', () => {
    const message = buildEmail({ name: 'Ana', link, ttlMinutes: 60 });
    expect(message.body).toContain(link);
    expect(message.body).toContain('60 minutos');
    expect(message.subject).toMatch(/senha/i);
  });

  it('should tell the reader what to do if it was not them', () => {
    expect(buildEmail({ name: 'Ana', link }).body).toMatch(/ignore este email/i);
  });

  it('should sign with the company name when there is one', () => {
    const message = buildEmail({ name: 'Ana', link, companyName: 'Transportes Maunze' });
    expect(message.subject).toContain('Transportes Maunze');
  });

  it('should not fall apart without a name', () => {
    expect(buildEmail({ link }).body).toContain(link);
  });

  it('should default to the configured validity window', () => {
    expect(buildEmail({ link }).body).toContain(`${TTL_MINUTES} minutos`);
  });
});

describe('Recuperação · política de senha', () => {
  it.each([
    ['curta', 'abc1'],
    ['sem número', 'apenasletras'],
    ['sem letra', '123456789'],
  ])('should refuse a password that is %s', (_label, password) => {
    expect(passwordStrength(password, { min: 8 }).ok).toBe(false);
  });

  it('should accept a reasonable password', () => {
    expect(passwordStrength('entrega2026', { min: 8 })).toEqual({ ok: true });
  });

  it('should support the stricter policy of the employee portal', () => {
    expect(passwordStrength('Entrega2026', { min: 10, requireMixedCase: true }).ok).toBe(true);
    expect(passwordStrength('entrega2026', { min: 10, requireMixedCase: true }).ok).toBe(false);
  });

  it('should store the new password hashed and verifiable', () => {
    const stored = hashPassword('entrega2026');
    expect(stored).not.toContain('entrega2026');
    expect(verifyPassword('entrega2026', stored)).toBe(true);
    expect(verifyPassword('outra-senha', stored)).toBe(false);
  });
});
