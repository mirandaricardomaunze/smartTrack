/**
 * @file companies.service.js
 * @description Camada de aplicação — empresas (multi-tenant) e auto-registo SaaS.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4 (Multiempresa)
 *
 * O auto-registo cria a empresa + o seu primeiro utilizador ADMIN e devolve um
 * token já com a empresa. A gestão (listar/suspender) é da plataforma (SUPERADMIN).
 */
'use strict';

const crypto = require('crypto');
const { CompanyRepository, CompanyProfileRepository, UserRepository } = require('../infrastructure/pg.repository');
const { hashPassword } = require('../infrastructure/password.utils');
const { issueToken, ValidationError, EmailInUseError } = require('./auth.service');
const { startTrial } = require('./subscriptions.service');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CompanyStatus = Object.freeze({ ACTIVE: 'active', SUSPENDED: 'suspended' });

class CompanyNotFoundError extends Error {
  constructor(id) { super(`Empresa não encontrada: ${id}`); this.name = 'CompanyNotFoundError'; this.statusCode = 404; }
}

/** Converte um nome em slug (a-z0-9-), garantindo unicidade por sufixo. */
async function uniqueSlug(name) {
  const base = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'empresa';
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await CompanyRepository.findBySlug(slug)) { slug = `${base}-${n++}`; }
  return slug;
}

/**
 * Auto-registo SaaS: cria a empresa + o primeiro ADMIN e devolve um token.
 * @param {{ company_name: string; admin_name?: string; admin_email: string; password: string }} dto
 */
async function registerCompany(dto = {}) {
  const companyName = String(dto.company_name || '').trim();
  const email = String(dto.admin_email || '').trim().toLowerCase();
  const password = dto.password;

  if (!companyName) throw new ValidationError('O nome da empresa é obrigatório.');
  if (!EMAIL_RE.test(email)) throw new ValidationError('E-mail do administrador inválido.');
  if (typeof password !== 'string' || password.length < 6) throw new ValidationError('A senha deve ter pelo menos 6 caracteres.');

  await UserRepository.ensureTable();
  if (await UserRepository.findByEmailWithHash(email)) throw new EmailInUseError();

  const company = await CompanyRepository.create({
    id: `company-${crypto.randomUUID()}`,
    name: companyName,
    slug: await uniqueSlug(companyName),
    status: CompanyStatus.ACTIVE,
  });

  const admin = await UserRepository.create({
    id: crypto.randomUUID(),
    name: String(dto.admin_name || '').trim() || email.split('@')[0],
    email,
    password_hash: hashPassword(password),
    role: 'ADMIN',
    company_id: company.id,
  });

  // Perfil mínimo (spec § 3.20): garante que o primeiro documento emitido já sai
  // com o nome da empresa no cabeçalho, e não com o emissor genérico.
  await CompanyProfileRepository.upsert(company.id, {}, company.name);

  // Subscrição inicial (SaaS, spec § 2.5): período de avaliação do plano por
  // omissão. Best-effort — uma falha na faturação nunca impede o registo; sem
  // subscrição a empresa fica sem limites até o SUPERADMIN atribuir um plano.
  let subscription;
  try {
    subscription = await startTrial(company.id);
  } catch (err) {
    console.error('[companies.service] Falha ao abrir a subscrição inicial:', err.message);
  }

  const { token, user } = issueToken({ sub: admin.id, email: admin.email, role: admin.role, company_id: company.id });
  return { company, subscription, token, user };
}

// ─── Gestão (SUPERADMIN) ──────────────────────────────────────────────────────

async function listCompanies() {
  return CompanyRepository.getStats();
}

async function getCompany(id) {
  const company = await CompanyRepository.findById(id);
  if (!company) throw new CompanyNotFoundError(id);
  return company;
}

// ─── Perfil / marca da empresa (spec § 3.20) ─────────────────────────────────
// É o cabeçalho de todos os documentos PDF e o emissor das faturas fiscais.

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Data URL de imagem, com teto de tamanho — o logótipo viaja em cada documento. */
const LOGO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX_CHARS = Number(process.env.COMPANY_LOGO_MAX_CHARS) || 400_000; // ~300 KB

function trimOrNull(value, max = 200) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** Perfil da empresa; cria um mínimo a partir do nome se ainda não existir. */
async function getProfile(companyId) {
  const existing = await CompanyProfileRepository.findByCompany(companyId);
  if (existing) return existing;

  const company = await CompanyRepository.findById(companyId);
  if (!company) throw new CompanyNotFoundError(companyId);
  return CompanyProfileRepository.upsert(companyId, {}, company.name);
}

/**
 * Atualiza o perfil. Valida o que sai impresso num documento fiscal: NUIT com 9
 * dígitos, cor em hexadecimal e logótipo dentro do teto de tamanho.
 *
 * @param {string} companyId
 * @param {object} dto
 */
async function updateProfile(companyId, dto = {}) {
  const company = await CompanyRepository.findById(companyId);
  if (!company) throw new CompanyNotFoundError(companyId);

  const patch = {
    legal_name:   trimOrNull(dto.legal_name, 160),
    trade_name:   trimOrNull(dto.trade_name, 160),
    tax_id:       dto.tax_id === undefined ? undefined : String(dto.tax_id ?? '').replace(/\D/g, '') || null,
    address:      trimOrNull(dto.address, 300),
    city:         trimOrNull(dto.city, 120),
    country:      trimOrNull(dto.country, 120),
    phone:        trimOrNull(dto.phone, 60),
    email:        trimOrNull(dto.email, 160),
    website:      trimOrNull(dto.website, 160),
    brand_color:  trimOrNull(dto.brand_color, 7),
    bank_details: trimOrNull(dto.bank_details, 500),
    footer_note:  trimOrNull(dto.footer_note, 500),
  };

  if (patch.legal_name === null) throw new ValidationError('A designação social é obrigatória.');
  if (patch.tax_id && !/^\d{9}$/.test(patch.tax_id)) {
    throw new ValidationError('NUIT inválido — deve ter 9 dígitos.');
  }
  if (patch.brand_color && !HEX_COLOR_RE.test(patch.brand_color)) {
    throw new ValidationError('Cor da marca inválida — use o formato #RRGGBB.');
  }
  if (patch.email && !EMAIL_RE.test(patch.email)) {
    throw new ValidationError('E-mail da empresa inválido.');
  }

  if (dto.logo !== undefined) {
    if (dto.logo === null || dto.logo === '') {
      patch.logo = null;
    } else {
      const logo = String(dto.logo);
      if (!LOGO_RE.test(logo)) throw new ValidationError('Logótipo inválido — envie uma imagem PNG, JPEG, WEBP ou GIF.');
      if (logo.length > LOGO_MAX_CHARS) throw new ValidationError('Logótipo demasiado grande — use uma imagem mais leve (até ~300 KB).');
      patch.logo = logo;
    }
  }

  // `undefined` significa "não mexer"; o repositório ignora-os.
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];

  return CompanyProfileRepository.upsert(companyId, patch, company.name);
}

async function setStatus(id, status) {
  if (![CompanyStatus.ACTIVE, CompanyStatus.SUSPENDED].includes(status)) {
    throw new ValidationError('Estado inválido. Use "active" ou "suspended".');
  }
  const existing = await CompanyRepository.findById(id);
  if (!existing) throw new CompanyNotFoundError(id);
  return CompanyRepository.update(id, { status });
}

module.exports = {
  registerCompany,
  listCompanies,
  getCompany,
  getProfile,
  updateProfile,
  setStatus,
  CompanyStatus,
  CompanyNotFoundError,
};
