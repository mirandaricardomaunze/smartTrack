/**
 * @file contracts.service.js
 * @description Contratos de cliente — condições comerciais que o sistema aplica sozinho.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 * PORQUÊ EXISTE: o § 3.12 registava o cliente e o § 3.13 calculava a tabela
 * pública. Entre os dois faltava o que na prática rege quase toda a faturação de
 * uma transportadora: a condição negociada com o cliente recorrente. Sem ela,
 * quem regista o pedido tem de se lembrar do desconto e escrever o preço à mão
 * — e o erro acontece nos dois sentidos, a cobrar de mais e a cobrar de menos.
 *
 * Três decisões estruturam o módulo:
 *
 *   1. **O núcleo é puro.** `resolveContract`, `applyContractToQuote`,
 *      `dueDateFrom` e `assessCredit` não tocam na base. O preço de um cliente é
 *      a parte que tem de ser afirmável num teste sem montar nada à volta.
 *
 *   2. **Um contrato por cliente e por data.** Contratos que se sobrepõem no
 *      tempo são recusados na escrita. A alternativa — escolher um deles na
 *      leitura — faria o preço depender da ordem das linhas, e "porque é que
 *      esta encomenda saiu a este preço" deixaria de ter resposta.
 *
 *   3. **Aplicar é explícito no detalhe.** O orçamento devolve `contract_code`,
 *      `contract_discount_cents` e `minimum_adjustment_cents` em linhas próprias.
 *      Um desconto que só aparece no total é indefensável quando o cliente
 *      pergunta a conta.
 */
'use strict';

const crypto = require('crypto');
const { ContractRepository, InvoiceRepository } = require('../infrastructure/pg.repository');

const ContractStatus = Object.freeze({
  DRAFT:     'draft',
  ACTIVE:    'active',
  SUSPENDED: 'suspended',
  ENDED:     'ended',
});

const MAX_CODE = 40;
const MAX_NOTES = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Erros ───────────────────────────────────────────────────────────────────

class ContractValidationError extends Error {
  constructor(message) { super(message); this.name = 'ContractValidationError'; this.statusCode = 400; }
}
class ContractNotFoundError extends Error {
  constructor(id) { super(`Contrato não encontrado: ${id}`); this.name = 'ContractNotFoundError'; this.statusCode = 404; }
}
class DuplicateContractCodeError extends Error {
  constructor(code) { super(`Já existe um contrato com o código "${code}".`); this.name = 'DuplicateContractCodeError'; this.statusCode = 409; }
}
class OverlappingContractError extends Error {
  constructor(code) {
    super(`O período sobrepõe-se ao contrato "${code}" do mesmo cliente. Termine ou ajuste esse antes de criar outro.`);
    this.name = 'OverlappingContractError';
    this.statusCode = 409;
  }
}
/** Limite de crédito ultrapassado — trava a criação de encomendas (§ 3.35). */
class CreditLimitExceededError extends Error {
  constructor(detail) {
    super(
      `O cliente ultrapassou o limite de crédito do contrato ${detail.contract_code}: ` +
      `${(detail.outstanding_cents / 100).toFixed(2)} MZN em dívida contra um limite de ` +
      `${(detail.credit_limit_cents / 100).toFixed(2)} MZN. Regularize antes de registar nova encomenda.`,
    );
    this.name = 'CreditLimitExceededError';
    this.statusCode = 409;
    this.detail = detail;
  }
}

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * O contrato cobre esta data? PURA.
 *
 * `ends_on` é INCLUSIVO: um contrato que termina a 31/12 vale no dia 31. É como
 * qualquer pessoa lê um contrato em papel, e o contrário produzia uma
 * discussão com o cliente no último dia de cada ano.
 *
 * @param {{ starts_on: string, ends_on?: string|null }} contract
 * @param {string} isoDate Data no formato YYYY-MM-DD.
 * @returns {boolean}
 */
function coversDate(contract, isoDate) {
  if (!contract?.starts_on) return false;
  const dia = String(isoDate).slice(0, 10);
  if (dia < String(contract.starts_on).slice(0, 10)) return false;
  if (!contract.ends_on) return true;
  return dia <= String(contract.ends_on).slice(0, 10);
}

/**
 * Dois períodos cruzam-se? PURA. `ends_on` nulo = sem termo.
 *
 * @param {{ starts_on: string, ends_on?: string|null }} a
 * @param {{ starts_on: string, ends_on?: string|null }} b
 * @returns {boolean}
 */
function periodsOverlap(a, b) {
  const inicioA = String(a.starts_on).slice(0, 10);
  const inicioB = String(b.starts_on).slice(0, 10);
  const fimA = a.ends_on ? String(a.ends_on).slice(0, 10) : '9999-12-31';
  const fimB = b.ends_on ? String(b.ends_on).slice(0, 10) : '9999-12-31';
  return inicioA <= fimB && inicioB <= fimA;
}

/**
 * O contrato aplicável a uma data. PURA.
 *
 * Só `active` conta: um rascunho ainda não foi acordado e um suspenso foi
 * cortado de propósito — aplicar qualquer deles seria faturar por uma condição
 * que ninguém assinou. Devolve `null` quando não há, e nesse caso o preço é o
 * da tabela pública.
 *
 * @param {object[]} contracts
 * @param {string} isoDate
 * @returns {object|null}
 */
function resolveContract(contracts, isoDate) {
  const aplicaveis = (contracts ?? []).filter(
    (c) => c?.status === ContractStatus.ACTIVE && coversDate(c, isoDate),
  );
  if (aplicaveis.length === 0) return null;
  // A escrita impede sobreposições; se ainda assim houver duas (dados migrados
  // à mão), vale a que começou mais tarde — a mais recentemente acordada.
  return aplicaveis.sort(
    (a, b) => String(b.starts_on).localeCompare(String(a.starts_on)),
  )[0];
}

/**
 * Tarifa negociada para uma zona, se existir. PURA.
 *
 * @param {object|null} contract
 * @param {string} zoneCode
 * @returns {{ base_cents?: number, per_kg_cents?: number, included_kg?: number }|null}
 */
function zoneRateFor(contract, zoneCode) {
  if (!contract || !Array.isArray(contract.zone_rates)) return null;
  const alvo = String(zoneCode ?? '').trim().toUpperCase();
  return contract.zone_rates.find(
    (r) => String(r?.zone_code ?? '').trim().toUpperCase() === alvo,
  ) ?? null;
}

/**
 * Aplica o contrato a um orçamento já calculado. PURA.
 *
 * ORDEM, e porquê:
 *   1. o desconto incide sobre o **frete** (base + peso + serviço + modal) e
 *      NÃO sobre a sobretaxa de COD — essa é um custo que se repassa, e
 *      descontá-la seria oferecer dinheiro que sai da empresa à mesma;
 *   2. o piso (`minimum_charge_cents`) aplica-se **depois** do desconto, que é
 *      precisamente para o que serve: impedir que um desconto grande numa
 *      encomenda pequena deixe o frete abaixo do que custa fazê-la.
 *
 * A tarifa negociada por zona não entra aqui: substitui a tabela ANTES do
 * cálculo (ver `pricing.service`), para que o multiplicador de expresso incida
 * sobre o preço acordado e não sobre o público.
 *
 * @param {object} quote Detalhe devolvido por `computeQuote`.
 * @param {object|null} contract
 * @returns {object} Novo detalhe. O original não é alterado.
 */
function applyContractToQuote(quote, contract) {
  if (!contract) {
    return {
      ...quote,
      contract_id: null,
      contract_code: null,
      contract_discount_cents: 0,
      minimum_adjustment_cents: 0,
    };
  }

  const freteBruto = quote.base_cents + quote.weight_cents + quote.service_cents + quote.modal_cents;
  const pct = Math.min(100, Math.max(0, Number(contract.discount_pct) || 0));
  const desconto = Math.round((freteBruto * pct) / 100);

  const freteComDesconto = freteBruto - desconto;
  const piso = Math.max(0, Math.round(Number(contract.minimum_charge_cents) || 0));
  const ajustePiso = Math.max(0, piso - freteComDesconto);

  return {
    ...quote,
    contract_id: contract.id ?? null,
    contract_code: contract.code ?? null,
    contract_discount_cents: desconto,
    minimum_adjustment_cents: ajustePiso,
    total_cents: freteComDesconto + ajustePiso + quote.cod_surcharge_cents,
  };
}

/**
 * Data de vencimento a partir do prazo acordado. PURA.
 *
 * Devolve `null` para prazo 0 — pronto pagamento não tem vencimento, e datar a
 * fatura com o próprio dia da emissão faria qualquer mapa de dívida contá-la
 * como vencida a partir da manhã seguinte.
 *
 * @param {string} issuedAtIso
 * @param {number} termsDays
 * @returns {string|null} YYYY-MM-DD
 */
function dueDateFrom(issuedAtIso, termsDays) {
  const dias = Math.max(0, Math.round(Number(termsDays) || 0));
  if (dias === 0) return null;
  const d = new Date(issuedAtIso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * O cliente pode receber mais uma encomenda? PURA.
 *
 * `credit_limit_cents` a 0 significa **sem limite** e não "limite zero": um
 * contrato sem limite acordado é o caso comum, e tratá-lo como zero travava
 * todos os clientes no dia em que a funcionalidade entrasse.
 *
 * @param {object|null} contract
 * @param {number} outstandingCents Dívida em aberto do cliente.
 * @param {number} [newOrderCents] Valor da encomenda a registar.
 * @returns {{ ok: boolean, contract_code: string|null, credit_limit_cents: number, outstanding_cents: number, projected_cents: number, available_cents: number|null }}
 */
function assessCredit(contract, outstandingCents, newOrderCents = 0) {
  const divida = Math.max(0, Math.round(Number(outstandingCents) || 0));
  const nova = Math.max(0, Math.round(Number(newOrderCents) || 0));
  const limite = Math.max(0, Math.round(Number(contract?.credit_limit_cents) || 0));
  const projetado = divida + nova;

  return {
    ok: limite === 0 ? true : projetado <= limite,
    contract_code: contract?.code ?? null,
    credit_limit_cents: limite,
    outstanding_cents: divida,
    projected_cents: projetado,
    available_cents: limite === 0 ? null : Math.max(0, limite - divida),
  };
}

// ─── Validação ───────────────────────────────────────────────────────────────

function text(value, max, campo) {
  if (value == null) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (s.length > max) throw new ContractValidationError(`${campo} excede ${max} caracteres.`);
  return s;
}

function isoDate(value, campo, obrigatorio) {
  if (value == null || String(value).trim() === '') {
    if (obrigatorio) throw new ContractValidationError(`${campo} é obrigatória.`);
    return null;
  }
  const s = String(value).slice(0, 10);
  if (!DATE_RE.test(s)) throw new ContractValidationError(`${campo} deve estar no formato AAAA-MM-DD.`);
  return s;
}

function cents(value, campo) {
  if (value == null || value === '') return 0;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) throw new ContractValidationError(`${campo} deve ser um valor não negativo.`);
  return n;
}

/**
 * Normaliza as tarifas negociadas.
 *
 * Uma linha só conta se trouxer pelo menos um dos valores; uma zona listada sem
 * nada acordado é ruído que depois parece uma tarifa a zero.
 *
 * @param {unknown} value
 * @returns {Array<object>}
 */
function normalizeZoneRates(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ContractValidationError('As tarifas negociadas devem vir numa lista.');

  const vistas = new Set();
  const out = [];
  for (const linha of value) {
    const zone_code = String(linha?.zone_code ?? '').trim().toUpperCase();
    if (!zone_code) throw new ContractValidationError('Cada tarifa negociada precisa da zona.');
    if (vistas.has(zone_code)) {
      throw new ContractValidationError(`A zona ${zone_code} aparece duas vezes nas tarifas negociadas.`);
    }
    vistas.add(zone_code);

    const rate = { zone_code };
    if (linha.base_cents != null && linha.base_cents !== '') rate.base_cents = cents(linha.base_cents, 'O preço base negociado');
    if (linha.per_kg_cents != null && linha.per_kg_cents !== '') rate.per_kg_cents = cents(linha.per_kg_cents, 'O preço por kg negociado');
    if (linha.included_kg != null && linha.included_kg !== '') {
      const kg = Number(linha.included_kg);
      if (!Number.isFinite(kg) || kg < 0) throw new ContractValidationError('O peso incluído negociado deve ser não negativo.');
      rate.included_kg = kg;
    }

    if (Object.keys(rate).length === 1) {
      throw new ContractValidationError(`A tarifa negociada da zona ${zone_code} não tem nenhum valor acordado.`);
    }
    out.push(rate);
  }
  return out;
}

/**
 * Valida e normaliza um contrato vindo do exterior. PURA.
 * @param {object} dto
 * @param {object} [atual] Contrato existente, numa atualização parcial.
 * @returns {object}
 */
function normalizeContract(dto = {}, atual = null) {
  const client_ref_id = text(dto.client_ref_id ?? atual?.client_ref_id, 80, 'O cliente');
  if (!client_ref_id) throw new ContractValidationError('O cliente é obrigatório.');

  const code = text(dto.code ?? atual?.code, MAX_CODE, 'O código');
  if (!code) throw new ContractValidationError('O código do contrato é obrigatório.');

  const status = dto.status ?? atual?.status ?? ContractStatus.DRAFT;
  if (!Object.values(ContractStatus).includes(status)) {
    throw new ContractValidationError(`Estado inválido. Use ${Object.values(ContractStatus).join(', ')}.`);
  }

  const starts_on = isoDate(dto.starts_on ?? atual?.starts_on, 'A data de início', true);
  const ends_on = dto.ends_on !== undefined
    ? isoDate(dto.ends_on, 'A data de fim', false)
    : (atual?.ends_on ? String(atual.ends_on).slice(0, 10) : null);

  if (ends_on && ends_on < starts_on) {
    throw new ContractValidationError('A data de fim não pode ser anterior à de início.');
  }

  const pctBruto = dto.discount_pct ?? atual?.discount_pct ?? 0;
  const discount_pct = Number(pctBruto) || 0;
  if (discount_pct < 0 || discount_pct > 100) {
    throw new ContractValidationError('O desconto deve estar entre 0 e 100%.');
  }

  const payment_terms_days = Math.round(Number(dto.payment_terms_days ?? atual?.payment_terms_days ?? 0) || 0);
  if (payment_terms_days < 0 || payment_terms_days > 365) {
    throw new ContractValidationError('O prazo de pagamento deve estar entre 0 e 365 dias.');
  }

  return {
    client_ref_id,
    code,
    status,
    starts_on,
    ends_on,
    discount_pct,
    minimum_charge_cents: cents(dto.minimum_charge_cents ?? atual?.minimum_charge_cents, 'O valor mínimo'),
    payment_terms_days,
    credit_limit_cents: cents(dto.credit_limit_cents ?? atual?.credit_limit_cents, 'O limite de crédito'),
    zone_rates: dto.zone_rates !== undefined
      ? normalizeZoneRates(dto.zone_rates)
      : (atual?.zone_rates ?? []),
    notes: text(dto.notes ?? atual?.notes, MAX_NOTES, 'As notas') ?? null,
  };
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/**
 * Recusa o contrato se o período cruzar outro ATIVO do mesmo cliente.
 * Ver a decisão 2 no topo do ficheiro.
 *
 * @param {object} candidato
 * @param {string|null} ignorarId Id do próprio contrato, numa atualização.
 */
async function assertNoOverlap(candidato, ignorarId = null) {
  if (candidato.status !== ContractStatus.ACTIVE) return;

  const existentes = await ContractRepository.listByClient(candidato.client_ref_id);
  for (const outro of existentes) {
    if (outro.id === ignorarId) continue;
    if (outro.status !== ContractStatus.ACTIVE) continue;
    if (periodsOverlap(candidato, outro)) throw new OverlappingContractError(outro.code);
  }
}

/** @param {object} dto */
async function createContract(dto = {}) {
  const dados = normalizeContract(dto);

  if (await ContractRepository.findByCode(dados.code)) {
    throw new DuplicateContractCodeError(dados.code);
  }
  await assertNoOverlap(dados);

  const now = new Date().toISOString();
  return ContractRepository.create({
    ...dados,
    id: `contract-${crypto.randomUUID()}`,
    created_at: now,
    updated_at: now,
  });
}

/**
 * @param {string} id
 * @param {object} patch
 */
async function updateContract(id, patch = {}) {
  const atual = await ContractRepository.findById(id);
  if (!atual) throw new ContractNotFoundError(id);

  const dados = normalizeContract(patch, atual);

  if (dados.code !== atual.code) {
    const outro = await ContractRepository.findByCode(dados.code);
    if (outro && outro.id !== id) throw new DuplicateContractCodeError(dados.code);
  }
  await assertNoOverlap(dados, id);

  return ContractRepository.update(id, { ...dados, updated_at: new Date().toISOString() });
}

/** @param {{ client_ref_id?: string, status?: string }} [opts] */
async function listContracts(opts = {}) {
  return ContractRepository.list(opts);
}

/** @param {string} id */
async function getContract(id) {
  const contrato = await ContractRepository.findById(id);
  if (!contrato) throw new ContractNotFoundError(id);
  return contrato;
}

/**
 * Termina o contrato hoje.
 *
 * Não apaga: as encomendas já faturadas apontam para ele, e sem a linha ninguém
 * consegue explicar o preço que saiu — o mesmo raciocínio do § 3.32 para as
 * contas de utilizador.
 *
 * @param {string} id
 */
async function endContract(id) {
  const contrato = await ContractRepository.findById(id);
  if (!contrato) throw new ContractNotFoundError(id);

  const hoje = new Date().toISOString().slice(0, 10);
  return ContractRepository.update(id, {
    ...contrato,
    status: ContractStatus.ENDED,
    // Um contrato que ainda nem começou termina no dia em que começaria; datar
    // o fim antes do início deixava a linha inválida na base.
    ends_on: hoje < String(contrato.starts_on).slice(0, 10) ? String(contrato.starts_on).slice(0, 10) : hoje,
    updated_at: new Date().toISOString(),
  });
}

/**
 * O contrato em vigor para um cliente, numa data.
 *
 * @param {string} clientRefId
 * @param {string} [isoDate] Por omissão, hoje.
 * @returns {Promise<object|null>}
 */
async function contractForClient(clientRefId, isoDate = new Date().toISOString().slice(0, 10)) {
  if (!clientRefId) return null;
  const contratos = await ContractRepository.listByClient(clientRefId);
  return resolveContract(contratos, isoDate);
}

/**
 * Situação de crédito do cliente à data.
 *
 * A dívida é a soma das faturas emitidas e não pagas — não inclui anuladas nem
 * pagas. É o único número que responde a "quanto é que este cliente nos deve".
 *
 * @param {string} clientRefId
 * @param {number} [newOrderCents]
 * @returns {Promise<object>}
 */
async function creditStatus(clientRefId, newOrderCents = 0) {
  const contrato = await contractForClient(clientRefId);
  const outstanding = await InvoiceRepository.outstandingForClient(clientRefId);
  return { ...assessCredit(contrato, outstanding, newOrderCents), contract_id: contrato?.id ?? null };
}

/**
 * Trava a operação quando o limite de crédito foi ultrapassado.
 *
 * Sem contrato ou sem limite acordado não faz nada — a esmagadora maioria das
 * encomendas passa por aqui e não pode pagar o custo de uma decisão que não lhe
 * diz respeito.
 *
 * @param {string} clientRefId
 * @param {number} [newOrderCents]
 * @throws {CreditLimitExceededError}
 */
async function assertWithinCredit(clientRefId, newOrderCents = 0) {
  if (!clientRefId) return null;
  const situacao = await creditStatus(clientRefId, newOrderCents);
  if (!situacao.ok) throw new CreditLimitExceededError(situacao);
  return situacao;
}

module.exports = {
  // Puros
  coversDate,
  periodsOverlap,
  resolveContract,
  zoneRateFor,
  applyContractToQuote,
  dueDateFrom,
  assessCredit,
  normalizeContract,
  normalizeZoneRates,
  // Use cases
  createContract,
  updateContract,
  listContracts,
  getContract,
  endContract,
  contractForClient,
  creditStatus,
  assertWithinCredit,
  // Constantes e erros
  ContractStatus,
  ContractValidationError,
  ContractNotFoundError,
  DuplicateContractCodeError,
  OverlappingContractError,
  CreditLimitExceededError,
};
