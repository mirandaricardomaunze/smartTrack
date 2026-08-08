/**
 * @file monitoring.service.js
 * @description Métricas, registo central de erros e alertas acionáveis.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * PORQUÊ EXISTE: até aqui, saber que o sistema estava mal dependia de alguém
 * telefonar. O `/health` respondia `{status:'ok'}` sem tocar na base — respondia
 * `ok` com o PostgreSQL em baixo. Não havia forma de responder a "quantos 500
 * demos hoje", "porque é que aquele pedido falhou às 14h20", nem de reparar que
 * o provedor de email estava em modo simulado num servidor de produção.
 *
 * Três peças, com fronteiras deliberadas:
 *
 *   1. **Métricas** — contadores em memória do processo. Reiniciam quando o
 *      processo reinicia, e isso está certo: servem para responder "como está
 *      agora", não para histórico. Histórico é trabalho do agente de recolha do
 *      servidor, que lê as linhas do logger.
 *
 *   2. **Registo de erros** — os 500 vão para uma tabela, com o id de
 *      correlação que o cliente recebeu no cabeçalho. É o que transforma "deu
 *      erro" numa queixa investigável. Só os inesperados: um 404 ou um 422 são
 *      respostas normais da API, não avarias.
 *
 *   3. **Alertas** — regras avaliadas a pedido sobre o estado real (base,
 *      erros, auditoria, provedores). Não há aqui nenhum ecrã de gráficos: um
 *      alerta ou diz o que fazer, ou não devia existir.
 *
 * NUNCA PARTE A OPERAÇÃO: como no registo de auditoria, uma falha a gravar um
 * erro é contada e engolida. O sistema de observação não pode ser a causa da
 * indisponibilidade que observa.
 */
'use strict';

const crypto = require('crypto');
const pool = require('../infrastructure/db');
const { logger } = require('../infrastructure/logger');
const { getCorrelationId, writeCompanyId, readCompanyId } = require('../infrastructure/tenant-context');

/** Fronteiras dos baldes de latência, em milissegundos. */
const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000];

/** Janela de erros considerada pelos alertas. */
const ERROR_WINDOW_MS = Number(process.env.MONITORING_ERROR_WINDOW_MS) || 15 * 60_000;

/** Taxa de erro (0–1) a partir da qual o alerta dispara. */
const ERROR_RATE_THRESHOLD = Number(process.env.MONITORING_ERROR_RATE_THRESHOLD) || 0.05;

/** Abaixo deste número de pedidos, a taxa não tem significado estatístico. */
const ERROR_RATE_MIN_SAMPLE = Number(process.env.MONITORING_ERROR_RATE_MIN_SAMPLE) || 20;

// ─── Estado em memória ───────────────────────────────────────────────────────

/**
 * @typedef {{ count: number, errors: number, total_ms: number, max_ms: number, buckets: number[] }} RouteStat
 */

const state = {
  started_at: new Date().toISOString(),
  /** @type {Map<string, RouteStat>} */
  routes: new Map(),
  status_classes: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  /** Marcas temporais recentes: [timestampMs, éErro]. Usadas pela taxa. */
  recent: [],
  /** Saúde do próprio registo de erros. */
  sink: { recorded: 0, failed: 0, last_error: null },
};

/** Só os últimos N pedidos entram na janela — a memória não pode crescer sem fim. */
const RECENT_MAX = 5_000;

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Nome estável da rota para agregação.
 *
 * Agrupar por caminho cru daria uma linha por encomenda (`/v1/orders/ord-1`,
 * `/v1/orders/ord-2`, …) e o mapa cresceria sem limite — é o padrão de
 * cardinalidade que faz uma métrica ficar inútil e cara ao mesmo tempo. Quando
 * o Express identificou a rota, usa-se o molde dele (`/v1/orders/:id`); quando
 * não identificou (404), agrupa-se tudo em `unmatched`.
 *
 * PURA.
 *
 * @param {{ method?: string, baseUrl?: string, route?: { path?: string } }} req
 * @returns {string}
 */
function routeKey(req) {
  const metodo = String(req?.method ?? 'GET').toUpperCase();
  const molde  = req?.route?.path;
  if (!molde) return `${metodo} unmatched`;
  const base = String(req.baseUrl ?? '');
  const caminho = `${base}${molde === '/' ? '' : molde}` || '/';
  return `${metodo} ${caminho}`;
}

/**
 * Índice do balde de latência a que um tempo pertence. PURA.
 * @param {number} ms
 * @returns {number}
 */
function bucketIndex(ms) {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i += 1) {
    if (ms <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length; // "+Inf"
}

/**
 * Percentil aproximado a partir dos baldes. PURA.
 *
 * Devolve o TETO do balde onde o percentil cai — é uma aproximação e é dita
 * como tal (`p95_ms_at_most`). Guardar todas as amostras para um percentil
 * exato custava memória proporcional ao tráfego, e para decidir "está lento?"
 * o teto do balde chega.
 *
 * @param {number[]} buckets Contagens por balde, incluindo o de +Inf.
 * @param {number} percentil 0–1
 * @returns {number|null} Milissegundos, ou null se não houver amostras.
 */
function percentileFromBuckets(buckets, percentil) {
  const total = buckets.reduce((soma, n) => soma + n, 0);
  if (total === 0) return null;

  const alvo = Math.ceil(total * percentil);
  let acumulado = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    acumulado += buckets[i];
    if (acumulado >= alvo) {
      return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i] : Infinity;
    }
  }
  return Infinity;
}

/**
 * Classe do estado HTTP: '2xx', '4xx', … PURA.
 * @param {number} status
 * @returns {string}
 */
function statusClass(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return '5xx';
  return `${Math.floor(n / 100)}xx`;
}

/**
 * Taxa de erro na janela. PURA.
 *
 * @param {Array<[number, boolean]>} recent
 * @param {number} agoraMs
 * @param {number} janelaMs
 * @returns {{ requests: number, errors: number, rate: number }}
 */
function errorRate(recent, agoraMs, janelaMs) {
  const desde = agoraMs - janelaMs;
  let pedidos = 0;
  let erros   = 0;
  for (const [ts, ehErro] of recent) {
    if (ts < desde) continue;
    pedidos += 1;
    if (ehErro) erros += 1;
  }
  return { requests: pedidos, errors: erros, rate: pedidos === 0 ? 0 : erros / pedidos };
}

// ─── Recolha ─────────────────────────────────────────────────────────────────

/**
 * Regista uma requisição concluída.
 *
 * @param {object} req
 * @param {number} status
 * @param {number} durationMs
 */
function observeRequest(req, status, durationMs) {
  const chave = routeKey(req);
  const stat = state.routes.get(chave) ?? {
    count: 0, errors: 0, total_ms: 0, max_ms: 0,
    buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
  };

  const ehErro = Number(status) >= 500;
  stat.count    += 1;
  stat.errors   += ehErro ? 1 : 0;
  stat.total_ms += durationMs;
  stat.max_ms    = Math.max(stat.max_ms, durationMs);
  stat.buckets[bucketIndex(durationMs)] += 1;
  state.routes.set(chave, stat);

  const classe = statusClass(status);
  state.status_classes[classe] = (state.status_classes[classe] ?? 0) + 1;

  state.recent.push([Date.now(), ehErro]);
  if (state.recent.length > RECENT_MAX) state.recent.splice(0, state.recent.length - RECENT_MAX);
}

/**
 * Grava um erro inesperado no registo central.
 *
 * Fail-open por desenho: se a escrita falhar (a base pode ser a própria avaria),
 * conta-se em `sink.failed` e segue-se. Quem consulta a saúde vê o contador.
 *
 * @param {Error} err
 * @param {{ method?: string, path?: string, status?: number, user_id?: string }} [ctx]
 * @returns {Promise<string|null>} Id do erro gravado, ou null se não gravou.
 */
async function recordError(err, ctx = {}) {
  const id = crypto.randomUUID();
  const correlacao = getCorrelationId();

  // O log sai sempre, mesmo que a base recuse — é a última rede.
  logger.error('Erro inesperado', {
    error_id: id,
    method:   ctx.method,
    path:     ctx.path,
    status:   ctx.status ?? 500,
    err,
  });

  try {
    await pool.query(`
      INSERT INTO error_events (
        id, company_id, correlation_id, occurred_at, method, path,
        status, error_name, message, stack, user_id
      ) VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9,$10)
    `, [
      id,
      writeCompanyId(),
      correlacao,
      ctx.method ?? null,
      ctx.path ?? null,
      ctx.status ?? 500,
      err?.name ?? 'Error',
      String(err?.message ?? '').slice(0, 2000),
      String(err?.stack ?? '').slice(0, 8000),
      ctx.user_id ?? null,
    ]);
    state.sink.recorded += 1;
    return id;
  } catch (falha) {
    state.sink.failed += 1;
    state.sink.last_error = falha.message;
    return null;
  }
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Fotografia das métricas do processo.
 * @returns {object}
 */
function getMetrics() {
  const rotas = [...state.routes.entries()]
    .map(([route, s]) => ({
      route,
      requests:       s.count,
      errors:         s.errors,
      avg_ms:         Math.round(s.total_ms / s.count),
      max_ms:         Math.round(s.max_ms),
      p95_ms_at_most: percentileFromBuckets(s.buckets, 0.95),
    }))
    .sort((a, b) => b.requests - a.requests);

  const janela = errorRate(state.recent, Date.now(), ERROR_WINDOW_MS);

  return {
    started_at:     state.started_at,
    uptime_seconds: Math.round(process.uptime()),
    status_classes: { ...state.status_classes },
    error_window: {
      window_minutes: Math.round(ERROR_WINDOW_MS / 60_000),
      ...janela,
    },
    latency_buckets_ms: [...LATENCY_BUCKETS_MS],
    routes: rotas,
    error_sink: { ...state.sink },
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

/**
 * Erros recentes da empresa em contexto, mais novos primeiro.
 *
 * O `stack` NÃO vem na listagem: é ruído no ecrã e caminho de ficheiros do
 * servidor no navegador de quem consulta. Vem no detalhe, por id.
 *
 * @param {{ limit?: number, since?: string }} [opts]
 * @returns {Promise<object[]>}
 */
async function listErrors(opts = {}) {
  const limite = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const params = [limite];
  const clauses = [];

  const empresa = readCompanyId();
  if (empresa) { params.push(empresa); clauses.push(`company_id = $${params.length}`); }
  if (opts.since) { params.push(opts.since); clauses.push(`occurred_at >= $${params.length}`); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT id, correlation_id, occurred_at, method, path, status, error_name, message, user_id
      FROM error_events
      ${where}
     ORDER BY occurred_at DESC
     LIMIT $1
  `, params);
  return rows;
}

/**
 * A base responde? Mede também quanto demorou — uma base que responde em 4
 * segundos está em baixo do ponto de vista de quem usa o painel.
 *
 * @returns {Promise<{ ok: boolean, latency_ms: number|null, error: string|null }>}
 */
async function checkDatabase() {
  const inicio = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latency_ms: Date.now() - inicio, error: null };
  } catch (err) {
    return { ok: false, latency_ms: null, error: err.message };
  }
}

/**
 * Alertas ativos.
 *
 * Cada regra devolve o que está mal E o que fazer. Um alerta sem ação é um
 * gráfico, e gráficos não acordam ninguém a horas.
 *
 * @param {{ auditHealth?: () => object, providers?: () => Array<{ name: string, simulated: boolean }> }} [deps]
 *   Injetáveis para o teste não precisar de montar o servidor inteiro.
 * @returns {Promise<{ status: 'ok'|'degraded'|'critical', alerts: object[] }>}
 */
async function getAlerts(deps = {}) {
  const alertas = [];

  const base = await checkDatabase();
  if (!base.ok) {
    alertas.push({
      key: 'database_unreachable',
      severity: 'critical',
      message: 'A base de dados não responde.',
      action: 'Verificar o serviço PostgreSQL e as credenciais do backend. Nenhuma operação é possível enquanto durar.',
      detail: { error: base.error },
    });
  } else if (base.latency_ms > 1000) {
    alertas.push({
      key: 'database_slow',
      severity: 'warning',
      message: `A base de dados demorou ${base.latency_ms} ms a responder a uma consulta trivial.`,
      action: 'Verificar carga, bloqueios e espaço em disco no servidor de base de dados.',
      detail: { latency_ms: base.latency_ms },
    });
  }

  const janela = errorRate(state.recent, Date.now(), ERROR_WINDOW_MS);
  if (janela.requests >= ERROR_RATE_MIN_SAMPLE && janela.rate > ERROR_RATE_THRESHOLD) {
    alertas.push({
      key: 'error_rate_high',
      severity: 'critical',
      message: `${(janela.rate * 100).toFixed(1)}% das requisições falharam com erro do servidor nos últimos ${Math.round(ERROR_WINDOW_MS / 60_000)} minutos.`,
      action: 'Consultar /v1/monitoring/errors e procurar pelo id de correlação da queixa mais recente.',
      detail: janela,
    });
  }

  if (state.sink.failed > 0) {
    alertas.push({
      key: 'error_sink_failing',
      severity: 'warning',
      message: `${state.sink.failed} erro(s) não puderam ser gravados no registo central.`,
      action: 'A causa costuma ser a mesma que provoca os erros. Confirmar que a tabela error_events existe (npm run migrate).',
      detail: { last_error: state.sink.last_error },
    });
  }

  if (typeof deps.auditHealth === 'function') {
    const auditoria = deps.auditHealth();
    if (auditoria?.failed > 0) {
      alertas.push({
        key: 'audit_write_failing',
        severity: 'critical',
        message: `${auditoria.failed} evento(s) de auditoria não foram gravados.`,
        action: 'O rasto de quem fez o quê tem furos. Corrigir antes de qualquer operação sensível (§ 3.21).',
        detail: { last_error: auditoria.last_error },
      });
    }
  }

  // Provedores simulados em produção: o sistema responde "enviado" e não sai
  // nada. É a falha mais cara porque não se manifesta como erro (§ 3.24).
  if (process.env.NODE_ENV === 'production' && typeof deps.providers === 'function') {
    const simulados = (deps.providers() ?? []).filter((p) => p.simulated);
    if (simulados.length > 0) {
      alertas.push({
        key: 'simulated_providers_in_production',
        severity: 'critical',
        message: `Em produção com provedor(es) simulado(s): ${simulados.map((p) => p.name).join(', ')}.`,
        action: 'Configurar as credenciais reais. Enquanto durar, o sistema regista envios que nunca chegam ao destinatário.',
        detail: { providers: simulados.map((p) => p.name) },
      });
    }
  }

  const status = alertas.some((a) => a.severity === 'critical') ? 'critical'
    : alertas.length > 0 ? 'degraded'
      : 'ok';

  return { status, alerts: alertas };
}

/** Zera os contadores. Existe para os testes; não é exposto por HTTP. */
function resetMetrics() {
  state.routes.clear();
  state.status_classes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  state.recent = [];
  state.sink = { recorded: 0, failed: 0, last_error: null };
  state.started_at = new Date().toISOString();
}

module.exports = {
  // Puros
  routeKey,
  bucketIndex,
  percentileFromBuckets,
  statusClass,
  errorRate,
  // Recolha
  observeRequest,
  recordError,
  // Leitura
  getMetrics,
  listErrors,
  checkDatabase,
  getAlerts,
  resetMetrics,
  // Constantes
  LATENCY_BUCKETS_MS,
  ERROR_WINDOW_MS,
  ERROR_RATE_THRESHOLD,
  ERROR_RATE_MIN_SAMPLE,
};
