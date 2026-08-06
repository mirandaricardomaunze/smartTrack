/**
 * @file rate-limit.js
 * @description Rate limiting simples, em memória (janela fixa por IP).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — rate limit no gateway)
 *
 * Sem dependências externas: adequado a um único processo (o monólito modular
 * corre numa instância). Para múltiplas instâncias, trocar por um store partilhado
 * (Redis) mantendo esta mesma interface de middleware.
 */
'use strict';

/**
 * Cria um middleware de rate limit por IP (janela fixa).
 *
 * @param {{ windowMs?: number, max?: number, message?: string }} [opts]
 * @returns {import('express').RequestHandler}
 */
function rateLimit(opts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max      = opts.max ?? 60;
  const message  = opts.message ?? 'Demasiados pedidos. Tente novamente mais tarde.';

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const hits = new Map();

  // Limpeza periódica das entradas expiradas — não segura o processo vivo.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const resetSecs = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSecs));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSecs));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

module.exports = { rateLimit };
