/**
 * @file server.js
 * @description Entry point do notifications-service (porta 4004).
 *
 * Single Responsibility: registrar middlewares e routers — NADA MAIS.
 *
 * Estrutura de camadas:
 *   src/
 *   ├── api/               ← Router Express (HTTP mapping)
 *   ├── application/       ← Use Cases (envio, preferências, dispositivos)
 *   ├── domain/            ← Regras puras (entidade, resolução de preferências)
 *   └── infrastructure/    ← Persistência e cliente FCM
 *
 * SEGURANÇA: sem auth aqui — vive em rede privada e só é alcançado através do
 * api-gateway (backend/README.md, regra 1).
 */
'use strict';

require('dotenv').config();

const express             = require('express');
const notificationsRouter = require('./api/notifications.router');
const { isSimulated }     = require('./infrastructure/fcm.client');

const app = express();

// ─── Middlewares globais ──────────────────────────────────────────────────────
// Sem CORS: nenhum browser fala com este serviço diretamente.
app.use(express.json());

// ─── Registro de routers ──────────────────────────────────────────────────────
app.use('/', notificationsRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'notifications-service',
    // Explícito: quem consome o health precisa de saber que não há FCM real.
    fcm:       isSimulated() ? 'simulated' : 'live',
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4004;

if (require.main === module) {
  app.listen(PORT, () => {
    console.info(`[notifications-service] Rodando em http://localhost:${PORT}`);
    if (isSimulated()) {
      console.warn('[notifications-service] ⚠️  FCM SIMULADO — nenhum push chega a um telemóvel.');
    }
  });
}

module.exports = app;
