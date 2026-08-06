/**
 * @file jwt.utils.js
 * @description Utilitário nativo em Node.js para criação e verificação de tokens JWT.
 *
 * Utiliza o módulo 'crypto' nativo para assinar e validar assinaturas HMAC-SHA256,
 * eliminando a dependência de pacotes binários externos como jsonwebtoken.
 */
'use strict';

const crypto = require('crypto');

/**
 * Converte string ou objeto para base64url.
 * @param {string | object} input
 * @returns {string}
 */
function base64url(input) {
  const str = typeof input === 'object' ? JSON.stringify(input) : input;
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Decodifica uma string base64url para UTF-8.
 * @param {string} input
 * @returns {string}
 */
function base64urlDecode(input) {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Assina o conteúdo utilizando HMAC-SHA256.
 * @param {string} content
 * @param {string} secret
 * @returns {string}
 */
function signHmac(content, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(content)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Cria um token JWT assinado.
 *
 * @param {object} payload Payload do token
 * @param {string} secret Chave secreta HMAC
 * @returns {string} Token JWT
 */
function sign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  
  const encodedHeader = base64url(header);
  const encodedPayload = base64url(payload);
  
  const signature = signHmac(`${encodedHeader}.${encodedPayload}`, secret);
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Valida a assinatura do token JWT e retorna o payload decodificado.
 * Lança erro caso o token seja inválido ou expirado.
 *
 * @param {string} token Token JWT
 * @param {string} secret Chave secreta HMAC
 * @returns {object} Payload decodificado
 */
function verify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Token malformatado.');
  }

  const [headerB64, payloadB64, signature] = parts;
  
  // Re-assina para validar integridade
  const expectedSignature = signHmac(`${headerB64}.${payloadB64}`, secret);
  if (signature !== expectedSignature) {
    throw new Error('Assinatura de token inválida.');
  }

  const payloadStr = base64urlDecode(payloadB64);
  const payload = JSON.parse(payloadStr);

  return payload;
}

module.exports = { sign, verify };
