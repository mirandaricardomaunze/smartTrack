/**
 * @file server.js
 * @description Entry point do payments-service (porta 4003).
 *
 * Single Responsibility: registrar middlewares e routers — NADA MAIS.
 *
 * Estrutura de camadas:
 *   src/
 *   ├── api/               ← Router Express (HTTP mapping)
 *   ├── application/       ← Use Cases (fluxo de cobrança, webhook, conciliação)
 *   ├── domain/            ← Regras puras (entidade, retry policy)
 *   └── infrastructure/    ← Persistência, cliente de gateway, eventos
 *
 * SEGURANÇA: sem auth de utilizador aqui — este serviço vive em rede privada e
 * só é alcançado através do api-gateway (backend/README.md, regra 1).
 * O webhook é a exceção e valida a sua própria assinatura.
 */
'use strict';

require('dotenv').config();

const express        = require('express');
const paymentsRouter = require('./api/payments.router');
const { isSimulated } = require('./infrastructure/gateway.client');

const app = express();

// ─── Middlewares globais ──────────────────────────────────────────────────────
// Sem CORS: nenhum browser fala com este serviço diretamente.
app.use(express.json());

// ─── Registro de routers ──────────────────────────────────────────────────────
app.use('/', paymentsRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'payments-service',
    // Explícito: quem consome o health precisa de saber que não há gateway real.
    gateway:   isSimulated() ? 'simulated' : 'live',
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4003;

if (require.main === module) {
  app.listen(PORT, () => {
    console.info(`[payments-service] Rodando em http://localhost:${PORT}`);
    if (isSimulated()) {
      console.warn('[payments-service] ⚠️  Gateway SIMULADO — nenhuma cobrança real é feita.');
    }
    if (!process.env.PAYMENTS_WEBHOOK_SECRET) {
      console.warn('[payments-service] ⚠️  PAYMENTS_WEBHOOK_SECRET não definido — webhooks serão recusados.');
    }
  });
}

module.exports = app;
