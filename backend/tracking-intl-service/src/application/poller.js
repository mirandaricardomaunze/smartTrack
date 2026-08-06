/**
 * @file poller.js
 * @description Agendador de background do rastreio internacional.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (rastreio por polling, não webhook)
 *
 * Corre `runPollingCycle` periodicamente sobre os códigos ativos. É opcional e
 * configurável por ambiente — o operador continua a poder disparar polling
 * manualmente pela UI/endpoints. Garantias:
 *   - não sobrepõe ciclos (uma corrida de cada vez);
 *   - `unref()` no timer para não segurar o processo (nem os testes) vivo;
 *   - erros de um ciclo são registados e não derrubam o agendador.
 *
 * Variáveis de ambiente (todas com default seguro):
 *   TRACKING_POLL_ENABLED       'false' desliga (default: ligado)
 *   TRACKING_POLL_INTERVAL_MS   intervalo entre ciclos (default: 300000 = 5 min)
 *   TRACKING_POLL_LIMIT         nº máx. de códigos por ciclo (default: 100)
 */
'use strict';

const { runPollingCycle } = require('./tracking.service');

const MIN_INTERVAL_MS = 10_000; // guarda inferior — evita martelar o banco/simulador

let timer = null;
let running = false; // impede sobreposição de ciclos

/**
 * Lê a configuração do agendador a partir do ambiente.
 * @returns {{ enabled: boolean, intervalMs: number, limit: number }}
 */
function readConfig() {
  const enabled = String(process.env.TRACKING_POLL_ENABLED ?? 'true').toLowerCase() !== 'false';
  const intervalMs = Math.max(MIN_INTERVAL_MS, Number(process.env.TRACKING_POLL_INTERVAL_MS) || 300_000);
  const limit = Math.max(1, Number(process.env.TRACKING_POLL_LIMIT) || 100);
  return { enabled, intervalMs, limit };
}

/**
 * Executa um ciclo, protegido contra sobreposição.
 * @param {number} limit
 * @returns {Promise<void>}
 */
async function tick(limit) {
  if (running) return; // ciclo anterior ainda a correr — salta este
  running = true;
  try {
    await runPollingCycle(limit);
  } catch (err) {
    console.error('[tracking.poller] Ciclo falhou:', err.message);
  } finally {
    running = false;
  }
}

/**
 * Arranca o agendador. Idempotente (se já estiver a correr, não duplica).
 *
 * @param {{ intervalMs?: number, limit?: number }} [overrides]
 * @returns {{ started: boolean, intervalMs?: number, limit?: number }}
 */
function startPolling(overrides = {}) {
  if (timer) return { started: true };

  const cfg = readConfig();
  const intervalMs = overrides.intervalMs ?? cfg.intervalMs;
  const limit = overrides.limit ?? cfg.limit;

  if (!cfg.enabled) {
    console.info('[tracking.poller] Desligado (TRACKING_POLL_ENABLED=false).');
    return { started: false };
  }

  timer = setInterval(() => { void tick(limit); }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.info(`[tracking.poller] Ligado — ciclo a cada ${Math.round(intervalMs / 1000)}s (limite ${limit}).`);
  return { started: true, intervalMs, limit };
}

/** Para o agendador. */
function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** @returns {boolean} */
function isRunning() {
  return timer !== null;
}

module.exports = { startPolling, stopPolling, isRunning, readConfig };
