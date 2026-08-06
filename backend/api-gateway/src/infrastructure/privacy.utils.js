/**
 * @file privacy.utils.js
 * @description Utilitário de mascaramento de PII (Personally Identifiable Information) para LGPD.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança & Privacidade)
 * Rule ref: AGENTS.md § 2.1 (Mascaramento de PII via maskPII)
 */
'use strict';

/**
 * Mascara dados sensíveis de acordo com a LGPD para evitar vazamento em logs ou APIs.
 *
 * @param {string} val Valor a ser mascarado
 * @param {'CPF' | 'EMAIL' | 'TELEFONE' | 'GPS'} type Tipo de dado pessoal
 * @returns {string} Valor mascarado
 */
function maskPII(val, type) {
  if (!val) return '';
  const text = String(val).trim();

  switch (type) {
    case 'CPF':
      // Ex: 123.456.789-01 -> ***.456.789-** ou apenas ocultando partes
      return text.replace(/^(\d{3})\.(\d{3})\.(\d{3})-(\d{2})$/, '***.$2.$3-**');
      
    case 'EMAIL':
      // Ex: joao.silva@empresa.com.br -> j*********a@empresa.com.br
      const parts = text.split('@');
      if (parts.length !== 2) return '******';
      const [local, domain] = parts;
      if (local.length <= 2) {
        return `${local[0]}*@${domain}`;
      }
      return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
      
    case 'TELEFONE':
      // Ex: +55 (11) 99999-9999 -> +55 (11) *****-9999
      // ou 11999999999 -> 11*****9999
      if (text.length <= 4) return '****';
      return text.substring(0, text.length - 8) + '*****' + text.substring(text.length - 3);

    case 'GPS':
      // Oculta casas decimais de alta precisão (preserva privacidade do motorista em logs)
      // Ex: -23.5505234, -46.6333092 -> -23.5505, -46.6333
      const gpsParts = text.split(',');
      if (gpsParts.length !== 2) return '**,**';
      const [lat, lng] = gpsParts.map(Number);
      if (isNaN(lat) || isNaN(lng)) return '**,**';
      return `${lat.toFixed(4)},${lng.toFixed(4)}`;

    default:
      return '******';
  }
}

module.exports = { maskPII };
