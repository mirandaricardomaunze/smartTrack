/**
 * @file pricing.service.js
 * @description Camada de aplicação — tarifação (motor de preços por peso/zona).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * `computeQuote` é PURA (recebe entrada + zona + config e devolve o detalhe em
 * centavos). O caso de uso `quote` carrega a zona e delega. Valores em centavos (MZN).
 * Multiplicador de serviço e sobretaxa de COD são configuráveis por ambiente.
 */
'use strict';

const crypto = require('crypto');
const { PricingRepository } = require('../infrastructure/pg.repository');

const ServiceLevel = Object.freeze({ NORMAL: 'normal', EXPRESS: 'express' });

/** Multiplicadores por nível de serviço (EXPRESS configurável por ambiente). */
const SERVICE_MULTIPLIERS = Object.freeze({
  [ServiceLevel.NORMAL]:  1,
  [ServiceLevel.EXPRESS]: Number(process.env.PRICING_EXPRESS_MULTIPLIER) || 1.5,
});

/** Sobretaxa de COD como % do valor a cobrar (0 = desligada por default). */
const COD_SURCHARGE_PCT = Number(process.env.PRICING_COD_SURCHARGE_PCT) || 0;

// ─── Erros ───────────────────────────────────────────────────────────────────

class PricingValidationError extends Error {
  constructor(message) { super(message); this.name = 'PricingValidationError'; this.statusCode = 400; }
}
class ZoneNotFoundError extends Error {
  constructor(code) { super(`Zona de tarifação não encontrada: ${code}`); this.name = 'ZoneNotFoundError'; this.statusCode = 404; }
}
class DuplicateZoneCodeError extends Error {
  constructor(code) { super(`Já existe uma zona com o código "${code}".`); this.name = 'DuplicateZoneCodeError'; this.statusCode = 409; }
}

// ─── Cálculo (puro) ──────────────────────────────────────────────────────────

/**
 * Calcula o orçamento de frete.
 * @param {{ weight_grams?: number; service?: string; cod_amount?: number }} input
 * @param {{ code: string; name: string; base_cents: number; per_kg_cents: number; included_kg: number }} zone
 * @param {{ serviceMultipliers?: object; codSurchargePct?: number }} [cfg]
 * @returns {import('../../../shared/types/src/pricing.types').QuoteBreakdown}
 */
function computeQuote(input, zone, cfg = {}) {
  const multipliers = cfg.serviceMultipliers ?? SERVICE_MULTIPLIERS;
  const codPct = cfg.codSurchargePct ?? COD_SURCHARGE_PCT;

  const service = input.service && multipliers[input.service] != null ? input.service : ServiceLevel.NORMAL;
  const weightGrams = Math.max(0, Math.round(Number(input.weight_grams) || 0));
  const codAmount = Math.max(0, Math.round(Number(input.cod_amount) || 0));

  const includedGrams = Math.round(Number(zone.included_kg) * 1000);
  const excessGrams = Math.max(0, weightGrams - includedGrams);

  const base_cents = Math.round(Number(zone.base_cents));
  const weight_cents = Math.round((Number(zone.per_kg_cents) * excessGrams) / 1000);

  const preService = base_cents + weight_cents;
  const service_cents = Math.round(preService * (multipliers[service] - 1));
  const cod_surcharge_cents = Math.round((codAmount * codPct) / 100);

  const total_cents = base_cents + weight_cents + service_cents + cod_surcharge_cents;

  return {
    zone_code: zone.code,
    zone_name: zone.name,
    service,
    weight_grams: weightGrams,
    base_cents,
    weight_cents,
    service_cents,
    cod_surcharge_cents,
    total_cents,
    currency: 'MZN',
  };
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/** Orçamento a partir do código de zona. */
async function quote(input = {}) {
  if (!input.zone_code) throw new PricingValidationError('A zona é obrigatória.');
  const zone = await PricingRepository.findZoneByCode(input.zone_code);
  if (!zone) throw new ZoneNotFoundError(input.zone_code);
  if (!zone.active) throw new PricingValidationError(`A zona "${zone.code}" está inativa.`);
  return computeQuote(input, zone);
}

async function listZones(opts = {}) {
  return PricingRepository.listZones(opts);
}

function validateZoneNumbers(dto) {
  for (const field of ['base_cents', 'per_kg_cents']) {
    if (dto[field] !== undefined && (!Number.isFinite(Number(dto[field])) || Number(dto[field]) < 0)) {
      throw new PricingValidationError(`"${field}" deve ser um valor não negativo (centavos).`);
    }
  }
  if (dto.included_kg !== undefined && (!Number.isFinite(Number(dto.included_kg)) || Number(dto.included_kg) < 0)) {
    throw new PricingValidationError('"included_kg" deve ser não negativo.');
  }
}

async function createZone(dto = {}) {
  const code = typeof dto.code === 'string' ? dto.code.trim().toUpperCase().replace(/\s+/g, '_') : '';
  const name = typeof dto.name === 'string' ? dto.name.trim() : '';
  if (!code) throw new PricingValidationError('O código da zona é obrigatório.');
  if (!name) throw new PricingValidationError('O nome da zona é obrigatório.');
  validateZoneNumbers(dto);
  if (await PricingRepository.findZoneByCode(code)) throw new DuplicateZoneCodeError(code);

  return PricingRepository.createZone({
    id: crypto.randomUUID(),
    code,
    name,
    base_cents: Math.round(Number(dto.base_cents) || 0),
    per_kg_cents: Math.round(Number(dto.per_kg_cents) || 0),
    included_kg: Number(dto.included_kg) || 0,
    active: dto.active !== false,
    sort_order: Number(dto.sort_order) || 0,
  });
}

async function updateZone(id, patch = {}) {
  const existing = await PricingRepository.findZoneById(id);
  if (!existing) throw new ZoneNotFoundError(id);
  validateZoneNumbers(patch);

  const clean = {};
  if (patch.name         !== undefined) clean.name = String(patch.name).trim();
  if (patch.base_cents   !== undefined) clean.base_cents = Math.round(Number(patch.base_cents));
  if (patch.per_kg_cents !== undefined) clean.per_kg_cents = Math.round(Number(patch.per_kg_cents));
  if (patch.included_kg  !== undefined) clean.included_kg = Number(patch.included_kg);
  if (patch.active       !== undefined) clean.active = Boolean(patch.active);
  if (patch.sort_order   !== undefined) clean.sort_order = Number(patch.sort_order);
  return PricingRepository.updateZone(id, clean);
}

async function deactivateZone(id) {
  return updateZone(id, { active: false });
}

module.exports = {
  computeQuote,          // pura — exportada para teste
  quote,
  listZones,
  createZone,
  updateZone,
  deactivateZone,
  SERVICE_MULTIPLIERS,
  ServiceLevel,
  PricingValidationError,
  ZoneNotFoundError,
  DuplicateZoneCodeError,
};
