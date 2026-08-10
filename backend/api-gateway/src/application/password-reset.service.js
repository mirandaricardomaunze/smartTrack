/**
 * @file password-reset.service.js
 * @description Recuperação de senha por email — pedido, link e redefinição.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * Regras de segurança que estruturam este módulo:
 *
 *   1. **Não revelar quem existe.** O pedido responde sempre da mesma maneira,
 *      exista ou não a conta. Um formulário que diz "esse email não existe" é um
 *      verificador de contas de graça para quem quiser atacar.
 *   2. **O token nunca é gravado.** Guarda-se o SHA-256; o valor em claro só
 *      existe no email. Quem lê a base não consegue redefinir senhas.
 *   3. **Uso único e com prazo.** Consumo e troca de senha na mesma transação;
 *      um pedido novo invalida os anteriores.
 *   4. **Empresa suspensa não recupera.** Seria uma porta lateral para uma conta
 *      cujo acesso está deliberadamente cortado (§ 2.4).
 */
'use strict';

const crypto = require('crypto');
const {
  UserRepository, PasswordResetRepository, CompanyRepository, CompanyProfileRepository,
} = require('../infrastructure/pg.repository');
const { hashPassword, passwordStrength } = require('../infrastructure/password.utils');
const { getEmailClient, isSimulated } = require('../../../notifications-service/src/infrastructure/email.client');
const audit = require('./audit.service');

class PasswordResetError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'PasswordResetError';
    this.statusCode = statusCode;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validade do link. Curta de propósito: é um poder de tomada de conta. */
const TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 60;
/** Teto de pedidos por conta e por hora — trava o abuso do formulário. */
const MAX_REQUESTS_PER_HOUR = Number(process.env.PASSWORD_RESET_MAX_PER_HOUR) || 5;
/** Base do link no email; tem de apontar para o painel, não para a API. */
const ADMIN_URL = process.env.ADMIN_PUBLIC_URL || process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3010';

/** Resposta única do pedido — igual para conta existente ou inexistente. */
const NEUTRAL_RESPONSE = Object.freeze({
  ok: true,
  message: 'Se existir uma conta com esse e-mail, enviámos as instruções para redefinir a senha.',
});

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/** Token em claro (vai no email) + hash (vai para a base). PURA. */
function generateToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, token_hash: hashToken(token) };
}

/** SHA-256 do token. PURA — usada na criação e na verificação. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/**
 * O token está utilizável? PURA.
 * @param {{expires_at:string, used_at?:string, invalidated_at?:string}} record
 * @param {Date} [now]
 * @returns {{ valid: boolean, reason?: string }}
 */
function evaluateToken(record, now = new Date()) {
  if (!record) return { valid: false, reason: 'Link inválido.' };
  if (record.used_at) return { valid: false, reason: 'Este link já foi utilizado.' };
  if (record.invalidated_at) return { valid: false, reason: 'Este link foi substituído por um pedido mais recente.' };
  if (Date.parse(record.expires_at) <= now.getTime()) return { valid: false, reason: 'Este link expirou.' };
  return { valid: true };
}

/** Corpo do email. PURA — separado para poder ser testado sem enviar nada. */
function buildEmail({ name, link, companyName, ttlMinutes = TTL_MINUTES }) {
  const who = companyName ? `${companyName} — SmartTrack` : 'SmartTrack';
  return {
    subject: `${who}: redefinição de senha`,
    body: [
      `Olá ${name || ''},`.trim(),
      '',
      'Recebemos um pedido para redefinir a senha da sua conta.',
      `Abra o link abaixo para escolher uma senha nova. É válido durante ${ttlMinutes} minutos e só pode ser usado uma vez.`,
      '',
      link,
      '',
      'Se não foi você que pediu, ignore este email: a senha atual continua a funcionar.',
      '',
      who,
    ].join('\n'),
  };
}

// ─── Casos de uso ────────────────────────────────────────────────────────────

/**
 * A recuperação por email está disponível nesta instalação?
 *
 * Consultado pela página de login para não mostrar "Esqueci a senha" quando o
 * canal não existe. Não expõe nada sobre nenhuma conta nem o provedor — só se o
 * caminho está aberto, e por onde ir se não estiver.
 *
 * @returns {{ available: boolean, channel: 'email', fallback: string }}
 */
function recoveryAvailability() {
  return {
    available: !isSimulated(),
    channel: 'email',
    fallback: 'Peça ao administrador da sua empresa para reemitir a senha.',
  };
}

/**
 * Pede a redefinição. Responde SEMPRE a mesma coisa (ver regra 1); o que varia
 * é o que acontece nos bastidores.
 *
 * @param {{ email?: string }} dto
 * @param {{ ip?: string }} [context]
 */
async function requestReset(dto = {}, context = {}) {
  const email = String(dto.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new PasswordResetError('E-mail inválido.');

  // Sem provedor de email o link não sai da máquina. Em produção, responder
  // "enviámos as instruções" seria mentira e deixava a pessoa à espera de um
  // email que ninguém vai enviar; o caminho real é o administrador reemitir a
  // senha (§ 3.32). Em desenvolvimento o simulador É o meio de teste — devolve
  // `debug_link` mais abaixo — por isso segue. Não revela nada sobre a conta:
  // esta condição é do sistema, não de quem pede.
  if (!recoveryAvailability().available && process.env.NODE_ENV === 'production') {
    throw new PasswordResetError(
      'A recuperação por e-mail não está disponível. Peça ao administrador da sua empresa para reemitir a senha.',
      503,
    );
  }

  await UserRepository.ensureTable();
  const user = await UserRepository.findByEmailWithHash(email);

  // Conta inexistente: sai daqui com a mesma resposta, sem enviar nada.
  if (!user) return { ...NEUTRAL_RESPONSE, delivered: false };

  // Conta suspensa (§ 3.32): recuperar a senha não contorna um acesso cortado.
  if (user.status === 'blocked') return { ...NEUTRAL_RESPONSE, delivered: false };

  // Empresa suspensa: recuperar senha não pode contornar o corte de acesso.
  if (user.company_id) {
    const company = await CompanyRepository.findById(user.company_id);
    if (company && company.status === 'suspended') return { ...NEUTRAL_RESPONSE, delivered: false };
  }

  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  if (await PasswordResetRepository.countRecent(user.id, oneHourAgo) >= MAX_REQUESTS_PER_HOUR) {
    // Também aqui a resposta é neutra: o atacante não fica a saber que acertou.
    return { ...NEUTRAL_RESPONSE, delivered: false, throttled: true };
  }

  const { token, token_hash: tokenHash } = generateToken();
  await PasswordResetRepository.create({
    id: crypto.randomUUID(),
    user_id: user.id,
    company_id: user.company_id ?? null,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
    requested_ip: context.ip,
  });

  const link = `${ADMIN_URL.replace(/\/$/, '')}/redefinir-senha?token=${token}`;
  let companyName;
  if (user.company_id) {
    const profile = await CompanyProfileRepository.findByCompany(user.company_id).catch(() => undefined);
    companyName = profile?.legal_name;
  }

  const message = buildEmail({ name: user.name, link, companyName });
  const result = await getEmailClient().send({ to: email, ...message });

  await audit.record({
    action: 'auth.password_reset_requested',
    company_id: user.company_id ?? undefined,
    summary: `Pedido de redefinição de senha para ${email}`,
    entity_type: 'user', entity_id: user.id, entity_label: email,
    outcome: result.ok ? audit.Outcome.SUCCESS : audit.Outcome.ERROR,
    metadata: { provider: result.provider, simulated: isSimulated(), delivery: result.status },
    request: { ip: context.ip, request_id: context.request_id },
  });

  if (!result.ok) console.error('[password-reset] Falha no envio do email:', result.message);

  return {
    ...NEUTRAL_RESPONSE,
    delivered: result.ok,
    // Em modo simulado o link vem na resposta para dar para testar sem provedor
    // de email — nunca em produção, onde isso seria entregar a conta a quem pede.
    ...(isSimulated() && process.env.NODE_ENV !== 'production' ? { debug_link: link } : {}),
  };
}

/**
 * Confirma que um link ainda serve — para a página não pedir a senha nova antes
 * de saber que o token presta.
 * @param {string} token
 */
async function checkToken(token) {
  const record = await PasswordResetRepository.findByHash(hashToken(token));
  const evaluation = evaluateToken(record);
  return { valid: evaluation.valid, reason: evaluation.reason, expires_at: record?.expires_at };
}

/**
 * Redefine a senha. O token é consumido e a senha trocada na mesma transação.
 *
 * @param {{ token?: string, password?: string }} dto
 * @param {{ ip?: string, request_id?: string }} [context]
 */
async function resetPassword(dto = {}, context = {}) {
  const token = String(dto.token ?? '').trim();
  if (!token) throw new PasswordResetError('Link inválido.');

  const record = await PasswordResetRepository.findByHash(hashToken(token));
  const evaluation = evaluateToken(record);
  if (!evaluation.valid) throw new PasswordResetError(evaluation.reason, 400);

  const strength = passwordStrength(dto.password, { min: 8 });
  if (!strength.ok) throw new PasswordResetError(strength.reason);

  const consumed = await PasswordResetRepository.consume(record.id, record.user_id, hashPassword(dto.password));
  if (!consumed) throw new PasswordResetError('Este link já não é válido. Peça um novo.', 409);

  await audit.record({
    action: 'auth.password_reset_completed',
    company_id: record.company_id ?? undefined,
    summary: 'Senha redefinida através do link enviado por email',
    entity_type: 'user', entity_id: record.user_id,
    metadata: { token_id: record.id },
    request: { ip: context.ip, request_id: context.request_id },
  });

  return { ok: true, message: 'Senha redefinida. Já pode iniciar sessão.' };
}

/** Manutenção: remove tokens expirados há mais de uma semana. */
async function pruneExpired() {
  return PasswordResetRepository.pruneExpired();
}

module.exports = {
  // Puros
  generateToken,
  hashToken,
  evaluateToken,
  buildEmail,
  // Casos de uso
  recoveryAvailability,
  requestReset,
  checkToken,
  resetPassword,
  pruneExpired,
  // Constantes e erros
  TTL_MINUTES,
  MAX_REQUESTS_PER_HOUR,
  NEUTRAL_RESPONSE,
  PasswordResetError,
};
