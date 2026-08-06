/**
 * @file server.js
 * @description Entry point do orders-service (porta 4001).
 *
 * Single Responsibility: registrar middlewares e routers — NADA MAIS.
 *
 * Estrutura de camadas:
 *   src/
 *   ├── api/               ← Router Express
 *   ├── application/       ← Use Cases (sync offline, regras de transição)
 *   ├── domain/            ← Resolução de conflitos e eventos (puros)
 *   └── infrastructure/    ← Persistência
 *
 * SEGURANÇA: sem auth aqui — rede privada, alcançado só pelo api-gateway.
 *
 * NOTA: a gestão de pedidos (criar, listar, rastrear) vive hoje no api-gateway.
 * Este serviço trata apenas do que é próprio do orders-service — a sincronização
 * offline com resolução de conflitos, que o gateway não fazia a sério.
 */
'use strict';

require('dotenv').config();

const express    = require('express');
const syncRouter = require('./api/sync.router');

const app = express();

app.use(express.json());
app.use('/', syncRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'orders-service', timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

const PORT = process.env.PORT ?? 4001;

if (require.main === module) {
  app.listen(PORT, () => {
    console.info(`[orders-service] Rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
