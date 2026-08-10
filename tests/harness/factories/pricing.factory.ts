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
  /** Preço por km acima do incluído. 0 = a zona não cobra distância (§ 3.13). */
  per_km_cents?: number;
  included_km?: number;
  active?: boolean;
  sort_order?: number;
}

/** Dimensões de um volume, em centímetros. Alimentam o peso volumétrico. */
export interface TestDimensions {
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface TestQuoteInput {
  weight_grams?: number;
  zone_code: string;
  service?: ServiceLevel;
  cod_amount?: number;
  dimensions_cm?: TestDimensions;
  distance_km?: number;
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
      // Zero por omissão: a zona-base não cobra distância, tal como acontece
      // numa base já em uso depois da migração.
      per_km_cents: 0,
      included_km:  0,
      active:       true,
      sort_order:   n,
      ...overrides,
    };
  }

  /** Zona que cobra ao km — 15,00 MZN/km com 5 km incluídos. */
  static withDistance(overrides: Partial<TestPricingZoneInput> = {}): TestPricingZoneInput {
    return PricingZoneFactory.build({ per_km_cents: 1500, included_km: 5, ...overrides });
  }
}

/**
 * Caixa de 60×40×50 cm = 120.000 cm³.
 * Com o divisor 5000 dá 24 kg volumétricos — bem acima de qualquer peso real
 * plausível para uma caixa dessas, que é exatamente o caso que o peso
 * volumétrico existe para cobrar.
 */
export const BULKY_BOX_CM = { length_cm: 60, width_cm: 40, height_cm: 50 };

/** Caixa pequena e densa: 20×20×10 = 4.000 cm³ → 0,8 kg volumétricos. */
export const DENSE_BOX_CM = { length_cm: 20, width_cm: 20, height_cm: 10 };

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
