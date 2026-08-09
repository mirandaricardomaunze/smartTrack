/**
 * @file contract.factory.ts
 * @description Factory dos contratos de cliente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export interface TestZoneRate {
  zone_code: string;
  base_cents?: number;
  per_kg_cents?: number;
  included_kg?: number;
}

export interface TestContractInput {
  id?: string;
  client_ref_id: string;
  code: string;
  status: 'draft' | 'active' | 'suspended' | 'ended';
  starts_on: string;
  ends_on: string | null;
  discount_pct: number;
  minimum_charge_cents: number;
  payment_terms_days: number;
  credit_limit_cents: number;
  zone_rates: TestZoneRate[];
  notes?: string | null;
}

/** Detalhe de orçamento tal como `computeQuote` o devolve, para exercitar o contrato. */
export interface TestQuoteBreakdown {
  zone_code: string;
  base_cents: number;
  weight_cents: number;
  service_cents: number;
  modal_cents: number;
  cod_surcharge_cents: number;
  total_cents: number;
}

let contador = 1;

export class ContractFactory {
  /** Contrato ativo, sem termo, com 10% de desconto e pagamento a 30 dias. */
  static build(overrides: Partial<TestContractInput> = {}): TestContractInput {
    const n = contador++;
    return {
      id:                   `contract-test-uuid-${String(n).padStart(4, '0')}`,
      client_ref_id:        `client-test-uuid-${String(n).padStart(4, '0')}`,
      code:                 `CT2026/${String(n).padStart(4, '0')}`,
      status:               'active',
      starts_on:            '2026-01-01',
      ends_on:              null,
      discount_pct:         10,
      minimum_charge_cents: 0,
      payment_terms_days:   30,
      credit_limit_cents:   0,
      zone_rates:           [],
      notes:                null,
      ...overrides,
    };
  }

  /** Contrato com tarifa negociada numa zona — substitui a tabela pública. */
  static withNegotiatedZone(zoneCode = 'MAPUTO_CITY', overrides: Partial<TestContractInput> = {}): TestContractInput {
    return ContractFactory.build({
      zone_rates: [{ zone_code: zoneCode, base_cents: 10_000, per_kg_cents: 1_500, included_kg: 2 }],
      ...overrides,
    });
  }

  /** Contrato com limite de crédito — o que trava encomendas novas. */
  static withCreditLimit(limitCents = 100_000, overrides: Partial<TestContractInput> = {}): TestContractInput {
    return ContractFactory.build({ credit_limit_cents: limitCents, ...overrides });
  }

  /**
   * Orçamento base para exercitar `applyContractToQuote` sem montar a tarifação
   * inteira. Frete de 30.000 (base 20.000 + peso 5.000 + serviço 5.000) e 2.000
   * de sobretaxa de COD — que o desconto NÃO deve tocar.
   */
  static quote(overrides: Partial<TestQuoteBreakdown> = {}): TestQuoteBreakdown {
    return {
      zone_code:           'MAPUTO_CITY',
      base_cents:          20_000,
      weight_cents:         5_000,
      service_cents:        5_000,
      modal_cents:              0,
      cod_surcharge_cents:  2_000,
      total_cents:         32_000,
      ...overrides,
    };
  }
}
