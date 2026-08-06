/**
 * @file pricing.factory.ts
 * @description Test factory para tarifação (zonas e orçamentos).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * Alinhado com backend/shared/types/src/pricing.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { ServiceLevel } from '../../../backend/shared/types/src/pricing.types';

export interface TestPricingZoneInput {
  code: string;
  name: string;
  base_cents: number;
  per_kg_cents: number;
  included_kg: number;
  active?: boolean;
  sort_order?: number;
}

export interface TestQuoteInput {
  weight_grams?: number;
  zone_code: string;
  service?: ServiceLevel;
  cod_amount?: number;
}

let _counter = 1;

export class PricingZoneFactory {
  static build(overrides: Partial<TestPricingZoneInput> = {}): TestPricingZoneInput {
    const n = _counter++;
    return {
      code:         `ZONE_ITEST_${n}`,
      name:         `Zona Teste ${n}`,
      base_cents:   20000,   // 200,00 MZN
      per_kg_cents: 3000,    // 30,00 MZN/kg
      included_kg:  1,
      active:       true,
      sort_order:   n,
      ...overrides,
    };
  }
}

export class QuoteInputFactory {
  static build(zoneCode: string, overrides: Partial<TestQuoteInput> = {}): TestQuoteInput {
    return {
      weight_grams: 2500,
      zone_code:    zoneCode,
      service:      ServiceLevel.NORMAL,
      cod_amount:   0,
      ...overrides,
    };
  }
}

export { ServiceLevel };
