/**
 * @file backup.policy.js
 * @description Regras puras das cópias de segurança — nomes e retenção.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * Isto está separado dos scripts de propósito: decidir **o que se apaga** é a
 * parte perigosa de um sistema de backup, e é a única que se pode testar sem
 * tocar em nenhuma base de dados. Um erro aqui apaga o histórico fiscal dos
 * clientes; um erro no `pg_dump` só falha ruidosamente.
 */
'use strict';

/**
 * Política por omissão: sete diárias, quatro semanais, seis mensais.
 * Cobre "apaguei ontem sem querer" (dias), "a corrupção passou despercebida uma
 * semana" (semanas) e a obrigação de arquivo (meses).
 */
const DEFAULT_POLICY = Object.freeze({ daily: 7, weekly: 4, monthly: 6 });

/** Prefixo dos ficheiros. O nome carrega a data para ser legível sem manifesto. */
const FILE_PREFIX = 'sistematrack';

/**
 * Nome do ficheiro de uma cópia. PURA.
 * `sistematrack-track-20260805T181500Z.dump`
 *
 * @param {string} database
 * @param {Date} [at]
 */
function backupFileName(database, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${FILE_PREFIX}-${database}-${stamp}.dump`;
}

/**
 * Extrai a data do nome do ficheiro. PURA.
 * @param {string} fileName
 * @returns {Date | null} null quando o nome não é nosso
 */
function parseBackupDate(fileName) {
  const match = /-(\d{8})T(\d{6})Z\.dump$/.exec(String(fileName ?? ''));
  if (!match) return null;
  const [, date, time] = match;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    + `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Chave do dia (AAAA-MM-DD) em UTC. */
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Chave da semana ISO (AAAA-Www) — agrupa por semana sem depender de locale. */
function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Quinta-feira da mesma semana define o ano ISO.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Chave do mês (AAAA-MM). */
function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

/**
 * Decide o que fica e o que sai. PURA.
 *
 * Guarda a cópia **mais recente** de cada dia, semana e mês, dentro dos limites
 * da política. Uma cópia pode ser guardada por mais de uma razão (a de hoje é
 * também a da semana e a do mês) — e nesse caso conta uma vez.
 *
 * Nomes que não reconhecemos são sempre mantidos: apagar um ficheiro que não
 * fomos nós a escrever não é decisão de um script de retenção.
 *
 * @param {string[]} fileNames
 * @param {{ daily?: number, weekly?: number, monthly?: number }} [policy]
 * @returns {{ keep: string[], remove: string[], unknown: string[], reasons: Record<string,string[]> }}
 */
function planRetention(fileNames = [], policy = {}) {
  const limits = { ...DEFAULT_POLICY, ...policy };

  const dated = [];
  const unknown = [];
  for (const name of fileNames) {
    const date = parseBackupDate(name);
    if (date) dated.push({ name, date });
    else unknown.push(name);
  }

  // Mais recente primeiro: dentro de cada grupo, a primeira é a que fica.
  dated.sort((a, b) => b.date - a.date);

  /** @type {Record<string,string[]>} */
  const reasons = {};
  const keep = new Set();
  const mark = (name, reason) => {
    keep.add(name);
    reasons[name] = [...(reasons[name] ?? []), reason];
  };

  for (const [label, keyOf, limit] of [
    ['diária', dayKey, limits.daily],
    ['semanal', weekKey, limits.weekly],
    ['mensal', monthKey, limits.monthly],
  ]) {
    const seen = new Set();
    for (const entry of dated) {
      if (seen.size >= limit) break;
      const key = keyOf(entry.date);
      if (seen.has(key)) continue;
      seen.add(key);
      mark(entry.name, `${label} ${key}`);
    }
  }

  return {
    keep: dated.filter((e) => keep.has(e.name)).map((e) => e.name),
    remove: dated.filter((e) => !keep.has(e.name)).map((e) => e.name),
    unknown,
    reasons,
  };
}

/**
 * Tabelas cujo número de linhas é comparado depois do restauro.
 * São as que doem a sério: documentos fiscais, auditoria e o dinheiro.
 */
const CRITICAL_TABLES = Object.freeze([
  'orders',
  'invoices',
  'document_series',
  'audit_events',
  'companies',
  'company_profiles',
  'subscriptions',
  'subscription_invoices',
  'driver_settlements',
  'users',
]);

/**
 * Compara o manifesto da cópia com o que existe depois do restauro. PURA.
 *
 * Uma cópia que restaura mas perde linhas não é uma cópia — é uma ilusão de
 * segurança. Daí a comparação ser explícita e por tabela.
 *
 * @param {Record<string, number>} expected
 * @param {Record<string, number>} actual
 * @returns {{ ok: boolean, differences: Array<{table:string, expected:number, actual:number}> }}
 */
function compareRowCounts(expected = {}, actual = {}) {
  const differences = [];
  for (const table of Object.keys(expected)) {
    const before = Number(expected[table] ?? 0);
    const after = Number(actual[table] ?? 0);
    if (before !== after) differences.push({ table, expected: before, actual: after });
  }
  return { ok: differences.length === 0, differences };
}

module.exports = {
  DEFAULT_POLICY,
  FILE_PREFIX,
  CRITICAL_TABLES,
  backupFileName,
  parseBackupDate,
  dayKey,
  weekKey,
  monthKey,
  planRetention,
  compareRowCounts,
};
