/**
 * @file users.service.js
 * @description Casos de uso das contas de acesso ao sistema (spec § 3.32).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 * Harness ref: tests/harness/factories/user-access.factory.ts
 *
 * PORQUE ESTE MÓDULO EXISTE: até aqui, uma empresa nova ficava com **uma** conta
 * — o ADMIN criado no auto-registo — e não havia forma de criar outra pelo
 * painel; `POST /v1/auth/register` existia mas nenhum ecrã o chamava. Também não
 * havia forma de reemitir uma senha nem de cortar um acesso. Um sistema que uma
 * empresa não consegue administrar sozinha não está pronto para clientes.
 *
 * REGRA DE DESENHO — cada papel entra pela porta que garante o seu vínculo:
 *   - ADMIN e SUPPORT      → aqui (contas de painel, sem vínculo a outra tabela)
 *   - DRIVER               → `drivers.service.grantDriverAccess` (o id da conta
 *                            TEM de ser o id do motorista; ver lá o porquê)
 *   - EMPLOYEE             → `hr-portal.service.provision` (liga a hr_employees)
 * Criar um DRIVER por aqui daria uma conta que entra na aplicação do motorista e
 * não encontra nem rota nem entregas — pior do que não ter conta.
 */
'use strict';

const crypto = require('crypto');
const { UserRepository } = require('../infrastructure/pg.repository');
const { hashPassword, passwordStrength } = require('../infrastructure/password.utils');
const { readCompanyId, writeCompanyId } = require('../infrastructure/tenant-context');
const { assertResourceLimit } = require('./subscriptions.service');
const audit = require('./audit.service');

/** Papéis que uma conta de painel pode ter. */
const PANEL_ROLES = ['ADMIN', 'SUPPORT'];

/**
 * Papéis que NÃO se criam por aqui, com a porta certa na mensagem de erro.
 * Existe para o erro ensinar em vez de só recusar.
 */
const ROLE_DOORS = {
  DRIVER:     'Crie o acesso do motorista na página Motoristas, para a conta ficar ligada ao registo do motorista.',
  EMPLOYEE:   'Crie o acesso do colaborador na página Contas do portal (RH).',
  SUPERADMIN: 'O SUPERADMIN da plataforma é criado pelo script de arranque, não pelo painel.',
  CLIENT:     'As contas de cliente pertencem ao portal do cliente.',
  SYSTEM:     'O papel SYSTEM é de integrações internas e não se atribui a pessoas.',
};

/**
 * Política das senhas emitidas por um administrador.
 *
 * É mais exigente do que a do registo (6) porque aqui a senha é escolhida por
 * uma pessoa PARA OUTRA e comunicada por fora do sistema — vive mais tempo em
 * mensagens e em papel. É a mesma exigência do portal do colaborador (§ 3.22),
 * de propósito: uma só regra para o utilizador decorar.
 */
const ISSUED_PASSWORD_POLICY = { min: 10, requireMixedCase: true, requireDigit: true };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class UsersError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {string} [code]
   */
  constructor(message, statusCode = 400, code = undefined) {
    super(message);
    this.name = 'UsersError';
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

/** Normaliza um email para a identidade global usada no login. */
function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Valida a senha emitida por um administrador. PURA.
 * @param {string} password
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkIssuedPassword(password) {
  return passwordStrength(password, ISSUED_PASSWORD_POLICY);
}

/**
 * Um ADMIN não mexe em contas com mais poder do que a sua, nem noutra empresa.
 * PURA — recebe o ator e o alvo já lidos.
 *
 * @param {{ role: string, sub: string, company_id?: string|null }} actor
 * @param {{ id: string, role: string, company_id?: string }} target
 * @returns {{ ok: boolean, reason?: string }}
 */
function canManage(actor, target) {
  if (!actor || !target) return { ok: false, reason: 'Conta não encontrada.' };
  if (actor.role === 'SUPERADMIN') return { ok: true };
  if (target.role === 'SUPERADMIN') {
    return { ok: false, reason: 'A conta da plataforma não é administrada pelo painel da empresa.' };
  }
  // O filtro da empresa já é feito no repositório; esta é a segunda barreira,
  // para o caso de alguém vir a chamar o serviço fora do contexto do pedido.
  const company = readCompanyId();
  if (company && target.company_id && target.company_id !== company) {
    return { ok: false, reason: 'Conta de outra empresa.' };
  }
  return { ok: true };
}

/**
 * Contas da empresa em contexto, com o papel e o estado de cada uma.
 *
 * Devolve TODAS as contas, incluindo motoristas e colaboradores do portal: é
 * aqui que se responde a "quem tem acesso ao sistema?" e a resposta não pode
 * deixar de fora metade das pessoas.
 *
 * @returns {Promise<object[]>}
 */
async function listUsers() {
  await UserRepository.ensureTable();
  return UserRepository.list();
}

/**
 * Cria uma conta de painel (ADMIN ou SUPPORT) na empresa em contexto.
 *
 * @param {{ name?: string, email: string, password: string, role?: string }} dto
 * @param {{ actor?: object, ip?: string, request_id?: string }} [context]
 * @returns {Promise<object>} conta pública (sem hash)
 */
async function createPanelUser(dto = {}, context = {}) {
  const email = normalizeEmail(dto.email);
  const role = String(dto.role ?? 'SUPPORT').trim().toUpperCase();
  const name = String(dto.name ?? '').trim();

  if (!EMAIL_RE.test(email)) throw new UsersError('E-mail inválido.');
  if (!name) throw new UsersError('Indique o nome da pessoa.');
  if (!PANEL_ROLES.includes(role)) {
    const door = ROLE_DOORS[role];
    throw new UsersError(door ?? `Papel inválido. Use ${PANEL_ROLES.join(' ou ')}.`);
  }

  const strength = checkIssuedPassword(dto.password);
  if (!strength.ok) throw new UsersError(strength.reason);

  await UserRepository.ensureTable();
  if (await UserRepository.findByEmailWithHash(email)) {
    throw new UsersError('Já existe uma conta com este e-mail.', 409);
  }

  // Limite de utilizadores do plano (§ 2.5). Sem isto, a página de contas era
  // uma porta lateral para passar a quota contratada.
  await assertResourceLimit('users');

  const created = await UserRepository.create({
    id:            crypto.randomUUID(),
    name,
    email,
    password_hash: hashPassword(dto.password),
    role,
    company_id:    writeCompanyId(),
  });

  await audit.record({
    action: 'users.create',
    company_id: created.company_id,
    summary: `Conta de ${role} criada para ${email}`,
    entity_type: 'user', entity_id: created.id, entity_label: email,
    outcome: audit.Outcome.SUCCESS,
    metadata: { role },
    request: { ip: context.ip, request_id: context.request_id },
  });

  return created;
}

/**
 * Reemite a senha de uma conta.
 *
 * PORQUE EXISTE, mesmo havendo recuperação por email (§ 3.22): a recuperação
 * depende de um provedor de email configurado. Sem provedor — que é o estado de
 * omissão — uma pessoa que perca a senha fica de fora e ninguém a pode fazer
 * entrar. Com um ADMIN único, isso é perder a empresa inteira.
 *
 * Não pede a senha antiga: quem chama já provou ser administrador. O que
 * protege o ato é o registo de auditoria, não uma segunda senha.
 *
 * @param {string} userId
 * @param {{ password: string }} dto
 * @param {{ actor: object, ip?: string, request_id?: string }} context
 * @returns {Promise<object>}
 */
async function setUserPassword(userId, dto = {}, context = {}) {
  await UserRepository.ensureTable();

  const target = await UserRepository.findById(userId);
  if (!target) throw new UsersError('Conta não encontrada.', 404);

  const permission = canManage(context.actor, target);
  if (!permission.ok) throw new UsersError(permission.reason, 403);

  const strength = checkIssuedPassword(dto.password);
  if (!strength.ok) throw new UsersError(strength.reason);

  const updated = await UserRepository.updatePassword(userId, hashPassword(dto.password));
  if (!updated) throw new UsersError('Conta não encontrada.', 404);

  await audit.record({
    action: 'users.password_reissued',
    company_id: updated.company_id,
    summary: `Senha reemitida para ${updated.email}`,
    entity_type: 'user', entity_id: updated.id, entity_label: updated.email,
    outcome: audit.Outcome.SUCCESS,
    // Nunca a senha, nem o hash: o valor de auditoria é o ato, não o segredo.
    metadata: { role: updated.role, by: context.actor?.email },
    request: { ip: context.ip, request_id: context.request_id },
  });

  return updated;
}

/**
 * Suspende ou reativa uma conta.
 *
 * Suspender em vez de apagar: as entregas, os documentos e os eventos de
 * auditoria continuam a apontar para esta pessoa (ver `migrations/user-access.js`).
 *
 * @param {string} userId
 * @param {{ status: 'active'|'blocked' }} dto
 * @param {{ actor: object, ip?: string, request_id?: string }} context
 * @returns {Promise<object>}
 */
async function setUserStatus(userId, dto = {}, context = {}) {
  const status = String(dto.status ?? '').trim().toLowerCase();
  if (!['active', 'blocked'].includes(status)) {
    throw new UsersError("Estado inválido. Use 'active' ou 'blocked'.");
  }

  await UserRepository.ensureTable();
  const target = await UserRepository.findById(userId);
  if (!target) throw new UsersError('Conta não encontrada.', 404);

  const permission = canManage(context.actor, target);
  if (!permission.ok) throw new UsersError(permission.reason, 403);

  // Quem está a mexer não se tranca a si próprio: seria um bloqueio sem saída,
  // porque a conta que poderia desfazer o ato é justamente a que ficou fora.
  if (status === 'blocked' && context.actor?.sub === userId) {
    throw new UsersError('Não pode suspender a sua própria conta.', 400, 'SELF_BLOCK');
  }

  // A última conta ADMIN ativa da empresa não pode ser suspensa: ficaria uma
  // empresa sem ninguém que possa administrá-la, e nem o SUPERADMIN reemite
  // senhas sem passar por aqui.
  if (status === 'blocked' && target.role === 'ADMIN') {
    const accounts = await UserRepository.list();
    const activeAdmins = accounts.filter((row) => row.role === 'ADMIN' && row.status === 'active');
    if (activeAdmins.length <= 1) {
      throw new UsersError('Esta é a última conta de administrador ativa. Crie outra antes de suspender esta.', 409, 'LAST_ADMIN');
    }
  }

  const updated = await UserRepository.updateStatus(userId, status);
  if (!updated) throw new UsersError('Conta não encontrada.', 404);

  await audit.record({
    action: status === 'blocked' ? 'users.blocked' : 'users.reactivated',
    company_id: updated.company_id,
    summary: `${status === 'blocked' ? 'Acesso suspenso' : 'Acesso reativado'}: ${updated.email}`,
    entity_type: 'user', entity_id: updated.id, entity_label: updated.email,
    outcome: audit.Outcome.SUCCESS,
    metadata: { role: updated.role, status, by: context.actor?.email },
    request: { ip: context.ip, request_id: context.request_id },
  });

  return updated;
}

module.exports = {
  // Puros
  checkIssuedPassword,
  canManage,
  normalizeEmail,
  // Casos de uso
  listUsers,
  createPanelUser,
  setUserPassword,
  setUserStatus,
  // Constantes
  PANEL_ROLES,
  ROLE_DOORS,
  ISSUED_PASSWORD_POLICY,
  UsersError,
};
