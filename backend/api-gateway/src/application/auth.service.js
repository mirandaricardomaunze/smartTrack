/**
 * @file auth.service.js
 * @description Use cases de autenticação e middlewares de segurança (JWT/RBAC).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança)
 * Harness ref: tests/harness/mocks/jwt-payloads.mock.ts
 */
'use strict';

const crypto = require('crypto');
const jwt = require('../infrastructure/jwt.utils');
const { UserRepository, CompanyRepository } = require('../infrastructure/pg.repository');
const { hashPassword, verifyPassword } = require('../infrastructure/password.utils');
const { writeCompanyId, DEFAULT_COMPANY_ID } = require('../infrastructure/tenant-context');
const { assertResourceLimit } = require('./subscriptions.service');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Segurança (spec § 4): em produção o segredo é OBRIGATÓRIO — sem fallback. Um
// segredo conhecido em produção equivaleria a não ter autenticação.
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  throw new Error('[auth] JWT_SECRET é obrigatório em produção (NODE_ENV=production). Defina-o no ambiente.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_insecure_secret_change_me';
const TOKEN_TTL_SECONDS = 3600;

// Contas de demonstração (spec/harness). Backdoors — só em desenvolvimento.
// Em produção ficam desligadas, a menos que explicitamente reativadas.
const MOCK_ACCOUNTS_ENABLED = !IS_PRODUCTION && process.env.DISABLE_MOCK_ACCOUNTS !== 'true';

class InvalidCredentialsError extends Error {
  constructor() {
    super('E-mail corporativo ou senha inválidos.');
    this.name = 'InvalidCredentialsError';
    this.statusCode = 401;
  }
}

class CompanySuspendedError extends Error {
  constructor() {
    super('A empresa está suspensa. Contacte a administração da plataforma.');
    this.name = 'CompanySuspendedError';
    this.statusCode = 403;
  }
}

class ValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

class EmailInUseError extends Error {
  constructor() {
    super('Já existe uma conta com este e-mail.');
    this.name = 'EmailInUseError';
    this.statusCode = 409;
  }
}

class UnauthorizedError extends Error {
  /** @param {string} message */
  constructor(message = 'Token de acesso ausente ou inválido.') {
    super(message);
    this.name = 'UnauthorizedError';
    this.statusCode = 401;
  }
}

class ForbiddenError extends Error {
  constructor() {
    super('Acesso negado: privilégios insuficientes.');
    this.name = 'ForbiddenError';
    this.statusCode = 403;
  }
}

/**
 * Assina um token JWT real contendo o payload do usuário.
 * @param {object} payload
 * @returns {string}
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET);
}

/**
 * Valida a assinatura de um token JWT real.
 * @param {string} token
 * @returns {object}
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    throw new UnauthorizedError(err.message || 'Token de acesso inválido.');
  }
}

/**
 * Emite um token JWT assinado para um utilizador.
 * @param {{ sub: string; email: string; role: string }} u
 * @returns {{ token: string; user: { email: string; role: string } }}
 */
function issueToken(u) {
  const now = Math.floor(Date.now() / 1000);
  // Multiempresa (spec § 2.4): a empresa vai no token; SUPERADMIN tem company_id null.
  const companyId = u.company_id === undefined ? null : u.company_id;
  const payload = { sub: u.sub, email: u.email, role: u.role, company_id: companyId, iat: now, exp: now + TOKEN_TTL_SECONDS };
  return { token: signToken(payload), user: { email: u.email, role: u.role, company_id: companyId } };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Papéis que uma conta pode escolher no registo. */
const ALLOWED_ROLES = ['ADMIN', 'DRIVER'];

/** Contas mock da spec/harness — mantidas para compatibilidade (Empresa Padrão). */
const MOCK_ACCOUNTS = {
  'admin@smarttrack.co.mz':          { password: 'admin123',     sub: 'admin-test-uuid-0001',  role: 'ADMIN',      company_id: DEFAULT_COMPANY_ID },
  'motorista@smarttrack.co.mz':      { password: 'motorista123', sub: 'driver-test-uuid-0001', role: 'DRIVER',     company_id: DEFAULT_COMPANY_ID },
  'admin@sistematrack.com.br':     { password: 'admin123',     sub: 'admin-test-uuid-0001',  role: 'ADMIN',      company_id: DEFAULT_COMPANY_ID },
  'motorista@sistematrack.com.br': { password: 'motorista123', sub: 'driver-test-uuid-0001', role: 'DRIVER',     company_id: DEFAULT_COMPANY_ID },
  // SUPERADMIN da plataforma (dev): gere todas as empresas. company_id null.
  'super@smarttrack.co.mz':          { password: 'super123',     sub: 'superadmin-0001',       role: 'SUPERADMIN', company_id: null },
};

/**
 * Regista uma nova conta (persiste em `users`) e devolve um token.
 * O papel é escolhido no registo (ADMIN ou DRIVER); por omissão, ADMIN.
 *
 * @param {{ name?: string; email: string; password: string; role?: string }} dto
 * @returns {Promise<{ token: string; user: { email: string; role: string } }>}
 */
async function register({ name, email, password, role }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const normalizedRole = String(role || 'ADMIN').trim().toUpperCase();

  if (!EMAIL_RE.test(normalizedEmail)) {
    throw new ValidationError('E-mail inválido.');
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw new ValidationError('A senha deve ter pelo menos 6 caracteres.');
  }
  if (!ALLOWED_ROLES.includes(normalizedRole)) {
    throw new ValidationError('Papel inválido. Use ADMIN ou DRIVER.');
  }
  if (MOCK_ACCOUNTS_ENABLED && MOCK_ACCOUNTS[normalizedEmail]) {
    throw new EmailInUseError();
  }

  await UserRepository.ensureTable();

  const existing = await UserRepository.findByEmailWithHash(normalizedEmail);
  if (existing) throw new EmailInUseError();

  // Limite de utilizadores do plano (SaaS, spec § 2.5). Sem empresa no contexto
  // (auto-registo da empresa, testes) não impõe nada.
  await assertResourceLimit('users');

  // Multiempresa: o novo utilizador entra na empresa do contexto (quem o cria),
  // ou na Empresa Padrão quando não há contexto.
  const companyId = writeCompanyId();
  const user = await UserRepository.create({
    id:            crypto.randomUUID(),
    name:          cleanName || normalizedEmail.split('@')[0],
    email:         normalizedEmail,
    password_hash: hashPassword(password),
    role:          normalizedRole,
    company_id:    companyId,
  });

  return issueToken({ sub: user.id, email: user.email, role: user.role, company_id: user.company_id ?? companyId });
}

/**
 * Autentica um utilizador (contas mock OU tabela `users`) e gera um token.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ token: string; user: { email: string; role: string } }>}
 */
async function login(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // 1) Contas mock da spec/harness — apenas em desenvolvimento (desligadas em produção).
  const mock = MOCK_ACCOUNTS_ENABLED ? MOCK_ACCOUNTS[normalizedEmail] : undefined;
  if (mock && password === mock.password) {
    return issueToken({ sub: mock.sub, email: normalizedEmail, role: mock.role, company_id: mock.company_id });
  }

  // 2) Utilizadores registados na base de dados — a empresa vem do registo.
  await UserRepository.ensureTable();
  const row = await UserRepository.findByEmailWithHash(normalizedEmail);
  if (row && verifyPassword(password, row.password_hash)) {
    // Multiempresa (spec § 2.4): uma empresa suspensa não deixa os seus utilizadores entrar.
    if (row.company_id) {
      const company = await CompanyRepository.findById(row.company_id);
      if (company && company.status === 'suspended') throw new CompanySuspendedError();
    }
    return issueToken({ sub: row.id, email: row.email, role: row.role, company_id: row.company_id ?? null });
  }

  throw new InvalidCredentialsError();
}

/**
 * Middleware Express para autenticar JWT (decodificação do token Base64 do header).
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError());
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = verifyToken(token);
    // Verifica expiração
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return next(new UnauthorizedError('Token expirado. Acesse novamente.'));
    }
    req.user = payload;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware Express para verificação de permissões do controle de acesso baseado em roles (RBAC).
 *
 * @param {string[]} allowedRoles
 */
function requireRoles(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError());
    }
    next();
  };
}

/**
 * Autoriza o recurso do próprio utilizador ou papéis privilegiados.
 * @param {string[]} allowedRoles
 * @param {string} [paramName]
 */
function requireSelfOrRoles(allowedRoles, paramName = 'id') {
  return (req, res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (allowedRoles.includes(req.user.role) || req.params?.[paramName] === req.user.sub) {
      return next();
    }
    return next(new ForbiddenError());
  };
}

/**
 * Autoriza papéis privilegiados ou o proprietário persistido do recurso.
 * @param {string[]} allowedRoles
 * @param {(id: string) => Promise<object | null>} findResource
 * @param {string} [ownerField]
 * @param {string} [paramName]
 */
function requireResourceOwnerOrRoles(allowedRoles, findResource, ownerField = 'driver_id', paramName = 'id') {
  return async (req, res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (allowedRoles.includes(req.user.role)) return next();
    try {
      const resource = await findResource(req.params?.[paramName]);
      if (resource?.[ownerField] === req.user.sub) return next();
      return next(new ForbiddenError());
    } catch (err) {
      return next(err);
    }
  };
}

/** Garante que o sujeito declarado no body não suplanta outro utilizador. */
function requireBodySubjectOrRoles(allowedRoles, bodyField) {
  return (req, res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (allowedRoles.includes(req.user.role) || req.body?.[bodyField] === req.user.sub) return next();
    return next(new ForbiddenError());
  };
}

module.exports = {
  login,
  register,
  issueToken,
  verifyToken,
  requireAuth,
  requireRoles,
  requireSelfOrRoles,
  requireResourceOwnerOrRoles,
  requireBodySubjectOrRoles,
  InvalidCredentialsError,
  CompanySuspendedError,
  ValidationError,
  EmailInUseError,
  UnauthorizedError,
  ForbiddenError,
};
