/**
 * @file pagination.factory.ts
 * @description Cenários canónicos para testes de paginação dos frontends SmartTrack.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4, § 3.11
 */

export interface TestPaginationScenario {
  id: string;
  totalItems: number;
  pageSize: number;
  currentPage: number;
}

let counter = 1;

export class PaginationFactory {
  static build(overrides: Partial<TestPaginationScenario> = {}): TestPaginationScenario {
    const n = counter++;
    return {
      id: `pagination-test-uuid-${String(n).padStart(4, '0')}`,
      totalItems: 23,
      pageSize: 10,
      currentPage: 1,
      ...overrides,
    };
  }

  static buildList(
    count: number,
    overrides: Partial<TestPaginationScenario> = {},
  ): TestPaginationScenario[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  static buildEmpty(overrides: Partial<TestPaginationScenario> = {}): TestPaginationScenario {
    return this.build({ totalItems: 0, currentPage: 1, ...overrides });
  }
}
