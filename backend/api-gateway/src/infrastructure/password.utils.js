/**
 * @file password.utils.js
 * @description Hashing de senhas com `crypto` nativo (scrypt) — sem dependências
 * binárias externas (ex.: bcrypt), coerente com jwt.utils.js.
 *
 * Formato armazenado: `${saltHex}:${derivedKeyHex}`.
 * scrypt é uma KDF resistente a hardware; usamos N=16384 (padrão do Node).
 */
'use strict';

const crypto = require('crypto');

const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Gera o hash de uma senha em claro.
 * @param {string} plain
 * @returns {string} `salt:hash` (hex)
 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const derived = crypto.scryptSync(plain, salt, KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verifica uma senha em claro contra o valor armazenado, em tempo constante.
 * @param {string} plain
 * @param {string} stored `salt:hash`
 * @returns {boolean}
 */
function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;

  const derived = crypto.scryptSync(plain, salt, KEYLEN);
  const expected = Buffer.from(hashHex, 'hex');

  // Comprimentos diferentes → timingSafeEqual lançaria; falha cedo mas sem revelar timing útil.
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Avalia a força de uma senha. PURA.
 *
 * Existe uma só implementação com limiares configuráveis porque o sistema tem
 * exigências diferentes conforme o contexto: o registo aceita 6 caracteres por
 * retrocompatibilidade, a redefinição exige 8, e a conta do portal do
 * colaborador exige 10 com maiúscula e minúscula (spec § 3.22).
 *
 * @param {string} password
 * @param {{ min?: number, requireMixedCase?: boolean, requireDigit?: boolean }} [policy]
 * @returns {{ ok: boolean, reason?: string }}
 */
function passwordStrength(password, policy = {}) {
  const min = policy.min ?? 8;
  const requireDigit = policy.requireDigit !== false;

  if (typeof password !== 'string' || password.length < min) {
    return { ok: false, reason: `A senha deve ter pelo menos ${min} caracteres.` };
  }
  if (requireDigit && !/[0-9]/.test(password)) {
    return { ok: false, reason: 'A senha deve incluir pelo menos um número.' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { ok: false, reason: 'A senha deve incluir pelo menos uma letra.' };
  }
  if (policy.requireMixedCase && !(/[a-z]/.test(password) && /[A-Z]/.test(password))) {
    return { ok: false, reason: 'A senha deve incluir maiúsculas e minúsculas.' };
  }
  return { ok: true };
}

module.exports = { hashPassword, verifyPassword, passwordStrength };
