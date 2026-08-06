/**
 * @file tenant-context.js
 * @description Contexto de empresa (multi-tenant) por requisição, via AsyncLocalStorage.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4 (Multiempresa)
 *
 * A empresa do utilizador é resolvida do JWT e guardada num contexto assíncrono que
 * atravessa chamadas entre módulos sem alterar assinaturas. Os repositórios leem
 * `getCompanyId()`:
 *   - string  → há empresa no contexto → filtra/escreve nessa empresa (isolamento).
 *   - null    → contexto sem empresa (SUPERADMIN ou rota pública) → sem filtro.
 *   - undefined → sem contexto (testes/tarefas de fundo) → sem filtro; escreve na
 *                 Empresa Padrão (retrocompatível com o comportamento single-tenant).
 */
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Empresa por omissão — dados legados e operações sem contexto pertencem aqui. */
const DEFAULT_COMPANY_ID = 'company-default';

/**
 * Executa `fn` com a empresa dada no contexto assíncrono.
 * @param {string|null} companyId
 * @param {Function} fn
 */
function runWithCompany(companyId, fn) {
  return als.run({ companyId: companyId ?? null }, fn);
}

/**
 * Empresa do contexto atual.
 * @returns {string|null|undefined} string (empresa), null (sem empresa), undefined (sem contexto)
 */
function getCompanyId() {
  const store = als.getStore();
  return store ? store.companyId : undefined;
}

/** Empresa efetiva para ESCRITA: a do contexto, ou a Empresa Padrão. */
function writeCompanyId() {
  return getCompanyId() ?? DEFAULT_COMPANY_ID;
}

/**
 * Empresa para FILTRO de leitura: só devolve um id quando há uma empresa concreta
 * no contexto (isolamento). Devolve undefined para "sem filtro" (testes, SUPERADMIN,
 * rotas públicas).
 * @returns {string|undefined}
 */
function readCompanyId() {
  const cid = getCompanyId();
  return typeof cid === 'string' ? cid : undefined;
}

module.exports = { runWithCompany, getCompanyId, writeCompanyId, readCompanyId, DEFAULT_COMPANY_ID };
