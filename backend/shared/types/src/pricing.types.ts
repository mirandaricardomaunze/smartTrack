/**
 * @file pricing.types.ts
 * @description Tipos de tarifação (motor de preços por peso/zona).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * O preço do frete é derivado de uma zona de destino (preço base + preço por kg,
 * com peso incluído) e de um nível de serviço (multiplicador). Opcionalmente há
 * sobretaxa de COD. Todos os valores em centavos (MZN). O cálculo é uma função
 * pura; a faturação (§3.14) consome o detalhe (`QuoteBreakdown`).
 */

/** Nível de serviço. */
export enum ServiceLevel {
  NORMAL  = 'normal',
  EXPRESS = 'express',
}

/** Zona de destino com a sua tabela de tarifa. */
export interface PricingZone {
  id: string;
  code: string;            // ex.: 'MAPUTO_CITY'
  name: string;            // ex.: 'Maputo Cidade'
  base_cents: number;      // preço base (inclui `included_kg`)
  per_kg_cents: number;    // preço por kg acima do incluído
  included_kg: number;     // peso incluído no base
  active: boolean;
  sort_order: number;
  created_at: string;      // ISO8601 UTC
  updated_at: string;      // ISO8601 UTC
}

/** Entrada do cálculo de orçamento. */
export interface QuoteInput {
  weight_grams?: number;
  zone_code: string;
  service?: ServiceLevel;
  cod_amount?: number;     // centavos, se houver COD
}

/** Detalhe do orçamento (linhas + total), tudo em centavos. */
export interface QuoteBreakdown {
  zone_code: string;
  zone_name: string;
  service: ServiceLevel;
  weight_grams: number;
  base_cents: number;
  weight_cents: number;
  service_cents: number;       // extra do nível de serviço
  cod_surcharge_cents: number;
  total_cents: number;
  currency: 'MZN';
}
