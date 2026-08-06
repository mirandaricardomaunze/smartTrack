/**
 * @file server.js
 * @description Entry point do tracking-intl-service (porta 4005).
 *
 * Single Responsibility: registrar middlewares e routers — NADA MAIS.
 *
 * Estrutura de camadas:
 *   src/
 *   ├── api/               ← Router Express
 *   ├── application/       ← Use Cases (polling, normalização, dedup)
 *   ├── domain/            ← StatusMapper e EventoRastreio (puros)
 *   └── infrastructure/    ← Persistência e clientes de transportadora
 *
 * SEGURANÇA: sem auth aqui — rede privada, alcançado só pelo api-gateway.
 */
'use strict';

require('dotenv').config();

const express         = require('express');
const trackingRouter  = require('./api/tracking.router');
const { isSimulated } = require('./infrastructure/carrier.client');

const app = express();

// ─── Middlewares globais ──────────────────────────────────────────────────────
app.use(express.json());

// ─── Registro de routers ──────────────────────────────────────────────────────
app.use('/', trackingRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'tracking-intl-service',
    // Explícito: quem consome o health precisa de saber que não há API real.
    carriers:  isSimulated() ? 'simulated' : 'live',
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4005;

if (require.main === module) {
  app.listen(PORT, () => {
    console.info(`[tracking-intl-service] Rodando em http://localhost:${PORT}`);
    if (isSimulated()) {
      console.warn('[tracking-intl-service] ⚠️  Transportadoras SIMULADAS — nenhuma API real é consultada.');
    }
  });
}

module.exports = app;
