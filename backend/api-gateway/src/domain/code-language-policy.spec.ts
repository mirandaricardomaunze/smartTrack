import { describe, expect, it } from 'vitest';
import {
  CodeLanguagePolicy,
  NamingPolicyFactory,
} from '../../../../tests/harness';

describe('Code language policy', () => {
  it('should classify the canonical naming scenarios', () => {
    const scenarios = NamingPolicyFactory.canonicalCases();

    for (const scenario of scenarios) {
      expect(CodeLanguagePolicy.evaluate(scenario.identifier)).toBe(scenario.expected);
    }
  });

  it('should report only Portuguese technical identifiers', () => {
    const scenarios = NamingPolicyFactory.canonicalCases();
    const identifiers = scenarios.map((scenario) => scenario.identifier);

    expect(CodeLanguagePolicy.violations(identifiers)).toEqual([
      'calcularPrecoEntrega',
      'pedidosPendentes',
      'EventoRastreioFactory',
    ]);
  });

  it('should ignore Portuguese UI strings and comments when auditing source', () => {
    expect(CodeLanguagePolicy.auditSource(NamingPolicyFactory.compliantSource())).toEqual([]);
  });

  it('should report Portuguese declarations with their line numbers', () => {
    expect(CodeLanguagePolicy.auditSource(NamingPolicyFactory.nonCompliantSource())).toEqual([
      { identifier: 'pedidosPendentes', line: 1 },
      { identifier: 'calcularPrecoEntrega', line: 2 },
      { identifier: 'EventoRastreioFactory', line: 3 },
    ]);
  });
});
