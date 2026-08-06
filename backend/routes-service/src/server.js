/**
 * @file server.js
 * @description Entry point do routes-service (porta 4002).
 *
 * Single Responsibility: registrar middlewares e routers — NADA MAIS.
 * Toda lógica de negócio vive em src/application/.
 * Todo acesso a dados vive em src/infrastructure/.
 * Todo mapeamento HTTP vive em src/api/.
 * Todas as regras puras de rota vivem em src/domain/.
 *
 * Estrutura de camadas:
 *   src/
 *   ├── api/               ← Router Express (HTTP mapping)
 *   │   └── routes.router.js
 *   ├── application/       ← Use Cases (lógica de negócio)
 *   │   └── routes.service.js
 *   ├── domain/            ← Regras puras, sem I/O
 *   │   ├── route.entity.js
 *   │   └── optimizer.js
 *   └── infrastructure/    ← Persistência (Repository Pattern)
 *       └── pg.repository.js
 *
 * SEGURANÇA: não há auth aqui de propósito — este serviço vive em rede privada
 * e só é alcançado através do api-gateway (backend/README.md, regra 1).
 */
'use strict';

require('dotenv').config();

const express      = require('express');
const routesRouter = require('./api/routes.router');

const app = express();

// ─── Middlewares globais ──────────────────────────────────────────────────────
// Sem CORS: nenhum browser fala com este serviço diretamente.
app.use(express.json());

// ─── Registro de routers ──────────────────────────────────────────────────────
app.use('/routes', routesRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'routes-service', timestamp: new Date().toISOString() });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4002;

// Não abrir porta quando importado por testes.
if (require.main === module) {
  app.listen(PORT, () => {
    console.info(`[routes-service] Rodando em http://localhost:${PORT}`);
    console.info('[routes-service] Camadas: api → application → domain/infrastructure');
  });
}

module.exports = app;
