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
const modals = require('../domain/delivery-modals');

const ServiceLevel = Object.freeze({ NORMAL: 'normal', EXPRESS: 'express' });

/** Multiplicadores por nível de serviço (EXPRESS configurável por ambiente). */
const SERVICE_MULTIPLIERS = Object.freeze({
  [ServiceLevel.NORMAL]:  1,
  [ServiceLevel.EXPRESS]: Number(process.env.PRICING_EXPRESS_MULTIPLIER) || 1.5,
});

/**
 * Multiplicadores por modal de entrega (§ 3.33).
 *
 * Uma entrega de moto não custa o mesmo que uma de van, e cobrar igual empurra
 * o cliente para o concorrente na encomenda pequena — que é o grosso do volume.
 * O default vem do catálogo (moto 0,7 · mototriciclo 0,85 · carro 1) e cada
 * modal é sobreponível por ambiente, como o EXPRESS: `PRICING_MODAL_MOTO_MULTIPLIER`.
 * Sem modal na entrada o preço fica exatamente como estava — 1, sem linha.
 */
const MODAL_MULTIPLIERS = Object.freeze(Object.fromEntries(
  modals.listModals().map((modal) => [
    modal.code,
    Number(process.env[`PRICING_MODAL_${modal.code}_MULTIPLIER`]) || modal.price_multiplier,
  ]),
));

/** Sobretaxa de COD como % do valor a cobrar (0 = desligada por default). */
const COD_SURCHARGE_PCT = Number(process.env.PRICING_COD_SURCHARGE_PCT) || 0;

/**
 * Divisor do peso volumétrico: cm³ por quilo cobrável.
 *
 * PORQUE ISTO EXISTE: um colchão pesa 8 kg e ocupa a carrinha inteira. Cobrado
 * ao peso, essa entrega dá prejuízo — o custo não é o peso, é o espaço que nega
 * a outra encomenda. O peso volumétrico converte espaço em quilos cobráveis.
 *
 * 5000 é a convenção mais comum (aéreo/courier); o transporte rodoviário usa
 * por vezes 4000 ou 6000. Por ambiente, porque é uma política da empresa e não
 * uma regra por zona: usar divisores diferentes na mesma tabela tornaria
 * impossível explicar ao cliente porque a mesma caixa custa dois preços.
 */
const VOLUMETRIC_DIVISOR = Number(process.env.PRICING_VOLUMETRIC_DIVISOR) || 5000;

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
 * Normaliza as dimensões de um volume, em centímetros. PURA.
 *
 * Devolve `null` se faltar qualquer lado: com duas medidas não se calcula
 * volume nenhum, e assumir a terceira produziria um preço inventado. Metade das
 * dimensões é o mesmo que nenhumas.
 *
 * @param {{ length_cm?: number, width_cm?: number, height_cm?: number }} [dims]
 * @returns {{ length_cm: number, width_cm: number, height_cm: number }|null}
 */
function normalizeDimensions(dims) {
  if (!dims || typeof dims !== 'object') return null;
  const lados = ['length_cm', 'width_cm', 'height_cm'].map((k) => Number(dims[k]));
  if (lados.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return { length_cm: lados[0], width_cm: lados[1], height_cm: lados[2] };
}

/**
 * Peso volumétrico em gramas. PURA.
 *
 * `(C × L × A em cm) / divisor` dá quilos; daí o ×1000.
 *
 * @param {{ length_cm: number, width_cm: number, height_cm: number }|null} dims
 * @param {number} [divisor]
 * @returns {number} 0 quando não há dimensões.
 */
function volumetricGrams(dims, divisor = VOLUMETRIC_DIVISOR) {
  if (!dims) return 0;
  const d = Number(divisor) > 0 ? Number(divisor) : VOLUMETRIC_DIVISOR;
  const cm3 = dims.length_cm * dims.width_cm * dims.height_cm;
  return Math.round((cm3 / d) * 1000);
}

/**
 * Carga física derivada das dimensões — volume em litros e maior lado. PURA.
 *
 * Serve a verificação de modal (§ 3.33), que já sabe recusar por volume e por
 * lado mas nunca recebia esses valores: uma caixa de 1,5 m passava na conta de
 * peso e não entrava na moto.
 *
 * @param {{ length_cm: number, width_cm: number, height_cm: number }|null} dims
 * @returns {{ volume_l?: number, longest_side_cm?: number }}
 */
function loadFromDimensions(dims) {
  if (!dims) return {};
  return {
    volume_l: Number(((dims.length_cm * dims.width_cm * dims.height_cm) / 1000).toFixed(2)),
    longest_side_cm: Math.max(dims.length_cm, dims.width_cm, dims.height_cm),
  };
}

/**
 * Parcela de distância, em centavos. PURA.
 *
 * Só os km ACIMA dos incluídos são cobrados: numa zona urbana, cobrar desde o
 * primeiro metro faz a entrega ao lado do armazém sair mais cara do que a
 * concorrência.
 *
 * @param {number} distanceKm
 * @param {{ per_km_cents?: number, included_km?: number }} zone
 * @returns {number}
 */
function distanceCents(distanceKm, zone) {
  const perKm = Math.max(0, Number(zone?.per_km_cents) || 0);
  if (perKm === 0) return 0;
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return 0;
  const incluidos = Math.max(0, Number(zone?.included_km) || 0);
  return Math.round(perKm * Math.max(0, km - incluidos));
}

/**
 * Calcula o orçamento de frete.
 *
 * O modal é opcional: sem ele o cálculo é o de sempre e o detalhe traz
 * `modal_cents: 0`. Com ele, o preço é ajustado pelo multiplicador do modal e o
 * detalhe diz se a carga cabe — orçar 40 kg "de moto" tem de responder que não
 * cabe, e não devolver um preço que a operação depois não consegue cumprir
 * (§ 3.33). O orçamento não é recusado: `suggested_modal` dá a alternativa.
 *
 * PESO COBRÁVEL: com dimensões, cobra-se o MAIOR entre o peso real e o
 * volumétrico. O detalhe traz os dois e a bandeira `charged_by_volume`, porque
 * "porque é que pago 12 kg se a caixa pesa 3?" é a pergunta mais frequente de
 * quem recebe a fatura — e sem os dois números não tem resposta.
 *
 * DISTÂNCIA: parcela própria, somada ANTES dos multiplicadores. Um expresso a
 * 60 km custa mais do que um normal a 60 km; deixar a distância fora do
 * multiplicador dava o mesmo acréscimo aos dois.
 *
 * Sem dimensões e sem distância, o resultado é bit a bit o de antes.
 *
 * @param {{ weight_grams?: number; service?: string; cod_amount?: number; vehicle_modal?: string; dimensions_cm?: object; distance_km?: number }} input
 * @param {{ code: string; name: string; base_cents: number; per_kg_cents: number; included_kg: number; per_km_cents?: number; included_km?: number }} zone
 * @param {{ serviceMultipliers?: object; modalMultipliers?: object; codSurchargePct?: number; volumetricDivisor?: number }} [cfg]
 * @returns {import('../../../shared/types/src/pricing.types').QuoteBreakdown}
 */
function computeQuote(input, zone, cfg = {}) {
  const multipliers = cfg.serviceMultipliers ?? SERVICE_MULTIPLIERS;
  const modalMultipliers = cfg.modalMultipliers ?? MODAL_MULTIPLIERS;
  const codPct = cfg.codSurchargePct ?? COD_SURCHARGE_PCT;
  const divisor = cfg.volumetricDivisor ?? VOLUMETRIC_DIVISOR;

  const service = input.service && multipliers[input.service] != null ? input.service : ServiceLevel.NORMAL;
  const weightGrams = Math.max(0, Math.round(Number(input.weight_grams) || 0));
  const codAmount = Math.max(0, Math.round(Number(input.cod_amount) || 0));

  const dimensions = normalizeDimensions(input.dimensions_cm);
  const volumetric_grams = volumetricGrams(dimensions, divisor);
  const chargeable_grams = Math.max(weightGrams, volumetric_grams);

  const vehicle_modal = modals.normalizeModalCode(input.vehicle_modal);
  const modalMultiplier = vehicle_modal ? (modalMultipliers[vehicle_modal] ?? 1) : 1;

  const includedGrams = Math.round(Number(zone.included_kg) * 1000);
  const excessGrams = Math.max(0, chargeable_grams - includedGrams);

  const base_cents = Math.round(Number(zone.base_cents));
  const weight_cents = Math.round((Number(zone.per_kg_cents) * excessGrams) / 1000);
  const distance_cents = distanceCents(input.distance_km, zone);

  const preService = base_cents + weight_cents + distance_cents;
  const service_cents = Math.round(preService * (multipliers[service] - 1));
  const modal_cents = Math.round(preService * (modalMultiplier - 1));
  const cod_surcharge_cents = Math.round((codAmount * codPct) / 100);

  const total_cents = preService + service_cents + modal_cents + cod_surcharge_cents;

  // A verificação de modal recebe o PESO REAL e não o cobrável — o veículo
  // carrega quilos, não unidades de faturação —, mas agora também o volume e o
  // maior lado, que o § 3.33 já sabia recusar e nunca recebia.
  const carga = { weight_grams: weightGrams, ...loadFromDimensions(dimensions) };
  const fit = vehicle_modal ? modals.fitsModal(carga, vehicle_modal) : { ok: true };

  return {
    zone_code: zone.code,
    zone_name: zone.name,
    service,
    vehicle_modal,
    weight_grams: weightGrams,
    dimensions_cm: dimensions,
    volumetric_grams,
    chargeable_grams,
    // O peso volumétrico só "manda" quando é o maior — e é aí que a fatura
    // precisa de o justificar.
    charged_by_volume: volumetric_grams > weightGrams,
    distance_km: Number.isFinite(Number(input.distance_km)) && Number(input.distance_km) > 0
      ? Number(input.distance_km)
      : null,
    base_cents,
    weight_cents,
    distance_cents,
    service_cents,
    modal_cents,
    cod_surcharge_cents,
    total_cents,
    currency: 'MZN',
    modal_fits: fit.ok,
    modal_reason: fit.ok ? null : fit.reason,
    // Sem modal pedido, é a recomendação; com modal a mais pequeno que serve.
    suggested_modal: modals.smallestModalFor(carga),
  };
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/**
 * Orçamento a partir do código de zona.
 *
 * Com `client_ref_id`, o contrato em vigor (§ 3.35) entra no cálculo em dois
 * momentos distintos e por razões distintas:
 *
 *   1. a **tarifa negociada da zona** substitui a tabela pública ANTES de
 *      `computeQuote`, para que o multiplicador de expresso e o do modal
 *      incidam sobre o preço acordado — aplicá-la depois daria um expresso
 *      calculado sobre um preço que aquele cliente não paga;
 *   2. o **desconto e o piso** aplicam-se DEPOIS, sobre o frete já formado.
 *
 * Sem cliente, ou sem contrato em vigor, o resultado é exatamente o de antes.
 */
async function quote(input = {}) {
  if (!input.zone_code) throw new PricingValidationError('A zona é obrigatória.');

  // Um modal que o catálogo não conhece é erro, não ausência: ignorá-lo em
  // silêncio devolvia o preço de carro a quem escreveu "motoo" e pediu moto.
  if (input.vehicle_modal != null && String(input.vehicle_modal).trim() !== ''
      && !modals.normalizeModalCode(input.vehicle_modal)) {
    throw new PricingValidationError(
      `Modal de entrega inválido: "${input.vehicle_modal}". Use ${modals.MODAL_CODES.join(', ')}.`,
    );
  }

  const zone = await PricingRepository.findZoneByCode(input.zone_code);
  if (!zone) throw new ZoneNotFoundError(input.zone_code);
  if (!zone.active) throw new PricingValidationError(`A zona "${zone.code}" está inativa.`);

  // `require` aqui dentro e não no topo: `contracts.service` importa o
  // repositório, que importa este módulo em cadeia. Carregar à chamada quebra o
  // ciclo sem obrigar a mover código de sítio.
  const contracts = require('./contracts.service');
  const contract = input.client_ref_id
    ? await contracts.contractForClient(input.client_ref_id, input.on_date)
    : null;

  const negociada = contracts.zoneRateFor(contract, zone.code);
  const zonaEfetiva = negociada
    ? {
      ...zone,
      base_cents:   negociada.base_cents   ?? zone.base_cents,
      per_kg_cents: negociada.per_kg_cents ?? zone.per_kg_cents,
      included_kg:  negociada.included_kg  ?? zone.included_kg,
      per_km_cents: negociada.per_km_cents ?? zone.per_km_cents,
      included_km:  negociada.included_km  ?? zone.included_km,
      // Marca a origem do preço: quem lê o orçamento tem de distinguir uma
      // tarifa acordada de um desconto sobre a tabela pública.
      negotiated: true,
    }
    : zone;

  const bruto = computeQuote(input, zonaEfetiva);
  return {
    ...contracts.applyContractToQuote(bruto, contract),
    negotiated_zone_rate: Boolean(negociada),
  };
}

async function listZones(opts = {}) {
  return PricingRepository.listZones(opts);
}

function validateZoneNumbers(dto) {
  for (const field of ['base_cents', 'per_kg_cents', 'per_km_cents']) {
    if (dto[field] !== undefined && (!Number.isFinite(Number(dto[field])) || Number(dto[field]) < 0)) {
      throw new PricingValidationError(`"${field}" deve ser um valor não negativo (centavos).`);
    }
  }
  for (const field of ['included_kg', 'included_km']) {
    if (dto[field] !== undefined && (!Number.isFinite(Number(dto[field])) || Number(dto[field]) < 0)) {
      throw new PricingValidationError(`"${field}" deve ser não negativo.`);
    }
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
    per_km_cents: Math.round(Number(dto.per_km_cents) || 0),
    included_km: Number(dto.included_km) || 0,
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
  // Puras — exportadas para teste
  computeQuote,
  normalizeDimensions,
  volumetricGrams,
  loadFromDimensions,
  distanceCents,
  quote,
  listZones,
  createZone,
  updateZone,
  deactivateZone,
  SERVICE_MULTIPLIERS,
  MODAL_MULTIPLIERS,
  VOLUMETRIC_DIVISOR,
  ServiceLevel,
  PricingValidationError,
  ZoneNotFoundError,
  DuplicateZoneCodeError,
};
