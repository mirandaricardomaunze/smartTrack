/**
 * @file drivers.service.js
 * @description Camada de aplicação — use cases de Motoristas (em Inglês).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Motorista)
 */
'use strict';

const crypto = require('crypto');
const { DriverRepository, UserRepository } = require('../infrastructure/pg.repository');
const { hashPassword } = require('../infrastructure/password.utils');
const { writeCompanyId } = require('../infrastructure/tenant-context');
const { assertResourceLimit } = require('./subscriptions.service');
const users = require('./users.service');
const audit = require('./audit.service');
const modals = require('../domain/delivery-modals');

// ─── Erros de Aplicação ──────────────────────────────────────────────────────

class DriverNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`Driver not found: ${id}`);
    this.name       = 'DriverNotFoundError';
    this.statusCode = 404;
  }
}

class InvalidGpsPayloadError extends Error {
  constructor() {
    super('Invalid GPS payload: lat and lng are required and must be numbers');
    this.name       = 'InvalidGpsPayloadError';
    this.statusCode = 400;
  }
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

class DriverAccessError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   */
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DriverAccessError';
    this.statusCode = statusCode;
  }
}

/**
 * Lista todos os motoristas, dizendo quem já tem acesso à aplicação.
 *
 * `has_access` vem numa consulta só para todos os motoristas — o painel precisa
 * de saber a quem falta criar acesso, e uma consulta por linha era um N+1 numa
 * página que a operação abre todos os dias.
 *
 * @returns {Promise<object[]>}
 */
async function listDrivers() {
  const drivers = await DriverRepository.findAll();
  if (drivers.length === 0) return drivers;

  await UserRepository.ensureTable();
  // A conta do motorista tem o id do próprio motorista (ver `grantDriverAccess`),
  // por isso a existência do acesso lê-se com os ids que já temos.
  const withAccount = await UserRepository.existingIds(drivers.map((driver) => driver.id));
  return drivers.map((driver) => ({ ...driver, has_access: withAccount.has(driver.id) }));
}

/**
 * Tipos de veículo aceites — vêm do catálogo de modais (§ 3.33), que é também
 * quem sabe a capacidade e a carta exigida. A lista deixou de estar escrita aqui
 * para o mototriciclo não entrar no cadastro sem entrar no despacho e na tarifa.
 */
const VEHICLE_TYPES = modals.MODAL_CODES;

/**
 * Registra um motorista novo.
 *
 * Sem acesso à aplicação: o acesso cria-se depois, em `grantDriverAccess`, para
 * o email e a senha serem uma decisão à parte de cadastrar a pessoa e o veículo.
 *
 * @param {{ name: string, phone?: string, email?: string, vehicle?: object }} dto
 * @param {{ actor?: object, ip?: string, request_id?: string }} [context]
 * @returns {Promise<object>}
 */
async function createDriver(dto = {}, context = {}) {
  const name = String(dto.name ?? '').trim();
  if (name.length < 3) throw new DriverAccessError('Indique o nome completo do motorista.');

  // O email é obrigatório no registo (a coluna é NOT NULL) e é também o candidato
  // natural ao email de acesso — o formulário do acesso já o traz preenchido.
  const email = users.normalizeEmail(dto.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DriverAccessError('Indique o e-mail do motorista.');
  }

  const vehicle = dto.vehicle ?? {};
  // O catálogo aceita os sinónimos que a operação usa ("mota", "triciclo",
  // "txopela") e devolve sempre o código canónico — é isso que fica gravado.
  const modal = modals.getModal(vehicle.type ?? modals.DeliveryModal.MOTO);
  if (!modal) {
    throw new DriverAccessError(`Tipo de veículo inválido. Use ${VEHICLE_TYPES.join(', ')}.`);
  }
  const type = modal.code;

  const plate = String(vehicle.plate ?? '').trim().toUpperCase();
  if (!plate) throw new DriverAccessError('Indique a matrícula do veículo.');

  // A carta tem de habilitar o modal: um mototriciclista sem categoria A não
  // pode ser despachado, e descobrir isso na estrada é tarde de mais.
  let licence_category;
  try {
    licence_category = modals.resolveLicenceCategory(type, vehicle.licence_category);
  } catch (err) {
    throw new DriverAccessError(err.message);
  }

  // A capacidade declarada nunca ultrapassa o teto do modal (§ 3.33) — sem isto,
  // escrever "500" no cadastro de uma moto anulava a verificação do despacho.
  const capacity_kg = modals.capacityKgFor(type, vehicle.capacity_kg);

  const driver = await DriverRepository.create({
    id: crypto.randomUUID(),
    name,
    email,
    phone: dto.phone ? String(dto.phone).trim() : null,
    vehicle: { type, plate, capacity_kg, licence_category },
    // Sem acesso à aplicação ainda não pode estar disponível para rota.
    current_status: 'offline',
    // Vazio, e não 100% de tudo. Um motorista recém-criado não tem
    // desempenho — tem falta de amostra, e é isso que o § 3.43 mostra. Os
    // indicadores passaram a ser calculados das encomendas em
    // `driver-performance.service`; esta coluna fica só por compatibilidade
    // com quem ainda a lê.
    performance_metrics: {},
  });

  await audit.record({
    action: 'drivers.create',
    summary: `Motorista ${driver.name} registado (${plate})`,
    entity_type: 'driver', entity_id: driver.id, entity_label: driver.name,
    outcome: audit.Outcome.SUCCESS,
    metadata: { plate, vehicle_type: type, by: context.actor?.email },
    request: { ip: context.ip, request_id: context.request_id },
  });

  return { ...driver, has_access: false };
}

/**
 * Cria a conta de acesso à aplicação de um motorista que já existe.
 *
 * PORQUE O ID DA CONTA É O ID DO MOTORISTA: a aplicação do motorista usa o `sub`
 * do token como identificador do motorista — `GET /v1/routes/me` chama
 * `getActiveRouteForDriver(req.user.sub)` e `PUT /v1/drivers/:id/gps` autoriza
 * por `req.params.id === req.user.sub`. Uma conta com um id próprio autenticava
 * e depois não encontrava rota, entregas nem GPS. Até aqui isto só funcionava
 * porque a conta de demonstração tinha o `sub` fixo a coincidir com um motorista
 * semeado — e essas contas estão desligadas em produção.
 *
 * @param {string} driverId
 * @param {{ email: string, password: string }} dto
 * @param {{ actor?: object, ip?: string, request_id?: string }} [context]
 * @returns {Promise<{ id: string, email: string, role: 'DRIVER', driver_id: string, name: string }>}
 */
async function grantDriverAccess(driverId, dto = {}, context = {}) {
  const driver = await DriverRepository.findById(driverId);
  if (!driver) throw new DriverNotFoundError(driverId);

  const email = users.normalizeEmail(dto.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DriverAccessError('E-mail inválido.');

  const strength = users.checkIssuedPassword(dto.password);
  if (!strength.ok) throw new DriverAccessError(strength.reason);

  await UserRepository.ensureTable();

  // Já tem conta? O id é o do motorista, por isso a pergunta é direta.
  const existingAccount = await UserRepository.findById(driver.id);
  if (existingAccount) {
    throw new DriverAccessError(`Este motorista já tem acesso (${existingAccount.email}).`, 409);
  }
  if (await UserRepository.findByEmailWithHash(email)) {
    throw new DriverAccessError('Já existe uma conta com este e-mail.', 409);
  }

  // Conta para o limite de utilizadores do plano (§ 2.5), como qualquer conta.
  await assertResourceLimit('users');

  const account = await UserRepository.create({
    id:            driver.id,
    name:          driver.name,
    email,
    password_hash: hashPassword(dto.password),
    role:          'DRIVER',
    company_id:    writeCompanyId(),
  });

  await audit.record({
    action: 'drivers.access_granted',
    company_id: account.company_id,
    summary: `Acesso à aplicação criado para o motorista ${driver.name} (${email})`,
    entity_type: 'driver', entity_id: driver.id, entity_label: driver.name,
    outcome: audit.Outcome.SUCCESS,
    metadata: { email, by: context.actor?.email },
    request: { ip: context.ip, request_id: context.request_id },
  });

  return { ...account, driver_id: driver.id };
}

/**
 * Retorna posições GPS de todos os motoristas.
 *
 * @returns {Promise<Array<{ id: string; name: string; vehicle: object; current_status: string; gps: object }>>}
 */
async function listDriverLocations() {
  const drivers = await DriverRepository.findAll();
  return drivers.map((d) => ({
    id:             d.id,
    name:           d.name,
    vehicle:        d.vehicle,
    current_status: d.current_status,
    gps:            d.gps,
  }));
}

/**
 * Atualiza a posição GPS de um motorista.
 *
 * @param {string} driverId
 * @param {{ lat: number; lng: number; heading: number; speed: number }} dto
 * @returns {Promise<{ success: boolean; gps: object }>}
 */
async function updateDriverGps(driverId, dto) {
  if (
    typeof dto.lat !== 'number' ||
    typeof dto.lng !== 'number'
  ) {
    throw new InvalidGpsPayloadError();
  }

  const driver = await DriverRepository.findById(driverId);
  if (!driver) throw new DriverNotFoundError(driverId);

  const updatedDriver = {
    ...driver,
    gps: {
      lat:       dto.lat,
      lng:       dto.lng,
      heading:   typeof dto.heading === 'number' ? dto.heading : 0,
      speed:     typeof dto.speed   === 'number' ? dto.speed   : 0,
      updatedAt: new Date().toISOString(),
    },
  };

  await DriverRepository.update(updatedDriver);
  return { success: true, gps: updatedDriver.gps };
}

module.exports = {
  listDrivers,
  listDriverLocations,
  updateDriverGps,
  createDriver,
  grantDriverAccess,
  VEHICLE_TYPES,
  DriverNotFoundError,
  InvalidGpsPayloadError,
  DriverAccessError,
};
