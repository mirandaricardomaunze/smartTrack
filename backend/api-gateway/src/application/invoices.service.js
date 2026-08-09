/**
 * @file invoices.service.js
 * @description Camada de aplicação — faturação e documentos fiscais.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14 (Faturação)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Emite os documentos que a EMPRESA passa aos seus clientes. Cada documento é
 * numerado por série, assinado e encadeado no anterior (ver `fiscal.js`), com o
 * IVA discriminado por taxa. O valor do pedido é o total COM imposto incluído;
 * a base e o IVA (16% em MZ) são extraídos. Valores em centavos (MZN).
 *
 * Regras que aqui se impõem:
 *   - **Imutabilidade.** Depois de assinado, um documento não muda de valores —
 *     só de estado (pago/anulado). Corrigir faz-se com **nota de crédito**.
 *   - **Anulação.** Só é possível antes de o documento ser pago; fica no arquivo
 *     com o número e a assinatura (a sequência nunca ganha buracos) e com motivo.
 *   - **Isenção.** Linha a 0% obriga a código + motivo por extenso.
 */
'use strict';

const crypto = require('crypto');
const {
  InvoiceRepository, DocumentSeriesRepository, OrderRepository, ClientRepository, CompanyProfileRepository,
} = require('../infrastructure/pg.repository');
const { readCompanyId } = require('../infrastructure/tenant-context');
const fiscal = require('./fiscal');
const { buildSaftXml } = require('./saft');

const InvoiceStatus = Object.freeze({ ISSUED: 'issued', PAID: 'paid', VOID: 'void' });
const TAX_RATE_PCT = fiscal.DEFAULT_TAX_RATE_PCT;

// ─── Erros ───────────────────────────────────────────────────────────────────

class InvoiceValidationError extends Error {
  constructor(message) { super(message); this.name = 'InvoiceValidationError'; this.statusCode = 400; }
}
class InvoiceNotFoundError extends Error {
  constructor(id) { super(`Fatura não encontrada: ${id}`); this.name = 'InvoiceNotFoundError'; this.statusCode = 404; }
}
class OrderNotFoundError extends Error {
  constructor(id) { super(`Pedido não encontrado: ${id}`); this.name = 'OrderNotFoundError'; this.statusCode = 404; }
}

// ─── Emissor (cabeçalho fiscal do documento) ─────────────────────────────────

/** Emissor por omissão — usado sem empresa no contexto (testes, tarefas de fundo). */
function getIssuer() {
  return {
    name:    process.env.INVOICE_ISSUER_NAME    || 'SmartTrack Logística, Lda.',
    tax_id:  process.env.INVOICE_ISSUER_TAXID   || '400000000',
    address: process.env.INVOICE_ISSUER_ADDRESS || 'Av. 25 de Setembro, Maputo, Moçambique',
    city:    process.env.INVOICE_ISSUER_CITY    || 'Maputo',
    email:   process.env.INVOICE_ISSUER_EMAIL   || 'faturacao@smarttrack.co.mz',
  };
}

/**
 * Emissor efetivo: o perfil da EMPRESA em contexto (spec § 3.17), com o
 * emissor de ambiente como rede de segurança. Multiempresa: cada empresa emite
 * em nome próprio — o cabeçalho da fatura nunca pode ser o da plataforma.
 *
 * @returns {Promise<{name:string,tax_id:string,address?:string,city?:string,email?:string,phone?:string,website?:string,logo?:string,brand_color?:string,bank_details?:string,footer_note?:string}>}
 */
async function resolveIssuer() {
  const companyId = readCompanyId();
  const fallback = getIssuer();
  if (!companyId) return fallback;

  try {
    const profile = await CompanyProfileRepository.findByCompany(companyId);
    if (!profile) return fallback;
    return {
      name:         profile.legal_name || fallback.name,
      trade_name:   profile.trade_name,
      tax_id:       profile.tax_id || fallback.tax_id,
      address:      profile.address || fallback.address,
      city:         profile.city || fallback.city,
      country:      profile.country,
      phone:        profile.phone,
      email:        profile.email || fallback.email,
      website:      profile.website,
      logo:         profile.logo,
      brand_color:  profile.brand_color,
      bank_details: profile.bank_details,
      footer_note:  profile.footer_note,
    };
  } catch (err) {
    // A faturação não pode parar por causa do cabeçalho.
    console.error('[invoices.service] Falha a ler o perfil da empresa:', err.message);
    return fallback;
  }
}

/** Extrai base tributável + IVA de um total com imposto incluído. */
const splitTaxInclusive = fiscal.splitTaxInclusive;

// ─── Emissão ─────────────────────────────────────────────────────────────────

/**
 * Emite um documento fiscal a partir de linhas já descritas.
 * Uso interno das emissões (fatura de pedido, nota de crédito) — valida, calcula
 * o resumo de IVA e delega a numeração/assinatura ao repositório.
 *
 * @param {object} input
 * @returns {Promise<object>}
 */
async function issueDocument(input) {
  const issuer = await resolveIssuer();
  if (!fiscal.isValidNuit(issuer.tax_id)) {
    throw new InvoiceValidationError('NUIT do emissor inválido — defina INVOICE_ISSUER_TAXID com 9 dígitos.');
  }
  if (input.client_tax_id && !fiscal.isValidNuit(input.client_tax_id)) {
    throw new InvoiceValidationError('NUIT do cliente inválido — deve ter 9 dígitos.');
  }

  const items = (input.items ?? []).map((i) => fiscal.normalizeLine(i));
  if (items.length === 0) throw new InvoiceValidationError('O documento precisa de pelo menos uma linha.');

  const taxSummary = fiscal.buildTaxSummary(items);
  const totals = fiscal.totalsFromSummary(taxSummary);
  const series = fiscal.normalizeSeries(input.series);
  const docType = input.doc_type ?? fiscal.DocType.FT;

  return InvoiceRepository.createDocument(
    {
      id: crypto.randomUUID(),
      doc_type: docType,
      series,
      order_id:       input.order_id,
      tracking_code:  input.tracking_code,
      client_ref_id:  input.client_ref_id,
      client_name:    input.client_name,
      client_tax_id:  input.client_tax_id ? fiscal.normalizeNuit(input.client_tax_id) : undefined,
      client_email:   input.client_email,
      client_address: input.client_address,
      issuer_name:    issuer.name,
      issuer_tax_id:  fiscal.normalizeNuit(issuer.tax_id),
      items,
      tax_summary:    taxSummary,
      subtotal_cents: totals.subtotal_cents,
      // Compatibilidade: a taxa dominante do documento (o detalhe está em tax_summary).
      tax_rate_pct:   taxSummary[0]?.rate_pct ?? TAX_RATE_PCT,
      tax_cents:      totals.tax_cents,
      total_cents:    totals.total_cents,
      status:         input.status ?? InvoiceStatus.ISSUED,
      notes:          input.notes,
      due_date:       input.due_date,
      issued_by:      input.issued_by,
      related_invoice_id: input.related_invoice_id,
      related_number: input.related_number,
    },
    fiscal.signDocument,
    fiscal.formatDocumentNumber,
  );
}

/**
 * Emite (ou devolve, se já existir) a fatura do frete de um pedido.
 * @param {string} orderId
 * @param {{ notes?: string, series?: string, issued_by?: string }} [opts]
 */
async function createInvoiceForOrder(orderId, opts = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);

  const existing = await InvoiceRepository.findActiveByOrderId(orderId);
  if (existing) return existing; // idempotente — uma fatura ativa por pedido

  const tax = splitTaxInclusive(order.value, TAX_RATE_PCT);

  let client;
  if (order.client_ref_id) client = await ClientRepository.findById(order.client_ref_id);

  // Prazo de pagamento acordado (§ 3.35). Sem contrato, ou com prazo 0, a
  // fatura não leva vencimento: é uma fatura-recibo paga no ato, e datá-la com
  // o próprio dia da emissão faria qualquer mapa de dívida contá-la como
  // vencida na manhã seguinte.
  // `require` à chamada — `contracts.service` fecha um ciclo com o repositório.
  const contracts = require('./contracts.service');
  const contrato = order.client_ref_id ? await contracts.contractForClient(order.client_ref_id) : null;
  const due_date = contrato ? contracts.dueDateFrom(new Date().toISOString(), contrato.payment_terms_days) : null;

  return issueDocument({
    doc_type: fiscal.DocType.FT,
    series: opts.series,
    order_id: order.id,
    tracking_code: order.tracking_code,
    client_ref_id: order.client_ref_id,
    client_name: order.client_id,
    client_tax_id: client?.tax_id,
    client_email: order.client_email,
    client_address: client?.address ? [client.address.street, client.address.city].filter(Boolean).join(', ') : undefined,
    items: [{
      description: `Serviço de entrega — ${order.tracking_code}`,
      quantity: 1,
      unit_cents: tax.subtotal_cents,
      total_cents: tax.subtotal_cents,
      tax_rate_pct: TAX_RATE_PCT,
    }],
    notes: typeof opts.notes === 'string' && opts.notes.trim() ? opts.notes.trim().slice(0, 2000) : undefined,
    due_date,
    issued_by: opts.issued_by,
  });
}

/**
 * Emite uma **nota de crédito** que retifica um documento anterior — é esta a
 * forma legal de anular ou corrigir uma fatura já entregue ao cliente.
 * Total por omissão; `amount_cents` permite crédito parcial.
 *
 * @param {string} invoiceId
 * @param {{ reason: string, amount_cents?: number, issued_by?: string }} dto
 */
async function createCreditNote(invoiceId, dto = {}) {
  const original = await InvoiceRepository.findById(invoiceId);
  if (!original) throw new InvoiceNotFoundError(invoiceId);
  if (original.doc_type === fiscal.DocType.NC) {
    throw new InvoiceValidationError('Não se emite nota de crédito sobre outra nota de crédito.');
  }
  if (original.status === InvoiceStatus.VOID) {
    throw new InvoiceValidationError('O documento está anulado — não há nada a creditar.');
  }

  const reason = String(dto.reason ?? '').trim();
  if (reason.length < 5) throw new InvoiceValidationError('A nota de crédito exige o motivo da retificação.');

  const creditable = original.total_cents - original.credited_cents;
  if (creditable <= 0) throw new InvoiceValidationError('O documento já foi creditado na totalidade.');

  const requested = dto.amount_cents === undefined ? creditable : Math.round(Number(dto.amount_cents));
  if (!Number.isFinite(requested) || requested <= 0) throw new InvoiceValidationError('Valor a creditar inválido.');
  if (requested > creditable) {
    throw new InvoiceValidationError(`Valor a creditar acima do disponível (${(creditable / 100).toFixed(2)} MZN).`);
  }

  // Crédito proporcional: mantém a mesma repartição por taxa do documento original.
  const ratio = requested / original.total_cents;
  const items = (original.items ?? []).map((line) => ({
    ...line,
    total_cents: Math.round(line.total_cents * ratio),
    unit_cents: Math.round(line.unit_cents * ratio),
  })).filter((line) => line.total_cents > 0);

  const note = await issueDocument({
    doc_type: fiscal.DocType.NC,
    series: original.series,
    order_id: original.order_id,
    tracking_code: original.tracking_code,
    client_ref_id: original.client_ref_id,
    client_name: original.client_name,
    client_tax_id: original.client_tax_id,
    client_email: original.client_email,
    client_address: original.client_address,
    items,
    notes: reason.slice(0, 2000),
    issued_by: dto.issued_by,
    related_invoice_id: original.id,
    related_number: original.number,
  });

  await InvoiceRepository.addCredited(original.id, note.total_cents);
  return note;
}

// ─── Consulta ────────────────────────────────────────────────────────────────

async function getInvoice(id) {
  const invoice = await InvoiceRepository.findById(id);
  if (!invoice) throw new InvoiceNotFoundError(id);
  return { ...invoice, issuer: await resolveIssuer(), software: fiscal.SOFTWARE };
}

async function listInvoices(opts = {}) {
  const page = Math.max(Number(opts.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 20, 1), 100);
  const status = opts.status && Object.values(InvoiceStatus).includes(opts.status) ? opts.status : undefined;
  const docType = opts.doc_type && fiscal.DocType[opts.doc_type] ? opts.doc_type : undefined;
  const { items, total } = await InvoiceRepository.list({
    status, doc_type: docType, search: opts.search, limit: pageSize, offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize };
}

async function getStats() {
  return InvoiceRepository.getStats();
}

// ─── Estado do documento ─────────────────────────────────────────────────────

/** Marca a fatura como paga (fatura-recibo). */
async function markPaid(id, dto = {}) {
  const invoice = await InvoiceRepository.findById(id);
  if (!invoice) throw new InvoiceNotFoundError(id);
  if (invoice.status === InvoiceStatus.VOID) throw new InvoiceValidationError('Não é possível pagar uma fatura anulada.');
  if (invoice.doc_type === fiscal.DocType.NC) throw new InvoiceValidationError('Uma nota de crédito não se paga — reembolsa-se.');
  if (invoice.status === InvoiceStatus.PAID) return invoice; // idempotente
  return InvoiceRepository.update(id, {
    status: InvoiceStatus.PAID,
    payment_method: dto.payment_method ?? null,
    paid_at: new Date().toISOString(),
  });
}

/**
 * Best-effort: marca paga a fatura ativa de um pedido (usado ao cobrar COD).
 * Nunca lança — devolve a fatura atualizada ou null.
 */
async function markPaidForOrder(orderId, paymentMethod) {
  try {
    const invoice = await InvoiceRepository.findActiveByOrderId(orderId);
    if (!invoice || invoice.status !== InvoiceStatus.ISSUED) return null;
    return await markPaid(invoice.id, { payment_method: paymentMethod });
  } catch {
    return null;
  }
}

/**
 * Anula o documento. Fiscalmente só é aceitável antes de haver pagamento: o
 * documento permanece no arquivo (com número, assinatura e motivo) para a
 * sequência não ganhar buracos. Depois de pago, corrige-se com nota de crédito.
 */
async function voidInvoice(id, dto = {}) {
  const invoice = await InvoiceRepository.findById(id);
  if (!invoice) throw new InvoiceNotFoundError(id);
  if (invoice.status === InvoiceStatus.PAID) {
    throw new InvoiceValidationError('Não é possível anular uma fatura já paga — emita uma nota de crédito.');
  }
  if (invoice.status === InvoiceStatus.VOID) return invoice;
  return InvoiceRepository.update(id, {
    status: InvoiceStatus.VOID,
    voided_at: new Date().toISOString(),
    void_reason: dto.reason ? String(dto.reason).trim().slice(0, 300) : 'Anulado pelo emissor',
  });
}

// ─── Obrigações fiscais ──────────────────────────────────────────────────────

/** Converte 'AAAA-MM' (ou um par de datas) num intervalo [from, to). */
function resolvePeriod(opts = {}) {
  if (opts.from && opts.to) {
    return { from: new Date(opts.from).toISOString(), to: new Date(opts.to).toISOString() };
  }
  const period = String(opts.period ?? fiscal.taxPeriod(new Date().toISOString()));
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new InvoiceValidationError('Período inválido — use AAAA-MM.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new InvoiceValidationError('Mês inválido no período.');
  return {
    from: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    to: new Date(Date.UTC(year, month, 1)).toISOString(),
    period,
  };
}

/**
 * Mapa de IVA do período — base tributável e imposto por taxa, com as notas de
 * crédito subtraídas. É o resumo que alimenta a declaração periódica.
 */
async function getTaxReport(opts = {}) {
  const range = resolvePeriod(opts);
  const [lines, byType, issuer] = await Promise.all([
    InvoiceRepository.getTaxSummaryForPeriod(range),
    InvoiceRepository.countByTypeForPeriod(range),
    resolveIssuer(),
  ]);

  const totals = lines.reduce(
    (acc, l) => ({ base_cents: acc.base_cents + l.base_cents, tax_cents: acc.tax_cents + l.tax_cents }),
    { base_cents: 0, tax_cents: 0 },
  );

  return {
    period: range.period ?? `${range.from.slice(0, 10)}..${range.to.slice(0, 10)}`,
    from: range.from,
    to: range.to,
    issuer,
    lines: lines.map((l) => ({
      ...l,
      label: l.rate_pct === 0
        ? `Isento (${fiscal.EXEMPTION_LABEL[l.exemption_code] ?? l.exemption_code ?? 'sem código'})`
        : `IVA ${l.rate_pct}%`,
    })),
    documents: byType.map((d) => ({ ...d, label: fiscal.DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type })),
    totals: { ...totals, gross_cents: totals.base_cents + totals.tax_cents },
  };
}

/** Ficheiro de auditoria (SAF-T) do período. */
async function exportSaft(opts = {}) {
  const range = resolvePeriod(opts);
  const [invoices, issuer] = await Promise.all([
    InvoiceRepository.listForPeriod(range),
    resolveIssuer(),
  ]);

  // Clientes referenciados no período (tabela MasterFiles do ficheiro).
  const seen = new Map();
  for (const inv of invoices) {
    const id = inv.client_ref_id ?? 'consumidor-final';
    if (!seen.has(id)) {
      seen.set(id, { id, name: inv.client_name, tax_id: inv.client_tax_id, address: inv.client_address });
    }
  }

  const xml = buildSaftXml({
    issuer,
    period: range,
    invoices,
    customers: [...seen.values()],
  });

  return {
    filename: `SAFT_${(range.period ?? 'periodo').replace(/-/g, '')}.xml`,
    documents: invoices.length,
    xml,
  };
}

/**
 * Verifica a inviolabilidade: recalcula a assinatura de cada documento, confirma
 * o encadeamento e procura saltos na numeração — por série.
 */
async function verifyIntegrity() {
  const chains = await InvoiceRepository.listChains();
  const results = [];

  for (const chain of chains) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await InvoiceRepository.listChainDocuments(chain.doc_type, chain.series);
    const result = fiscal.verifyChain(docs);
    results.push({
      doc_type: chain.doc_type,
      series: chain.series,
      label: fiscal.DOC_TYPE_LABEL[chain.doc_type] ?? chain.doc_type,
      ...result,
    });
  }

  return {
    ok: results.every((r) => r.ok),
    checked_at: new Date().toISOString(),
    software: fiscal.SOFTWARE,
    chains: results,
  };
}

// ─── Séries ──────────────────────────────────────────────────────────────────

async function listSeries(year) {
  return DocumentSeriesRepository.list(Number(year) || new Date().getUTCFullYear());
}

async function createSeries(dto = {}) {
  const docType = String(dto.doc_type ?? '').toUpperCase();
  if (!fiscal.DocType[docType]) {
    throw new InvoiceValidationError(`Tipo de documento inválido (${Object.keys(fiscal.DocType).join(', ')}).`);
  }
  return DocumentSeriesRepository.ensure({
    doc_type: docType,
    series: fiscal.normalizeSeries(dto.series),
    year: Number(dto.year) || new Date().getUTCFullYear(),
  });
}

module.exports = {
  // Emissão
  issueDocument,
  createInvoiceForOrder,
  createCreditNote,
  // Consulta
  getInvoice,
  listInvoices,
  getStats,
  // Estado
  markPaid,
  markPaidForOrder,
  voidInvoice,
  // Obrigações fiscais
  getTaxReport,
  exportSaft,
  verifyIntegrity,
  resolvePeriod,
  // Séries
  listSeries,
  createSeries,
  // Emissor e utilitários
  getIssuer,
  resolveIssuer,
  splitTaxInclusive,
  TAX_RATE_PCT,
  InvoiceStatus,
  DocType: fiscal.DocType,
  InvoiceValidationError,
  InvoiceNotFoundError,
  OrderNotFoundError,
};
