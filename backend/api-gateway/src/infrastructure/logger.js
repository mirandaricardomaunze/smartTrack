/**
 * @file logger.js
 * @description Registo estruturado, com id de correlação e PII mascarada.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * PORQUÊ EXISTE: o backend escrevia com `console.info('[audit] ...')`. Numa
 * máquina só isso lê-se bem; num servidor com dois processos e um mês de
 * histórico, não há forma de responder a "o que aconteceu ao pedido X às 14h20"
 * senão a ler linhas à mão. E qualquer pessoa que escrevesse um email ou um
 * telefone na mensagem punha PII em texto limpo num ficheiro que fica anos.
 *
 * Uma linha por evento, em JSON, para stdout/stderr. Sem dependências: o que
 * uma biblioteca de logging traria a mais (transportes, rotação) é trabalho do
 * agente de recolha do servidor, não do processo.
 *
 * DECISÃO — porque não substituímos já todos os `console.*` do código: são
 * centenas, e trocá-los em bloco tornaria irrevisível qualquer alteração de
 * comportamento no meio. O caminho é este módulo passar a ser o usado nas
 * escritas novas e nas que se tocam, e o middleware de requisição — que é onde
 * está o volume — já escreve por aqui desde o primeiro dia.
 */
'use strict';

const { getCorrelationId, getCompanyId } = require('./tenant-context');

/** Ordem de severidade. `LOG_LEVEL` corta abaixo do nível escolhido. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const CONFIGURED_LEVEL = LEVELS[String(process.env.LOG_LEVEL || '').toLowerCase()]
  ?? (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);

/**
 * Chaves cujo VALOR nunca é escrito, esteja onde estiver.
 *
 * A lista espelha a do registo de auditoria de propósito: um segredo que não
 * pode entrar na auditoria também não pode entrar no log, e duas listas
 * diferentes seriam duas oportunidades de esquecer uma delas.
 */
const REDACTED_KEYS = [
  'password', 'senha', 'password_hash', 'token', 'authorization', 'secret',
  'signature', 'photo', 'code_hash', 'otp', 'api_key', 'private_key', 'logo',
];

/** Chaves cujo valor é PII: escrito, mas mascarado. */
const MASKED_KEYS = {
  email:        'EMAIL',
  client_email: 'EMAIL',
  phone:        'TELEFONE',
  client_phone: 'TELEFONE',
  msisdn:       'TELEFONE',
};

const { maskPII } = require('./privacy.utils');

/** Profundidade máxima — um objeto ciclíco não pode pendurar o processo. */
const MAX_DEPTH = 4;

/**
 * Limpa um valor para escrita: remove segredos, mascara PII, corta profundidade.
 * PURA.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[profundo]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [chave, val] of Object.entries(value)) {
      const baixa = chave.toLowerCase();
      if (REDACTED_KEYS.includes(baixa)) { out[chave] = '[removido]'; continue; }
      if (MASKED_KEYS[baixa] && typeof val === 'string') {
        out[chave] = maskPII(val, MASKED_KEYS[baixa]);
        continue;
      }
      out[chave] = sanitize(val, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Monta a linha de log. PURA — não escreve nada.
 *
 * Separada de `write` para o teste poder verificar o conteúdo sem capturar a
 * consola, e para o formato ser afirmável num só sítio.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [fields] Contexto estruturado.
 * @param {{ correlationId?: string|null, companyId?: string|null, at?: string }} [ctx]
 * @returns {object}
 */
function buildEntry(level, message, fields = {}, ctx = {}) {
  const entry = {
    at:      ctx.at ?? new Date().toISOString(),
    level,
    message: String(message),
  };

  const correlacao = ctx.correlationId !== undefined ? ctx.correlationId : getCorrelationId();
  if (correlacao) entry.correlation_id = correlacao;

  const empresa = ctx.companyId !== undefined ? ctx.companyId : getCompanyId();
  if (empresa) entry.company_id = empresa;

  const limpos = sanitize(fields);
  if (limpos && typeof limpos === 'object' && Object.keys(limpos).length > 0) {
    Object.assign(entry, limpos);
  }
  return entry;
}

/**
 * Escreve, se o nível o permitir.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [fields]
 */
function write(level, message, fields) {
  if (LEVELS[level] < CONFIGURED_LEVEL) return;
  const linha = JSON.stringify(buildEntry(level, message, fields));
  // warn/error para stderr: é o que a maioria dos agentes de recolha separa
  // por omissão, e é o que se quer ver primeiro num incidente.
  if (level === 'error' || level === 'warn') console.error(linha);
  else console.info(linha);
}

const logger = {
  debug: (message, fields) => write('debug', message, fields),
  info:  (message, fields) => write('info',  message, fields),
  warn:  (message, fields) => write('warn',  message, fields),
  error: (message, fields) => write('error', message, fields),
};

module.exports = { logger, buildEntry, sanitize, LEVELS, REDACTED_KEYS, MASKED_KEYS };
