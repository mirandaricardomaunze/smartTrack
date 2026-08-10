/**
 * @file delivery-modals.js
 * @description Catálogo de modais de entrega — motociclo, mototriciclo e viaturas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.33
 *
 * PORQUE UM CATÁLOGO E NÃO UMA LISTA DE STRINGS: até aqui o tipo de veículo
 * existia em três sítios que não se conheciam — a lista fechada do cadastro de
 * motoristas (`['MOTO','CARRO','VAN','CAMINHAO']`), o texto livre de
 * `fleet_vehicles.vehicle_type` (onde já havia `'pickup'`) e nada na tarifação.
 * Nenhum deles sabia quanto é que o veículo carrega, por isso não havia como
 * recusar 300 kg atribuídos a uma moto nem como cobrar diferente por modal. Este
 * módulo é a única fonte de verdade: capacidade, volume, carta exigida e
 * multiplicador de tarifa. É PURO — nada de base de dados, nada de I/O — para
 * poder ser exercido em teste unitário e reutilizado por qualquer camada.
 *
 * MOTOCICLISTA E MOTOTRICICLISTA: são os dois modais de última milha dominantes
 * em Moçambique. Ficam no catálogo com limites reais (a moto leva um baú, o
 * mototriciclo leva uma caixa de carga) e ambos exigem carta da categoria A.
 */
'use strict';

/** Modais reconhecidos pelo sistema. */
const DeliveryModal = Object.freeze({
  MOTO:         'MOTO',
  MOTOTRICICLO: 'MOTOTRICICLO',
  CARRO:        'CARRO',
  VAN:          'VAN',
  CAMINHAO:     'CAMINHAO',
});

/**
 * Ficha técnica por modal.
 *
 * Os limites são conservadores de propósito: são o que a operação aceita
 * despachar, não o máximo que o veículo aguentaria em teoria. Uma moto de
 * entrega com baú leva 25 kg com segurança; um triciclo de carga leva o que
 * cabe na caixa, tipicamente até 350 kg.
 */
const MODAL_CATALOG = Object.freeze({
  [DeliveryModal.MOTO]: Object.freeze({
    code:               DeliveryModal.MOTO,
    label:              'Motociclo',
    operator_label:     'Motociclista',
    capacity_kg:        25,
    volume_l:           65,
    max_dimension_cm:   60,
    licence_categories: Object.freeze(['A']),
    default_fuel:       'petrol',
    wheels:             2,
    weather_exposed:    true,
    price_multiplier:   0.7,
    sort_order:         1,
  }),
  [DeliveryModal.MOTOTRICICLO]: Object.freeze({
    code:               DeliveryModal.MOTOTRICICLO,
    label:              'Mototriciclo',
    operator_label:     'Mototriciclista',
    capacity_kg:        350,
    volume_l:           900,
    max_dimension_cm:   140,
    licence_categories: Object.freeze(['A', 'B']),
    default_fuel:       'petrol',
    wheels:             3,
    weather_exposed:    true,
    price_multiplier:   0.85,
    sort_order:         2,
  }),
  [DeliveryModal.CARRO]: Object.freeze({
    code:               DeliveryModal.CARRO,
    label:              'Carro',
    operator_label:     'Motorista',
    capacity_kg:        400,
    volume_l:           500,
    max_dimension_cm:   150,
    licence_categories: Object.freeze(['B']),
    default_fuel:       'petrol',
    wheels:             4,
    weather_exposed:    false,
    price_multiplier:   1,
    sort_order:         3,
  }),
  [DeliveryModal.VAN]: Object.freeze({
    code:               DeliveryModal.VAN,
    label:              'Van',
    operator_label:     'Motorista',
    capacity_kg:        1500,
    volume_l:           6000,
    max_dimension_cm:   250,
    licence_categories: Object.freeze(['B', 'C']),
    default_fuel:       'diesel',
    wheels:             4,
    weather_exposed:    false,
    price_multiplier:   1.3,
    sort_order:         4,
  }),
  [DeliveryModal.CAMINHAO]: Object.freeze({
    code:               DeliveryModal.CAMINHAO,
    label:              'Camião',
    operator_label:     'Motorista',
    capacity_kg:        8000,
    volume_l:           30000,
    max_dimension_cm:   600,
    licence_categories: Object.freeze(['C']),
    default_fuel:       'diesel',
    wheels:             6,
    weather_exposed:    false,
    price_multiplier:   1.8,
    sort_order:         5,
  }),
});

/**
 * Sinónimos aceites na entrada.
 *
 * A operação escreve o que diz: "mota", "motorizada", "triciclo", "txopela".
 * Recusar essas palavras não torna o cadastro mais correto — torna-o mais
 * lento e empurra a pessoa para escolher o modal errado só para avançar.
 * A normalização acontece à entrada; o que fica gravado é sempre o código.
 */
const MODAL_SYNONYMS = Object.freeze({
  MOTA:           DeliveryModal.MOTO,
  MOTOCICLO:      DeliveryModal.MOTO,
  MOTOCICLETA:    DeliveryModal.MOTO,
  MOTORIZADA:     DeliveryModal.MOTO,
  MOTOCICLISTA:   DeliveryModal.MOTO,
  MOTORCYCLE:     DeliveryModal.MOTO,
  MOTO_TRICICLO:  DeliveryModal.MOTOTRICICLO,
  MOTOTRICICLO:   DeliveryModal.MOTOTRICICLO,
  MOTOTRICICLETA: DeliveryModal.MOTOTRICICLO,
  MOTOTRICICLISTA: DeliveryModal.MOTOTRICICLO,
  TRICICLO:       DeliveryModal.MOTOTRICICLO,
  TRICICLO_CARGA: DeliveryModal.MOTOTRICICLO,
  TUKTUK:         DeliveryModal.MOTOTRICICLO,
  TXOPELA:        DeliveryModal.MOTOTRICICLO,
  CHOPELA:        DeliveryModal.MOTOTRICICLO,
  CARRINHA:       DeliveryModal.VAN,
  CAMIAO:         DeliveryModal.CAMINHAO,
  CAMINHAO:       DeliveryModal.CAMINHAO,
});

/** Códigos por ordem de capacidade crescente — base da sugestão de modal. */
const MODALS_BY_CAPACITY = Object.freeze(
  Object.values(MODAL_CATALOG)
    .slice()
    .sort((a, b) => a.capacity_kg - b.capacity_kg)
    .map((m) => m.code),
);

class UnknownDeliveryModalError extends Error {
  /** @param {unknown} value */
  constructor(value) {
    super(`Tipo de veículo inválido: "${String(value)}". Use ${Object.keys(MODAL_CATALOG).join(', ')}.`);
    this.name       = 'UnknownDeliveryModalError';
    this.statusCode = 400;
  }
}

class ModalCapacityError extends Error {
  /**
   * @param {string} message
   * @param {{ modal?: string, suggested_modal?: string|null }} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name            = 'ModalCapacityError';
    this.statusCode      = 422;
    this.modal           = detail.modal;
    this.suggested_modal = detail.suggested_modal ?? null;
  }
}

// ─── Leitura do catálogo ─────────────────────────────────────────────────────

/** @returns {object[]} Fichas dos modais, na ordem de apresentação. */
function listModals() {
  return Object.values(MODAL_CATALOG).sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Converte um valor de entrada no código canónico do modal.
 *
 * Tolera minúsculas, espaços, hífens e acentos ("mototriciclo", "moto-triciclo",
 * "Mototriciclo "). Devolve `null` quando não reconhece — quem chama decide se
 * isso é um erro (cadastro de motorista) ou texto livre a preservar (frota).
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeModalCode(value) {
  if (typeof value !== 'string') return null;

  const key = value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acentos no vocabulario de entrada
    .trim().toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (!key) return null;
  if (MODAL_CATALOG[key]) return key;
  return MODAL_SYNONYMS[key] ?? null;
}

/**
 * @param {unknown} value
 * @returns {object|null} Ficha do modal, ou `null` se não for reconhecido.
 */
function getModal(value) {
  const code = normalizeModalCode(value);
  return code ? MODAL_CATALOG[code] : null;
}

/**
 * Como `getModal`, mas exige um modal válido.
 * @param {unknown} value
 * @returns {object}
 * @throws {UnknownDeliveryModalError}
 */
function requireModal(value) {
  const modal = getModal(value);
  if (!modal) throw new UnknownDeliveryModalError(value);
  return modal;
}

/** Entregas de duas/três rodas — as que o § 3.33 trata à parte. */
function isTwoOrThreeWheeler(value) {
  const modal = getModal(value);
  return Boolean(modal) && modal.wheels <= 3;
}

// ─── Capacidade ──────────────────────────────────────────────────────────────

/**
 * Capacidade efetiva de um veículo, em gramas.
 *
 * O motorista pode declarar menos do que o teto do modal (um baú pequeno numa
 * moto), nunca mais: o teto é um limite de segurança da operação, não um valor
 * por default a contornar escrevendo 500 kg no cadastro de uma moto.
 *
 * @param {unknown} modalValue
 * @param {number|null|undefined} [declaredKg]
 * @returns {number} gramas
 */
function capacityGramsFor(modalValue, declaredKg) {
  const modal    = requireModal(modalValue);
  const ceiling  = modal.capacity_kg * 1000;
  const declared = Number(declaredKg);

  if (!Number.isFinite(declared) || declared <= 0) return ceiling;
  return Math.min(Math.round(declared * 1000), ceiling);
}

/**
 * Capacidade efetiva em kg — a forma que o cadastro grava e os ecrãs mostram.
 * @param {unknown} modalValue
 * @param {number|null|undefined} [declaredKg]
 * @returns {number} kg
 */
function capacityKgFor(modalValue, declaredKg) {
  return capacityGramsFor(modalValue, declaredKg) / 1000;
}

/**
 * Confronta a carga com os limites de um modal, SEM sugerir alternativa.
 *
 * Existe separada de `fitsModal` por uma razão concreta: a sugestão é uma
 * varredura do catálogo, e o catálogo é varrido correndo esta verificação em
 * cada modal. Se a verificação sugerisse, sugerir chamaria verificar, que
 * sugeriria outra vez — recursão infinita. Aqui só se responde "cabe ou não".
 *
 * @param {{ weight_grams?: number, volume_l?: number, longest_side_cm?: number }} load
 * @param {object} modal Ficha do catálogo (já resolvida).
 * @param {number} capacityGrams Capacidade efetiva do veículo concreto.
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkModalLimits(load, modal, capacityGrams) {
  // Só se verifica o que é conhecido: um pedido sem peso registado não é
  // recusado — o sistema não inventa um peso para depois bloquear a operação
  // com ele. As dimensões seguem a mesma regra.
  const weight = Number(load.weight_grams);
  if (Number.isFinite(weight) && weight > 0 && weight > capacityGrams) {
    return {
      ok:     false,
      reason: `${modal.label} transporta até ${capacityGrams / 1000} kg; a carga é de ${(weight / 1000).toFixed(1)} kg.`,
    };
  }

  const volume = Number(load.volume_l);
  if (Number.isFinite(volume) && volume > 0 && volume > modal.volume_l) {
    return {
      ok:     false,
      reason: `${modal.label} comporta até ${modal.volume_l} L; o volume é de ${volume} L.`,
    };
  }

  const side = Number(load.longest_side_cm);
  if (Number.isFinite(side) && side > 0 && side > modal.max_dimension_cm) {
    return {
      ok:     false,
      reason: `${modal.label} aceita volumes até ${modal.max_dimension_cm} cm de lado; este tem ${side} cm.`,
    };
  }

  return { ok: true };
}

/**
 * Menor modal (logo, o mais barato) que aguenta a carga.
 *
 * Usa o teto de catálogo de cada modal, não a capacidade de um veículo
 * concreto: a pergunta é "que tipo de veículo é preciso", e não "que veículo
 * está livre" — essa é do despacho.
 *
 * @param {{ weight_grams?: number, volume_l?: number, longest_side_cm?: number }} load
 * @returns {string|null} código, ou `null` se nem o maior modal serve
 */
function smallestModalFor(load = {}) {
  return MODALS_BY_CAPACITY.find(
    (code) => checkModalLimits(load, MODAL_CATALOG[code], MODAL_CATALOG[code].capacity_kg * 1000).ok,
  ) ?? null;
}

/**
 * Verifica se uma carga cabe num modal, sugerindo alternativa quando não cabe.
 *
 * @param {{ weight_grams?: number, volume_l?: number, longest_side_cm?: number }} load
 * @param {unknown} modalValue
 * @param {number|null|undefined} [declaredCapacityKg] Capacidade do veículo concreto.
 * @returns {{ ok: boolean, reason?: string, suggested_modal?: string|null }}
 */
function fitsModal(load = {}, modalValue, declaredCapacityKg) {
  const modal  = requireModal(modalValue);
  const result = checkModalLimits(load, modal, capacityGramsFor(modal.code, declaredCapacityKg));

  if (result.ok) return result;
  return { ...result, suggested_modal: smallestModalFor(load) };
}

/**
 * Como `fitsModal`, mas lança — para os casos de uso que recusam a operação.
 * @throws {ModalCapacityError}
 */
function assertFitsModal(load, modalValue, declaredCapacityKg) {
  const fit = fitsModal(load, modalValue, declaredCapacityKg);
  if (fit.ok) return;

  const code = normalizeModalCode(modalValue);
  // Sugerir o mesmo modal não ajuda ninguém: acontece quando o modal serve e o
  // que falta é capacidade neste veículo (um baú pequeno). Aí a mensagem fica
  // só com o motivo, e quem despacha procura outra moto.
  const suggestion = fit.suggested_modal && fit.suggested_modal !== code
    ? ` Sugestão: ${MODAL_CATALOG[fit.suggested_modal].label}.`
    : '';

  throw new ModalCapacityError(`${fit.reason}${suggestion}`, {
    modal:           code,
    suggested_modal: fit.suggested_modal,
  });
}

// ─── Carta de condução ───────────────────────────────────────────────────────

/**
 * Valida a categoria de carta declarada contra o modal.
 *
 * Sem categoria declarada devolve a categoria principal do modal — o cadastro
 * não fica bloqueado por um dado que a operação nem sempre tem à mão no
 * momento, mas o que fica gravado é sempre uma categoria coerente.
 *
 * @param {unknown} modalValue
 * @param {unknown} declared
 * @returns {string} categoria a gravar
 * @throws {UnknownDeliveryModalError|ModalCapacityError}
 */
function resolveLicenceCategory(modalValue, declared) {
  const modal = requireModal(modalValue);
  if (declared == null || String(declared).trim() === '') return modal.licence_categories[0];

  const category = String(declared).trim().toUpperCase();
  if (!modal.licence_categories.includes(category)) {
    throw new ModalCapacityError(
      `Carta de categoria ${category} não habilita a conduzir ${modal.label.toLowerCase()}. ` +
      `Categorias aceites: ${modal.licence_categories.join(', ')}.`,
      { modal: modal.code },
    );
  }
  return category;
}

module.exports = {
  DeliveryModal,
  MODAL_CATALOG,
  MODAL_CODES: Object.freeze(Object.keys(MODAL_CATALOG)),
  MODALS_BY_CAPACITY,
  listModals,
  normalizeModalCode,
  getModal,
  requireModal,
  isTwoOrThreeWheeler,
  capacityGramsFor,
  capacityKgFor,
  smallestModalFor,
  fitsModal,
  assertFitsModal,
  resolveLicenceCategory,
  UnknownDeliveryModalError,
  ModalCapacityError,
};
