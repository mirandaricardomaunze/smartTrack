/**
 * @file password-reset.factory.ts
 * @description Test factory da recuperação de senha.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export interface TestResetToken {
  id: string;
  user_id: string;
  company_id?: string;
  token_hash: string;
  expires_at: string;
  used_at?: string;
  invalidated_at?: string;
  requested_ip?: string;
  created_at: string;
}

const MINUTE = 60_000;
let _counter = 1;

export class PasswordResetFactory {
  /** Token válido, a expirar dentro de meia hora. */
  static token(overrides: Partial<TestResetToken> = {}): TestResetToken {
    const n = _counter++;
    const now = Date.now();
    return {
      id: `reset-itest-${n}`,
      user_id: 'user-itest-0001',
      company_id: 'company-itest-reset',
      token_hash: `hash-itest-${n}`,
      expires_at: new Date(now + 30 * MINUTE).toISOString(),
      requested_ip: '::1',
      created_at: new Date(now).toISOString(),
      ...overrides,
    };
  }

  /** Já usado — um link não serve duas vezes. */
  static used(overrides: Partial<TestResetToken> = {}): TestResetToken {
    return PasswordResetFactory.token({ used_at: new Date().toISOString(), ...overrides });
  }

  /** Substituído por um pedido mais recente. */
  static invalidated(overrides: Partial<TestResetToken> = {}): TestResetToken {
    return PasswordResetFactory.token({ invalidated_at: new Date().toISOString(), ...overrides });
  }

  /** Fora do prazo. */
  static expired(overrides: Partial<TestResetToken> = {}): TestResetToken {
    return PasswordResetFactory.token({ expires_at: new Date(Date.now() - MINUTE).toISOString(), ...overrides });
  }

  /** Conta de teste para o fluxo completo. */
  static account(overrides: Record<string, unknown> = {}) {
    const n = _counter++;
    return {
      name: `Utilizador Recuperação ${n}`,
      email: `recuperacao.itest.${n}@example.mz`,
      password: 'senhaAntiga2026',
      newPassword: 'senhaNova2026',
      ...overrides,
    };
  }
}
