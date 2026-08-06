/**
 * @file preferences.js
 * @description Resolução de preferências de notificação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *   "Preferências de notificação por usuário (ligar/desligar por categoria)."
 *
 * Este é o coração da decisão de enviar ou não. É lógica pura, sem I/O, para
 * ser exercitada exaustivamente pelos testes — é aqui que um erro se traduz em
 * clientes a não receber avisos que pediram, ou a receber os que recusaram.
 *
 * ORDEM DE DECISÃO (a primeira que responde ganha):
 *   1. Categoria desconhecida            → não envia (erro de programação)
 *   2. Categoria não se aplica ao perfil → não envia (segmentação)
 *   3. Categoria crítica                 → ENVIA, mesmo desligada
 *   4. Preferência explícita do utilizador
 *   5. Default da categoria (opt-out: por omissão está ligada)
 */
'use strict';

const {
  CATEGORY_META,
  isKnownCategory,
  categoryAppliesToRole,
  isCriticalCategory,
} = require('./notification.entity');

/**
 * Motivos possíveis de uma decisão. Expostos na resposta da API para que o
 * chamador saiba por que não enviámos, em vez de ver um silêncio inexplicado.
 */
const DecisionReason = Object.freeze({
  ALLOWED_BY_DEFAULT:     'permitida por omissão',
  ALLOWED_BY_PREFERENCE:  'permitida pela preferência do utilizador',
  ALLOWED_CRITICAL:       'categoria crítica — não pode ser desligada',
  BLOCKED_BY_PREFERENCE:  'desligada pelo utilizador',
  BLOCKED_WRONG_ROLE:     'categoria não se aplica a este perfil',
  BLOCKED_UNKNOWN:        'categoria desconhecida',
});

/**
 * Preferências por omissão: tudo ligado (opt-out).
 * O utilizador escolhe o que desligar; não tem de descobrir o que ligar.
 *
 * @returns {Record<string, boolean>}
 */
function defaultPreferences() {
  const prefs = {};
  for (const categoria of Object.keys(CATEGORY_META)) {
    prefs[categoria] = true;
  }
  return prefs;
}

/**
 * Normaliza preferências vindas do exterior.
 * Chaves desconhecidas são descartadas; valores não-booleanos são ignorados.
 * Tolerar lixo aqui evita que uma preferência mal gravada bloqueie envios.
 *
 * @param {object} raw
 * @returns {Record<string, boolean>}
 */
function normalizePreferences(raw) {
  const prefs = defaultPreferences();
  if (!raw || typeof raw !== 'object') return prefs;

  for (const [chave, valor] of Object.entries(raw)) {
    if (!isKnownCategory(chave)) continue;
    if (typeof valor !== 'boolean') continue;
    prefs[chave] = valor;
  }

  return prefs;
}

/**
 * @typedef {object} Decision
 * @property {boolean} allowed
 * @property {string} reason
 */

/**
 * Decide se uma notificação deve ser enviada.
 *
 * @param {{ category: string, role: string }} notification
 * @param {object} [userPreferences] Preferências cruas do utilizador
 * @returns {Decision}
 */
function shouldSend(notification, userPreferences) {
  const { category, role } = notification;

  // 1. Categoria desconhecida — falhar fechado.
  if (!isKnownCategory(category)) {
    return { allowed: false, reason: DecisionReason.BLOCKED_UNKNOWN };
  }

  // 2. Segmentação por perfil (spec § 3.3).
  if (!categoryAppliesToRole(category, role)) {
    return { allowed: false, reason: DecisionReason.BLOCKED_WRONG_ROLE };
  }

  // 3. Categorias críticas ignoram a preferência — ver CATEGORY_META.
  if (isCriticalCategory(category)) {
    return { allowed: true, reason: DecisionReason.ALLOWED_CRITICAL };
  }

  const prefs = normalizePreferences(userPreferences);
  const temPreferenciaExplicita =
    userPreferences &&
    typeof userPreferences === 'object' &&
    typeof userPreferences[category] === 'boolean';

  // 4. Preferência explícita.
  if (temPreferenciaExplicita) {
    return prefs[category]
      ? { allowed: true,  reason: DecisionReason.ALLOWED_BY_PREFERENCE }
      : { allowed: false, reason: DecisionReason.BLOCKED_BY_PREFERENCE };
  }

  // 5. Default da categoria.
  return { allowed: true, reason: DecisionReason.ALLOWED_BY_DEFAULT };
}

/**
 * Categorias que fazem sentido mostrar a um perfil, com o estado atual.
 * Alimenta o ecrã de preferências dos apps.
 *
 * @param {string} role
 * @param {object} [userPreferences]
 * @returns {{ category: string, label: string, enabled: boolean, locked: boolean }[]}
 */
function listPreferencesForRole(role, userPreferences) {
  const prefs = normalizePreferences(userPreferences);

  return Object.entries(CATEGORY_META)
    .filter(([, meta]) => meta.roles.includes(role))
    .map(([category, meta]) => ({
      category,
      label:   meta.label,
      // Uma categoria crítica aparece sempre ligada, e bloqueada.
      enabled: meta.critical ? true : prefs[category],
      locked:  meta.critical,
    }));
}

module.exports = {
  DecisionReason,
  defaultPreferences,
  normalizePreferences,
  shouldSend,
  listPreferencesForRole,
};
