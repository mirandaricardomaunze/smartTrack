/**
 * @file clients.service.js
 * @description Camada de aplicação — registo de Clientes/Remetentes.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.12
 *
 * Entidade de cliente reutilizável (contactos, NUIT, morada) com histórico de
 * encomendas derivado de `orders.client_ref_id`. Deduplicação por email.
 */
'use strict';

const crypto = require('crypto');
const { ClientRepository, OrderRepository } = require('../infrastructure/pg.repository');

const ClientType = Object.freeze({ INDIVIDUAL: 'individual', BUSINESS: 'business' });
const ClientStatus = Object.freeze({ ACTIVE: 'active', INACTIVE: 'inactive' });

const MAX_NAME = 160;
const MAX_NOTES = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Erros ───────────────────────────────────────────────────────────────────

class ClientValidationError extends Error {
  constructor(message) { super(message); this.name = 'ClientValidationError'; this.statusCode = 400; }
}
class ClientNotFoundError extends Error {
  constructor(id) { super(`Cliente não encontrado: ${id}`); this.name = 'ClientNotFoundError'; this.statusCode = 404; }
}
class DuplicateClientEmailError extends Error {
  constructor(email) { super(`Já existe um cliente com o email "${email}".`); this.name = 'DuplicateClientEmailError'; this.statusCode = 409; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeEmail(email) {
  const s = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!s) return undefined;
  if (!EMAIL_RE.test(s)) throw new ClientValidationError('Email inválido.');
  return s;
}

function cleanAddress(a) {
  if (!a || typeof a !== 'object') return undefined;
  const out = {};
  for (const k of ['street', 'city', 'state', 'country']) {
    if (typeof a[k] === 'string' && a[k].trim()) out[k] = a[k].trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeType(type) {
  if (type === undefined) return ClientType.INDIVIDUAL;
  if (![ClientType.INDIVIDUAL, ClientType.BUSINESS].includes(type)) {
    throw new ClientValidationError('Tipo inválido. Use "individual" ou "business".');
  }
  return type;
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

async function createClient(dto = {}) {
  const name = typeof dto.name === 'string' ? dto.name.trim() : '';
  if (!name) throw new ClientValidationError('O nome é obrigatório.');
  if (name.length > MAX_NAME) throw new ClientValidationError(`O nome excede ${MAX_NAME} caracteres.`);

  const email = normalizeEmail(dto.email);
  if (email) {
    const existing = await ClientRepository.findByEmail(email);
    if (existing) throw new DuplicateClientEmailError(email);
  }

  const client = await ClientRepository.create({
    id: crypto.randomUUID(),
    name,
    type: normalizeType(dto.type),
    email,
    phone: typeof dto.phone === 'string' && dto.phone.trim() ? dto.phone.trim() : undefined,
    tax_id: typeof dto.tax_id === 'string' && dto.tax_id.trim() ? dto.tax_id.trim() : undefined,
    address: cleanAddress(dto.address),
    notes: typeof dto.notes === 'string' && dto.notes.trim() ? dto.notes.trim().slice(0, MAX_NOTES) : undefined,
    status: ClientStatus.ACTIVE,
  });
  return client;
}

async function listClients(opts = {}) {
  const page = Math.max(Number(opts.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 20, 1), 100);
  const status = opts.status && [ClientStatus.ACTIVE, ClientStatus.INACTIVE].includes(opts.status) ? opts.status : undefined;
  const { items, total } = await ClientRepository.list({
    search: opts.search, status, limit: pageSize, offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize };
}

/** Detalhe do cliente + histórico de encomendas ligadas. */
async function getClient(id) {
  const client = await ClientRepository.findById(id);
  if (!client) throw new ClientNotFoundError(id);
  const orders = await OrderRepository.findByClientRef(id);
  const delivered = orders.filter((o) => o.current_status === 'delivered').length;
  const total_value_cents = orders.reduce((sum, o) => sum + Number(o.value ?? 0), 0);
  return { ...client, orders, order_metrics: { total: orders.length, delivered, total_value_cents } };
}

async function updateClient(id, patch = {}) {
  const existing = await ClientRepository.findById(id);
  if (!existing) throw new ClientNotFoundError(id);

  const clean = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new ClientValidationError('O nome é obrigatório.');
    clean.name = name.slice(0, MAX_NAME);
  }
  if (patch.type !== undefined) clean.type = normalizeType(patch.type);
  if (patch.email !== undefined) {
    const email = normalizeEmail(patch.email);
    if (email && email !== existing.email) {
      const dup = await ClientRepository.findByEmail(email);
      if (dup && dup.id !== id) throw new DuplicateClientEmailError(email);
    }
    clean.email = email ?? null;
  }
  if (patch.phone !== undefined)  clean.phone = String(patch.phone ?? '').trim() || null;
  if (patch.tax_id !== undefined) clean.tax_id = String(patch.tax_id ?? '').trim() || null;
  if (patch.address !== undefined) clean.address = cleanAddress(patch.address) ?? null;
  if (patch.notes !== undefined)  clean.notes = String(patch.notes ?? '').trim().slice(0, MAX_NOTES) || null;
  if (patch.status !== undefined) {
    if (![ClientStatus.ACTIVE, ClientStatus.INACTIVE].includes(patch.status)) {
      throw new ClientValidationError('Estado inválido. Use "active" ou "inactive".');
    }
    clean.status = patch.status;
  }
  return ClientRepository.update(id, clean);
}

async function deactivateClient(id) {
  return updateClient(id, { status: ClientStatus.INACTIVE });
}

async function getStats() {
  return ClientRepository.getStats();
}

module.exports = {
  createClient,
  listClients,
  getClient,
  updateClient,
  deactivateClient,
  getStats,
  ClientValidationError,
  ClientNotFoundError,
  DuplicateClientEmailError,
};
