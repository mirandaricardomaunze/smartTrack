/**
 * @file company.factory.ts
 * @description Test factory para empresas (multi-tenant).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4
 *
 * Alinhado com backend/shared/types/src/company.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { CompanyStatus } from '../../../backend/shared/types/src/company.types';

export interface TestCompanyInput {
  id: string;
  name: string;
  slug?: string;
  status?: CompanyStatus;
}

let _counter = 1;

export class CompanyFactory {
  static build(overrides: Partial<TestCompanyInput> = {}): TestCompanyInput {
    const n = _counter++;
    return {
      id:     `company-itest-${n.toString().padStart(4, '0')}`,
      name:   `Empresa Teste ${n}`,
      slug:   `empresa-teste-${n}`,
      status: CompanyStatus.ACTIVE,
      ...overrides,
    };
  }
}

export { CompanyStatus };
