/**
 * @file fiscal.js
 * @description Núcleo fiscal — regras puras de documentos, IVA e inviolabilidade.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Tudo neste ficheiro é PURO: sem base de dados, sem rede, sem relógio implícito
 * (a data entra sempre por argumento). É aqui que vivem as decisões que um
 * auditor verifica — numeração, assinatura encadeada, decomposição do IVA e o
 * motivo de isenção — para poderem ser testadas isoladamente.
 *
 * NOTA DE HONESTIDADE SOBRE A LEI:
 *   Este módulo implementa a MECÂNICA que a conformidade exige (documentos
 *   numerados sem saltos, imutáveis, encadeados por hash, com IVA discriminado
 *   por taxa e motivo de isenção obrigatório, mais exportação para auditoria).
 *   NÃO substitui a certificação do software pela Autoridade Tributária nem o
 *   parecer do contabilista: os textos legais das isenções são configuráveis
 *   precisamente porque devem citar a norma em vigor. O `SoftwareCertificateNumber`
 *   sai a `0` (não certificado) enquanto não houver número atribuído.
 */
'use strict';

const crypto = require('crypto');

// ─── Tipos de documento ───────────────────────────────────────────────────────
// A numeração e a cadeia de assinatura são independentes por (empresa, tipo, série).

const DocType = Object.freeze({
  /** Fatura — a liquidar depois. */
  FT: 'FT',
  /** Fatura-recibo — emitida já paga. */
  FR: 'FR',
  /** Nota de crédito — retifica a menos uma fatura anterior. */
  NC: 'NC',
  /** Nota de débito — retifica a mais uma fatura anterior. */
  ND: 'ND',
  /** Recibo — quitação de uma fatura emitida antes. */
  RC: 'RC',
});

const DOC_TYPE_LABEL = Object.freeze({
  FT: 'Fatura',
  FR: 'Fatura-recibo',
  NC: 'Nota de crédito',
  ND: 'Nota de débito',
  RC: 'Recibo',
});

/** Documentos que retificam outro — exigem referência ao documento de origem. */
const RECTIFYING_TYPES = Object.freeze([DocType.NC, DocType.ND]);

/** Sinal do documento no apuramento do IVA (a nota de crédito subtrai). */
function documentSign(docType) {
  return docType === DocType.NC ? -1 : 1;
}

// ─── IVA ──────────────────────────────────────────────────────────────────────

/** Taxa normal em Moçambique à data desta implementação (configurável). */
const DEFAULT_TAX_RATE_PCT = Number(process.env.INVOICE_TAX_RATE_PCT) || 16;

/**
 * Motivos de não liquidação do imposto. O CÓDIGO é interno (agrupa no mapa de
 * IVA e na exportação); o TEXTO é o que sai impresso no documento e deve citar
 * a norma aplicável — por isso é sempre obrigatório e nunca inventado aqui.
 */
const ExemptionCode = Object.freeze({
  ISENTO:       'ISENTO',
  EXPORTACAO:   'EXPORTACAO',
  NAO_SUJEITO:  'NAO_SUJEITO',
  AUTOLIQUIDACAO: 'AUTOLIQUIDACAO',
  OUTRO:        'OUTRO',
});

const EXEMPTION_LABEL = Object.freeze({
  ISENTO:         'Isento de IVA',
  EXPORTACAO:     'Exportação ou operação assimilada',
  NAO_SUJEITO:    'Operação não sujeita a IVA',
  AUTOLIQUIDACAO: 'IVA autoliquidado pelo adquirente',
  OUTRO:          'Outro motivo',
});

class FiscalValidationError extends Error {
  constructor(message) { super(message); this.name = 'FiscalValidationError'; this.statusCode = 400; }
}

// ─── NUIT ─────────────────────────────────────────────────────────────────────

/** Remove tudo o que não é dígito. */
function normalizeNuit(nuit) {
  return String(nuit ?? '').replace(/\D/g, '');
}

/**
 * O NUIT moçambicano tem 9 dígitos. Não é validado por dígito de controlo
 * (o algoritmo não é público), apenas pela forma — o suficiente para apanhar
 * gralhas antes de o documento ser assinado e ficar imutável.
 * @param {string} nuit
 * @returns {boolean}
 */
function isValidNuit(nuit) {
  return /^\d{9}$/.test(normalizeNuit(nuit));
}

// ─── Decomposição do IVA ──────────────────────────────────────────────────────

/**
 * Extrai base tributável e imposto de um total COM imposto incluído.
 * @param {number} grossCents
 * @param {number} [ratePct]
 */
function splitTaxInclusive(grossCents, ratePct = DEFAULT_TAX_RATE_PCT) {
  const gross = Math.max(0, Math.round(Number(grossCents) || 0));
  const rate = Number(ratePct) || 0;
  const base = Math.round((gross * 100) / (100 + rate));
  return { subtotal_cents: base, tax_cents: gross - base, total_cents: gross, tax_rate_pct: rate };
}

/**
 * Normaliza e valida uma linha do documento.
 * `total_cents` é SEMPRE a base tributável da linha (sem imposto); o imposto é
 * calculado a partir da taxa. Taxa 0 obriga a motivo de isenção — é o requisito
 * legal mais esquecido e por isso é imposto aqui, não na UI.
 *
 * @param {object} item
 * @returns {{description:string,quantity:number,unit_cents:number,total_cents:number,tax_rate_pct:number,tax_cents:number,exemption_code?:string,exemption_reason?:string}}
 */
function normalizeLine(item = {}) {
  const description = String(item.description ?? '').trim();
  if (!description) throw new FiscalValidationError('Cada linha do documento precisa de descrição.');

  const quantity = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
  const unit = Math.round(Number(item.unit_cents) || 0);
  const total = item.total_cents !== undefined ? Math.round(Number(item.total_cents)) : Math.round(unit * quantity);
  if (total < 0) throw new FiscalValidationError('O valor de uma linha não pode ser negativo.');

  const rate = item.tax_rate_pct === undefined || item.tax_rate_pct === null
    ? DEFAULT_TAX_RATE_PCT
    : Number(item.tax_rate_pct);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new FiscalValidationError('Taxa de IVA inválida.');
  }

  const line = {
    description,
    quantity,
    unit_cents: unit,
    total_cents: total,
    tax_rate_pct: rate,
    tax_cents: Math.round((total * rate) / 100),
  };

  if (rate === 0) {
    const code = String(item.exemption_code ?? '').trim().toUpperCase();
    const reason = String(item.exemption_reason ?? '').trim();
    if (!ExemptionCode[code]) {
      throw new FiscalValidationError(`Linha isenta sem código de isenção válido (${Object.keys(ExemptionCode).join(', ')}).`);
    }
    if (reason.length < 5) {
      throw new FiscalValidationError('Linha isenta exige o motivo por extenso, com a norma aplicável.');
    }
    line.exemption_code = code;
    line.exemption_reason = reason.slice(0, 300);
  }

  return line;
}

/**
 * Agrupa as linhas por taxa — é este resumo que alimenta o documento impresso,
 * o mapa de IVA e a exportação para auditoria.
 *
 * @param {object[]} items Linhas já normalizadas
 * @returns {Array<{rate_pct:number,base_cents:number,tax_cents:number,exemption_code?:string,exemption_reason?:string}>}
 */
function buildTaxSummary(items = []) {
  /** @type {Map<string, any>} */
  const byRate = new Map();

  for (const line of items) {
    const key = line.tax_rate_pct === 0 ? `0:${line.exemption_code ?? 'OUTRO'}` : String(line.tax_rate_pct);
    const entry = byRate.get(key) ?? {
      rate_pct: line.tax_rate_pct,
      base_cents: 0,
      tax_cents: 0,
      ...(line.tax_rate_pct === 0
        ? { exemption_code: line.exemption_code, exemption_reason: line.exemption_reason }
        : {}),
    };
    entry.base_cents += line.total_cents;
    entry.tax_cents += line.tax_cents;
    byRate.set(key, entry);
  }

  return [...byRate.values()].sort((a, b) => b.rate_pct - a.rate_pct);
}

/** Totais do documento a partir do resumo por taxa. */
function totalsFromSummary(summary = []) {
  const subtotal = summary.reduce((s, l) => s + l.base_cents, 0);
  const tax = summary.reduce((s, l) => s + l.tax_cents, 0);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

// ─── Assinatura encadeada (inviolabilidade) ──────────────────────────────────

/** Identificação do software que emite — sai no documento e na exportação. */
const SOFTWARE = Object.freeze({
  name: 'SmartTrack',
  version: process.env.FISCAL_SOFTWARE_VERSION || '1.0',
  /** 0 = software ainda não certificado pela AT. Nunca inventar um número. */
  certificate: process.env.FISCAL_SOFTWARE_CERTIFICATE || '0',
});

/** Primeiro documento de uma cadeia: encadeia a partir de um valor conhecido. */
const GENESIS_HASH = '0';

/**
 * Assina um documento encadeando-o no anterior da MESMA cadeia
 * (empresa + tipo + série). Alterar um documento antigo quebra todos os
 * seguintes — é isso que torna a sequência auditável.
 *
 * A cadeia usa SHA-256 sobre a string canónica
 * `data;dataHoraGravacao;numero;total;hashAnterior`. Quando existir chave
 * privada certificada pela AT, é aqui que a assinatura RSA entra, mantendo a
 * mesma string canónica.
 *
 * @param {{ issuedAt: string, signedAt: string, number: string, totalCents: number, previousHash?: string }} doc
 * @returns {{ hash: string, hash_control: string, previous_hash: string, signed_at: string }}
 */
function signDocument(doc) {
  const issuedDate = String(doc.issuedAt).slice(0, 10);          // AAAA-MM-DD
  const signedAt = String(doc.signedAt);
  const previous = doc.previousHash || GENESIS_HASH;
  const payload = `${issuedDate};${signedAt};${doc.number};${Math.round(doc.totalCents)};${previous}`;

  const hash = crypto.createHash('sha256').update(payload, 'utf8').digest('base64');
  return { hash, hash_control: hashControl(hash), previous_hash: previous, signed_at: signedAt };
}

/**
 * Os 4 caracteres impressos no documento (posições 1, 11, 21 e 31 do hash),
 * que permitem conferir o original em papel contra o arquivo digital.
 * @param {string} hash
 */
function hashControl(hash) {
  const h = String(hash ?? '');
  return [0, 10, 20, 30].map((i) => h[i] ?? '').join('');
}

/**
 * Reconstrói a cadeia e a sequência de uma série. PURA — recebe os documentos
 * já ordenados por sequência.
 *
 * @param {Array<{number:string,seq:number,issued_at:string,signed_at?:string,total_cents:number,hash?:string,previous_hash?:string}>} docs
 * @returns {{ ok: boolean, checked: number, unsigned: number, broken: Array<{number:string,reason:string}>, gaps: Array<{expected:number,found:number}> }}
 */
function verifyChain(docs = []) {
  const broken = [];
  const gaps = [];
  let unsigned = 0;
  let previousHash = GENESIS_HASH;
  let expectedSeq = null;

  for (const doc of docs) {
    if (expectedSeq !== null && doc.seq !== expectedSeq) {
      gaps.push({ expected: expectedSeq, found: doc.seq });
    }
    expectedSeq = doc.seq + 1;

    // Documentos anteriores à conformidade fiscal não têm assinatura: contam-se,
    // não se acusam como violados (não foram assinados na origem).
    if (!doc.hash || !doc.signed_at) {
      unsigned += 1;
      continue;
    }

    const expected = signDocument({
      issuedAt: doc.issued_at,
      signedAt: doc.signed_at,
      number: doc.number,
      totalCents: doc.total_cents,
      previousHash: doc.previous_hash,
    });

    if (expected.hash !== doc.hash) {
      broken.push({ number: doc.number, reason: 'Assinatura não corresponde ao conteúdo do documento.' });
    } else if (doc.previous_hash !== previousHash) {
      broken.push({ number: doc.number, reason: 'Encadeamento partido — não segue o documento anterior da série.' });
    }
    previousHash = doc.hash;
  }

  return { ok: broken.length === 0 && gaps.length === 0, checked: docs.length, unsigned, broken, gaps };
}

// ─── Numeração ────────────────────────────────────────────────────────────────

/** Série por omissão quando a empresa não define outra. */
const DEFAULT_SERIES = process.env.FISCAL_DEFAULT_SERIES || 'A';

/**
 * Formata o número legal do documento: `FT A2026/0001`.
 * O tipo, a série e o ano fazem parte do número — é o que garante que duas
 * séries em paralelo nunca colidem.
 */
function formatDocumentNumber(docType, series, year, seq) {
  return `${docType} ${series}${year}/${String(seq).padStart(4, '0')}`;
}

/** Valida o nome de uma série (curto, maiúsculas, sem espaços). */
function normalizeSeries(series) {
  const s = String(series ?? DEFAULT_SERIES).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(s)) {
    throw new FiscalValidationError('Série inválida — use 1 a 6 caracteres alfanuméricos (ex.: A, LOJA1).');
  }
  return s;
}

/** Período de tributação de uma data — 'AAAA-MM'. */
function taxPeriod(dateIso) {
  const d = new Date(dateIso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  DocType,
  DOC_TYPE_LABEL,
  RECTIFYING_TYPES,
  ExemptionCode,
  EXEMPTION_LABEL,
  DEFAULT_TAX_RATE_PCT,
  DEFAULT_SERIES,
  SOFTWARE,
  GENESIS_HASH,
  documentSign,
  normalizeNuit,
  isValidNuit,
  splitTaxInclusive,
  normalizeLine,
  buildTaxSummary,
  totalsFromSummary,
  signDocument,
  hashControl,
  verifyChain,
  formatDocumentNumber,
  normalizeSeries,
  taxPeriod,
  FiscalValidationError,
};
