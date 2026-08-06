/**
 * @file server.js
 * @description Entry point único do backend (monólito modular).
 *
 * Single Responsibility: registrar middlewares e routers — NADA MAIS.
 * Toda lógica de negócio vive em src/application/.
 * Todo acesso a dados vive em src/infrastructure/.
 * Todo mapeamento HTTP vive em src/api/.
 *
 * Estrutura de camadas:
 *   src/
 *   ├── api/               ← Routers Express (HTTP mapping)
 *   │   ├── orders.router.js
 *   │   └── drivers.router.js
 *   ├── application/       ← Use Cases (lógica de negócio)
 *   │   ├── orders.service.js
 *   │   ├── drivers.service.js
 *   │   └── order-status-shim.js
 *   └── infrastructure/    ← Persistência (Repository Pattern)
 *       └── json.repository.js
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Todos os módulos partilham a mesma base no processo único. Definir antes de
// carregar os routers impede que cada módulo aplique o seu default legado.
process.env.PGDATABASE = process.env.PGDATABASE || 'track';

const express      = require('express');
const cors         = require('cors');
const ordersRouter = require('./api/orders.router');
const driversRouter = require('./api/drivers.router');
const warehousesRouter = require('./api/warehouses.router');
const settlementsRouter = require('./api/settlements.router');
const messagingRouter = require('./api/messaging.router');
const reportsRouter = require('./api/reports.router');
const supportRouter = require('./api/support.router');
const clientsRouter = require('./api/clients.router');
const pricingRouter = require('./api/pricing.router');
const invoicesRouter = require('./api/invoices.router');
const companiesRouter = require('./api/companies.router');
const subscriptionsRouter = require('./api/subscriptions.router');
const auditRouter = require('./api/audit.router');
const authRouter = require('./api/auth.router');
const usersRouter = require('./api/users.router');
const hrRouter = require('./api/hr.router');
const hrOperationsRouter = require('./api/hr-operations.router');
const hrPortalRouter = require('./api/hr-portal.router');
const financeRouter = require('./api/finance.router');
const fleetRouter = require('./api/fleet.router');
const routesRouter = require('./api/routes.router');
const { paymentsRouter, webhookRouter } = require('./api/payments.router');
const notificationsRouter = require('./api/notifications.router');
const trackingRouter = require('./api/tracking.router');
const driverSyncRouter = require('./api/driver-sync.router');

// Agendador de background do rastreio internacional (polling — spec § 6).
const { startPolling } = require('../../tracking-intl-service/src/application/poller');
const { isSimulated: trackingSimulated } = require('../../tracking-intl-service/src/infrastructure/carrier.client');

// ─── Sync offline ─────────────────────────────────────────────────────────────
const { syncDriverEvents, MissingRequiredFieldError } = require('./application/orders.service');
const { rateLimit } = require('./infrastructure/rate-limit');
const { requireAuth, requireRoles, requireBodySubjectOrRoles, verifyToken } = require('./application/auth.service');
const { runWithCompany } = require('./infrastructure/tenant-context');
const { auditRequests } = require('./application/audit.service');

const app = express();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Atrás de um reverse proxy (Caddy/Nginx) — req.ip reflete o cliente real.
app.set('trust proxy', 1);

// ─── CORS ──────────────────────────────────────────────────────────────────────
// Origens permitidas via CORS_ORIGIN (lista separada por vírgulas). Sem a variável,
// reflete a origem (aberto) — aceitável em dev, mas avisado em produção.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (IS_PRODUCTION && CORS_ORIGINS.length === 0) {
  console.warn('[backend] AVISO: CORS_ORIGIN não definido em produção — CORS está aberto. Defina as origens do site do cliente e do painel.');
}
app.use(cors({
  origin: CORS_ORIGINS.length ? CORS_ORIGINS : true,
  credentials: true,
}));

// ─── Middlewares globais ───────────────────────────────────────────────────────
// POD pode conter assinatura + foto; o teto explícito continua a limitar abuso.
app.use(express.json({ limit: '7mb' }));

// Rate limit geral leve (defesa base) + estrito na autenticação (anti brute-force).
app.use(rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 300,
}));
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message: 'Demasiadas tentativas de autenticação. Aguarde um minuto.',
});

// ─── Contexto de empresa (multi-tenant, spec § 2.4) ────────────────────────────
// Resolve a empresa do JWT (best-effort — a autenticação estrita fica a cargo de
// requireAuth) e executa o resto da requisição nesse contexto. Rotas públicas e
// SUPERADMIN correm sem empresa (sem filtro de tenant).
app.use((req, _res, next) => {
  let companyId = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      if (!payload.exp || payload.exp >= Math.floor(Date.now() / 1000)) {
        companyId = payload.company_id ?? null;
      }
    } catch { /* token inválido/expirado — contexto sem empresa */ }
  }
  runWithCompany(companyId, () => next());
});

// ─── Auditoria (spec § 3.21) ───────────────────────────────────────────────────
// Regista todas as requisições que alteram estado, incluindo as recusadas.
// Depois do contexto de empresa (precisa dele) e antes dos routers, mas só
// escreve no fim da resposta — é aí que se conhecem o estado HTTP e o utilizador.
app.use(auditRequests());

// ─── Registro de routers ──────────────────────────────────────────────────────
app.use('/v1/auth',    authLimiter, authRouter);
app.use('/v1/users',   usersRouter);
app.use('/v1/hr',      hrRouter);
app.use('/v1/hr/operations', hrOperationsRouter);
app.use('/v1/hr/portal', hrPortalRouter);
app.use('/v1/finance', financeRouter);
app.use('/v1/fleet',   fleetRouter);
app.use('/v1/orders',  ordersRouter);
app.use('/v1/drivers', driversRouter);
app.use('/v1/warehouses', warehousesRouter);
app.use('/v1/settlements', settlementsRouter);
app.use('/v1/messaging', messagingRouter);
app.use('/v1/reports', reportsRouter);
app.use('/v1/support', supportRouter);
app.use('/v1/clients', clientsRouter);
app.use('/v1/pricing', pricingRouter);
app.use('/v1/invoices', invoicesRouter);
app.use('/v1/companies', companiesRouter);
app.use('/v1/subscriptions', subscriptionsRouter);
app.use('/v1/audit', auditRouter);
// Módulos internos — casos de uso carregados diretamente, sem saltos HTTP.
app.use('/v1/routes',  routesRouter);
app.use('/v1/payments', paymentsRouter);
app.use('/v1/notifications', notificationsRouter);
// Webhooks de terceiros: sem JWT, autenticados por assinatura no serviço a jusante
app.use('/v1/webhooks', webhookRouter);
app.use('/v1/tracking', trackingRouter);
app.use('/v1/driver-sync', driverSyncRouter);

// ─── Sync offline do app do motorista ────────────────────────────────────────
app.post('/v1/sync/driver-events', requireAuth, requireRoles(['ADMIN', 'DRIVER']), requireBodySubjectOrRoles(['ADMIN'], 'driver_id'), async (req, res) => {
  try {
    const result = await syncDriverEvents(req.body);
    res.json(result);
  } catch (err) {
    if (err instanceof MissingRequiredFieldError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[server] Erro inesperado no sync:', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    architecture: 'modular-monolith',
    modules: ['auth', 'orders', 'drivers', 'warehouses', 'routes', 'payments', 'notifications', 'tracking', 'driver-sync', 'hr'],
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
// Erros de guards e middlewares preservam o contrato JSON da API.
app.use((err, _req, res, _next) => {
  const status = Number(err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message });
  }
  console.error('[server] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
});

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.info(`[backend] Monólito modular em http://localhost:${PORT} (${IS_PRODUCTION ? 'produção' : 'desenvolvimento'})`);
  console.info(`[backend] Auth: contas de demonstração ${IS_PRODUCTION ? 'DESLIGADAS' : 'ligadas (dev)'} · CORS ${CORS_ORIGINS.length ? 'restrito' : 'aberto'}`);
  // Rastreio internacional: provedor + ciclo de polling em background.
  console.info(trackingSimulated()
    ? '[backend] Rastreio internacional: SIMULADO (defina TRACK17_API_KEY para o modo real 17TRACK).'
    : '[backend] Rastreio internacional: REAL via 17TRACK.');
  startPolling();
});
