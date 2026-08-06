/**
 * @file audit.service.js
 * @description Registo de auditoria — quem fez o quê, quando e de onde.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * Três decisões estruturam este módulo:
 *
 *   1. **Captura automática.** Um middleware regista TODAS as requisições que
 *      alteram estado (POST/PUT/PATCH/DELETE), incluindo as recusadas. Assim a
 *      cobertura não depende de alguém se lembrar de chamar o registo em cada
 *      caso de uso novo — e os módulos que já existiam ficaram cobertos sem lhes
 *      tocar. Os casos de uso importantes acrescentam por cima um evento
 *      explícito, com contexto de negócio (`record`).
 *
 *   2. **Nunca partir a operação.** Uma falha a escrever no registo não pode
 *      impedir uma entrega ou uma fatura: os erros são apanhados e contados
 *      (`getHealth`), nunca propagados. O contador existe justamente para a
 *      falha não passar despercebida.
 *
 *   3. **Append-only e encadeado.** Não há UPDATE nem DELETE em lado nenhum.
 *      Cada evento é assinado com o hash do anterior DA MESMA EMPRESA, pelo que
 *      alterar ou apagar uma linha parte a cadeia e o relatório denuncia. É o
 *      mesmo mecanismo dos documentos fiscais (§ 3.19).
 *
 * O que NÃO se guarda, de propósito: corpos de requisição. Trazem senhas,
 * fotografias de comprovativo e assinaturas; o valor de auditoria é baixo e o
 * risco é alto. O contexto vai em `metadata`, curado por quem regista.
 */
'use strict';

const crypto = require('crypto');
const { AuditRepository } = require('../infrastructure/pg.repository');
const { readCompanyId, DEFAULT_COMPANY_ID } = require('../infrastructure/tenant-context');

/** Resultado do evento. */
const Outcome = Object.freeze({ SUCCESS: 'success', DENIED: 'denied', ERROR: 'error' });

/** Chaves que nunca entram no registo, venham de onde vierem. */
const REDACTED_KEYS = [
  'password', 'senha', 'password_hash', 'token', 'authorization', 'secret',
  'signature', 'photo', 'code', 'code_hash', 'otp', 'msisdn', 'logo',
];

const MAX_METADATA_CHARS = Number(process.env.AUDIT_METADATA_MAX_CHARS) || 4000;

/** Contadores de saúde do próprio registo (ver decisão 2). */
const health = { recorded: 0, failed: 0, last_error: null, last_failure_at: null };

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Remove segredos e corta o que for grande demais. PURA.
 * Aplica-se em profundidade: um segredo escondido dentro de um objeto aninhado
 * é tão mau como um à superfície.
 *
 * @param {unknown} value
 * @param {number} [depth]
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return undefined;
  if (depth > 4) return '[profundo]';

  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (REDACTED_KEYS.some((k) => key.toLowerCase().includes(k))) { out[key] = '[oculto]'; continue; }
      const clean = redact(raw, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }

  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return value;
}

/** Serializa os metadados com teto de tamanho. PURA. */
function packMetadata(metadata) {
  const clean = redact(metadata ?? {}) ?? {};
  const json = JSON.stringify(clean);
  return json.length <= MAX_METADATA_CHARS ? clean : { truncated: true, preview: json.slice(0, MAX_METADATA_CHARS) };
}

/**
 * Deriva a ação a partir do método e do caminho. PURA.
 * `POST /v1/orders` → `orders.create`; `POST /v1/invoices/:id/void` → `invoices.void`.
 *
 * @param {string} method
 * @param {string} path
 */
function deriveAction(method, path) {
  const parts = String(path || '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'v1') parts.shift();
  if (parts.length === 0) return 'http.request';

  const resource = parts[0];
  // Segmentos que não parecem identificadores descrevem a operação: o último
  // deles é o melhor nome (…/invoices/{id}/void → "void").
  const words = parts.slice(1).filter((p) => /^[a-z][a-z-]*$/.test(p) && !/^(me|stats|summary)$/.test(p));
  const verbFromPath = words.length ? words[words.length - 1].replace(/-/g, '_') : null;

  const byMethod = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
  return `${resource}.${verbFromPath ?? byMethod[String(method).toUpperCase()] ?? 'request'}`;
}

/** Estado do evento a partir do código HTTP. PURA. */
function outcomeFromStatus(statusCode) {
  const code = Number(statusCode) || 0;
  if (code >= 500) return Outcome.ERROR;
  if (code === 401 || code === 403 || code === 402) return Outcome.DENIED;
  if (code >= 400) return Outcome.ERROR;
  return Outcome.SUCCESS;
}

/** Frase legível de omissão para os eventos capturados automaticamente. */
function describe({ action, actorEmail, outcome, statusCode }) {
  const who = actorEmail || 'visitante';
  const verdict = outcome === Outcome.DENIED ? 'sem permissão'
    : outcome === Outcome.ERROR ? `falhou (${statusCode})`
    : 'concluída';
  return `${who}: ${action} — ${verdict}`;
}

/** Texto canónico assinado. PURA — é o que a verificação recalcula. */
function canonicalize(event) {
  return [
    event.occurred_at, String(event.seq), event.company_id, event.action,
    event.actor_id ?? '', event.entity_type ?? '', event.entity_id ?? '',
    event.outcome, event.previous_hash,
  ].join('|');
}

/** Assinatura do evento. PURA. */
function signEvent(event) {
  return crypto.createHash('sha256').update(canonicalize(event), 'utf8').digest('base64');
}

/** Primeiro elo da cadeia de uma empresa. */
const GENESIS_HASH = '0';

/**
 * Recalcula a cadeia e procura buracos na sequência. PURA.
 * @param {object[]} events já ordenados por `seq`
 */
function verifyChain(events = []) {
  const broken = [];
  const gaps = [];
  let previousHash = GENESIS_HASH;
  let expectedSeq = null;

  for (const event of events) {
    if (expectedSeq !== null && Number(event.seq) !== expectedSeq) {
      gaps.push({ expected: expectedSeq, found: Number(event.seq) });
    }
    expectedSeq = Number(event.seq) + 1;

    if (signEvent(event) !== event.hash) {
      broken.push({ id: event.id, seq: Number(event.seq), reason: 'Assinatura não corresponde ao conteúdo do evento.' });
    } else if (event.previous_hash !== previousHash) {
      broken.push({ id: event.id, seq: Number(event.seq), reason: 'Encadeamento partido — não segue o evento anterior.' });
    }
    previousHash = event.hash;
  }

  return { ok: broken.length === 0 && gaps.length === 0, checked: events.length, broken, gaps };
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

/**
 * Regista um evento. **Nunca lança** — ver decisão 2 no cabeçalho.
 *
 * @param {object} input
 * @param {string} input.action
 * @param {string} input.summary
 * @param {object} [input.actor] `{ id, email, role }`
 * @param {string} [input.company_id] por omissão, a empresa do contexto
 * @param {string} [input.entity_type]
 * @param {string} [input.entity_id]
 * @param {string} [input.entity_label]
 * @param {object} [input.metadata]
 * @param {string} [input.outcome]
 * @param {object} [input.request] `{ method, path, ip, user_agent, request_id, status_code, duration_ms }`
 * @returns {Promise<object|null>} o evento gravado, ou null se falhou
 */
async function record(input = {}) {
  try {
    const companyId = input.company_id ?? readCompanyId() ?? DEFAULT_COMPANY_ID;
    const request = input.request ?? {};

    const event = await AuditRepository.append({
      id: crypto.randomUUID(),
      company_id: companyId,
      actor_id: input.actor?.id ?? null,
      actor_email: input.actor?.email ?? null,
      actor_role: input.actor?.role ?? null,
      action: input.action,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      entity_label: input.entity_label ?? null,
      summary: input.summary,
      metadata: packMetadata(input.metadata),
      outcome: input.outcome ?? Outcome.SUCCESS,
      status_code: request.status_code ?? null,
      method: request.method ?? null,
      path: request.path ?? null,
      ip: request.ip ?? null,
      user_agent: request.user_agent ? String(request.user_agent).slice(0, 300) : null,
      request_id: request.request_id ?? null,
      duration_ms: request.duration_ms ?? null,
    }, signEvent, GENESIS_HASH);

    health.recorded += 1;
    return event;
  } catch (err) {
    health.failed += 1;
    health.last_error = err.message;
    health.last_failure_at = new Date().toISOString();
    console.error('[audit] Falha ao registar evento:', err.message);
    return null;
  }
}

// ─── Middleware de captura automática ────────────────────────────────────────

/** Rotas que não interessa auditar (ruído puro). */
const IGNORED_PATHS = [/^\/health$/, /^\/v1\/users\/me\/location$/];

/** Métodos que alteram estado. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Middleware que regista as requisições que alteram estado.
 *
 * Corre no fim da resposta (evento `finish`) porque só aí se conhecem o código
 * HTTP e o `req.user` — a autenticação acontece dentro de cada router, depois
 * deste middleware. Se o caso de uso já registou um evento explícito
 * (`req.auditRecorded = true`), este não duplica.
 */
function auditRequests() {
  return function auditRequestMiddleware(req, res, next) {
    if (!MUTATING.has(req.method) || IGNORED_PATHS.some((re) => re.test(req.path))) return next();

    const startedAt = Date.now();
    // Correlaciona o evento com os logs do pedido.
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);

    res.on('finish', () => {
      if (req.auditRecorded) return; // já houve evento explícito, com mais contexto

      const outcome = outcomeFromStatus(res.statusCode);
      const action = deriveAction(req.method, req.originalUrl || req.path);
      const actor = req.user ? { id: req.user.sub, email: req.user.email, role: req.user.role } : undefined;

      void record({
        action,
        summary: describe({ action, actorEmail: actor?.email, outcome, statusCode: res.statusCode }),
        actor,
        company_id: req.user?.company_id ?? undefined,
        entity_id: req.params?.id ?? undefined,
        outcome,
        request: {
          method: req.method,
          path: (req.originalUrl || req.path).split('?')[0],
          ip: req.ip,
          user_agent: req.headers['user-agent'],
          request_id: req.requestId,
          status_code: res.statusCode,
          duration_ms: Date.now() - startedAt,
        },
      });
    });

    return next();
  };
}

/**
 * Regista um evento de negócio a partir de um handler, marcando a requisição
 * para o middleware não duplicar. Usar quando há contexto que só o caso de uso
 * conhece (número da fatura, motivo da anulação, plano escolhido).
 */
async function recordFromRequest(req, input = {}) {
  req.auditRecorded = true;
  return record({
    ...input,
    actor: req.user ? { id: req.user.sub, email: req.user.email, role: req.user.role } : undefined,
    company_id: input.company_id ?? req.user?.company_id ?? undefined,
    request: {
      method: req.method,
      path: (req.originalUrl || req.path).split('?')[0],
      ip: req.ip,
      user_agent: req.headers?.['user-agent'],
      request_id: req.requestId,
      status_code: input.status_code,
    },
  });
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Lista eventos com filtros e paginação.
 * @param {{ from?: string, to?: string, action?: string, actor?: string, entity_type?: string, entity_id?: string, outcome?: string, search?: string, page?: number, pageSize?: number }} [opts]
 */
async function listEvents(opts = {}) {
  const page = Math.max(Number(opts.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 25, 1), 200);
  const { items, total } = await AuditRepository.list({
    ...opts,
    outcome: Object.values(Outcome).includes(opts.outcome) ? opts.outcome : undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return { items, total, page, pageSize };
}

/** Resumo para o cabeçalho da página: volume, recusas e atores. */
async function getStats(opts = {}) {
  return AuditRepository.stats(opts);
}

/** Ações distintas presentes no registo — alimenta o filtro. */
async function listActions() {
  return AuditRepository.distinctActions();
}

/** Verifica a cadeia da empresa em contexto (ou de todas, para o SUPERADMIN). */
async function verifyIntegrity() {
  const companies = await AuditRepository.listCompanies();
  const chains = [];

  for (const companyId of companies) {
    // eslint-disable-next-line no-await-in-loop
    const events = await AuditRepository.listChain(companyId);
    chains.push({ company_id: companyId, ...verifyChain(events) });
  }

  return {
    ok: chains.every((c) => c.ok),
    checked_at: new Date().toISOString(),
    chains,
  };
}

/** Contadores do próprio registo — expõe falhas que de outro modo passavam. */
function getHealth() {
  return { ...health };
}

module.exports = {
  // Puros
  redact,
  packMetadata,
  deriveAction,
  outcomeFromStatus,
  describe,
  canonicalize,
  signEvent,
  verifyChain,
  GENESIS_HASH,
  // Escrita
  record,
  recordFromRequest,
  auditRequests,
  // Leitura
  listEvents,
  getStats,
  listActions,
  verifyIntegrity,
  getHealth,
  Outcome,
};
