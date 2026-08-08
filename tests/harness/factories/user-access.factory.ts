/**
 * @file user-access.factory.ts
 * @description Test factory das contas de acesso ao sistema.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * As senhas aqui cumprem a política das senhas EMITIDAS por um administrador (10
 * caracteres, maiúscula, minúscula e número). As que não cumprem estão em
 * `weakPasswords()`, de propósito — é o que se passa ao teste que verifica a
 * recusa, para os limiares não ficarem escritos à mão em cada .spec.
 */

export type TestAccountRole = 'ADMIN' | 'SUPPORT' | 'DRIVER' | 'EMPLOYEE' | 'SUPERADMIN';

export interface TestPanelUserInput {
  name: string;
  email: string;
  password: string;
  role: 'ADMIN' | 'SUPPORT';
}

export interface TestDriverAccessInput {
  email: string;
  password: string;
}

/** Ator que chega ao serviço a partir do JWT (`req.user`). */
export interface TestActor {
  sub: string;
  email: string;
  role: TestAccountRole;
  company_id: string | null;
}

let _counter = 1;

export class UserAccessFactory {
  /** Conta de painel válida — o caso que deve passar. */
  static panelUser(overrides: Partial<TestPanelUserInput> = {}): TestPanelUserInput {
    const n = _counter++;
    return {
      name: `Operador ITEST ${n}`,
      email: `operador.itest.${n}@example.mz`,
      password: 'SenhaForte2026',
      role: 'SUPPORT',
      ...overrides,
    };
  }

  /** Conta de painel com o papel de administrador. */
  static adminUser(overrides: Partial<TestPanelUserInput> = {}): TestPanelUserInput {
    return UserAccessFactory.panelUser({ role: 'ADMIN', ...overrides });
  }

  /** Acesso à aplicação do motorista. */
  static driverAccess(overrides: Partial<TestDriverAccessInput> = {}): TestDriverAccessInput {
    const n = _counter++;
    return {
      email: `motorista.itest.${n}@example.mz`,
      password: 'MotoristaSeguro2026',
      ...overrides,
    };
  }

  /** Ator ADMIN da empresa indicada. */
  static admin(companyId: string, overrides: Partial<TestActor> = {}): TestActor {
    const n = _counter++;
    return {
      sub: `admin-itest-${n}`,
      email: `admin.itest.${n}@example.mz`,
      role: 'ADMIN',
      company_id: companyId,
      ...overrides,
    };
  }

  /** Ator SUPERADMIN da plataforma — sem empresa. */
  static superadmin(overrides: Partial<TestActor> = {}): TestActor {
    return {
      sub: 'superadmin-itest',
      email: 'plataforma.itest@example.mz',
      role: 'SUPERADMIN',
      company_id: null,
      ...overrides,
    };
  }

  /**
   * Senhas que a política tem de recusar, com o motivo esperado.
   * Cada caso existe por uma razão diferente: comprimento, falta de número,
   * falta de letra e falta de maiúscula.
   */
  static weakPasswords(): Array<{ password: string; because: string }> {
    return [
      { password: 'Curta1',          because: 'menos de 10 caracteres' },
      { password: 'SenhaSemNumero',  because: 'sem número' },
      { password: '1234567890',      because: 'sem letra' },
      { password: 'senhaminuscula1', because: 'sem maiúscula' },
    ];
  }
}
