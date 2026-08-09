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
const { randomUUID } = require('crypto');
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
const contractsRouter = require('./api/contracts.router');
const inventoryRouter = require('./api/inventory.router');
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
const monitoringRouter = require('./api/monitoring.router');

// Agendador de background do rastreio internacional (polling — spec § 6).
const { startPolling } = require('../../tracking-intl-service/src/application/poller');
const { isSimulated: trackingSimulated } = require('../../tracking-intl-service/src/infrastructure/carrier.client');

// ─── Sync offline ─────────────────────────────────────────────────────────────
const { syncDriverEvents, MissingRequiredFieldError } = require('./application/orders.service');
const { rateLimit } = require('./infrastructure/rate-limit');
const { requireAuth, requireRoles, requireBodySubjectOrRoles, verifyToken } = require('./application/auth.service');
const { runWithContext } = require('./infrastructure/tenant-context');
const { auditRequests, getHealth: auditHealth } = require('./application/audit.service');
const { logger } = require('./infrastructure/logger');
const monitoring = require('./application/monitoring.service');
const { listProviders } = require('./application/providers.status');

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

// ─── Contexto da requisição: empresa + correlação (spec § 2.4 e § 3.31) ────────
// Resolve a empresa do JWT (best-effort — a autenticação estrita fica a cargo de
// requireAuth) e executa o resto da requisição nesse contexto. Rotas públicas e
// SUPERADMIN correm sem empresa (sem filtro de tenant).
//
// O id de correlação entra aqui, no MESMO contexto e antes de tudo o resto:
// tem de estar disponível para o log, para a auditoria e para o registo de
// erros — ou seja, também para as requisições que falham no primeiro guard.
// Se o cliente (ou o reverse proxy) já mandou um `X-Request-Id`, respeita-se:
// é o que permite seguir um pedido desde o navegador até à linha do servidor.
app.use((req, res, next) => {
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

  const recebido = String(req.headers['x-request-id'] ?? '').trim();
  // Um id vindo de fora só é aceite se for curto e inócuo: entra em ficheiros
  // de log e numa coluna da base, e não vale a pena deixar um cliente escolher
  // o que lá fica.
  const correlationId = /^[A-Za-z0-9._-]{8,64}$/.test(recebido) ? recebido : randomUUID();

  req.correlationId = correlationId;
  res.setHeader('X-Request-Id', correlationId);

  runWithContext({ companyId, correlationId }, () => next());
});

// ─── Métricas por requisição (spec § 3.31) ────────────────────────────────────
// Mede no `finish` da resposta, que é o único momento em que se conhecem o
// estado HTTP e a rota que o Express acabou por escolher. Não escreve nada em
// disco nem na base: são contadores do processo.
app.use((req, res, next) => {
  const inicio = process.hrtime.bigint();
  res.once('finish', () => {
    const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
    monitoring.observeRequest(req, res.statusCode, duracaoMs);
  });
  next();
});

// ─── Auditoria (spec § 3.21) ───────────────────────────────────────────────────
// Regista todas as requisições que alteram estado, incluindo as recusadas.
// Depois do contexto de empresa (precisa dele) e antes dos routers, mas só
// escreve no fim da resposta — é aí que se conhecem o estado HTTP e o utilizador.
app.use(auditRequests());

// ─── Registro de routers ──────────────────────────────────────────────────────

// A disponibilidade da recuperação de senha (spec § 3.32) é consultada pela
// PÁGINA DE LOGIN a cada abertura, para não mostrar "Esqueci a senha" quando não
// há provedor de email configurado. Fica FORA do limitador estrito de /v1/auth
// de propósito: com vários postos atrás do mesmo IP, abrir o ecrã de entrada
// consumia o orçamento de tentativas e trancava quem tinha a senha certa.
app.get('/v1/auth/password-recovery', (_req, res) => {
  res.json(require('./application/password-reset.service').recoveryAvailability());
});

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
app.use('/v1/contracts', contractsRouter);
app.use('/v1/inventory', inventoryRouter);
app.use('/v1/pricing', pricingRouter);
app.use('/v1/invoices', invoicesRouter);
app.use('/v1/companies', companiesRouter);
app.use('/v1/subscriptions', subscriptionsRouter);
app.use('/v1/audit', auditRouter);
app.use('/v1/monitoring', monitoringRouter);
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
// Consultado pelo balanceador e pelo Docker: TEM de tocar na base. A versão
// anterior devolvia `{status:'ok'}` sem consultar nada, ou seja, respondia "ok"
// com o PostgreSQL em baixo — e o balanceador continuava a mandar tráfego para
// um processo que não conseguia servir uma única página.
//
// 503 quando a base não responde é o contrato que o balanceador percebe.
// Fica sem autenticação de propósito, e por isso não devolve detalhe nenhum
// além de estar de pé: o diagnóstico vive em /v1/monitoring, atrás de ADMIN.
app.get('/health', async (_req, res) => {
  const base = await monitoring.checkDatabase();
  res.status(base.ok ? 200 : 503).json({
    status: base.ok ? 'ok' : 'unavailable',
    architecture: 'modular-monolith',
    database: base.ok ? 'ok' : 'unreachable',
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado.' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
// Erros de guards e middlewares preservam o contrato JSON da API.
//
// Os 4xx são respostas normais e não vão para o registo de erros: um 404 ou um
// 422 é a API a fazer o seu trabalho. Só o inesperado é gravado — com o id de
// correlação DEVOLVIDO ao cliente, que é o que transforma "deu erro" numa
// queixa investigável sem expor a causa a quem não deve vê-la (§ 3.31).
app.use((err, req, res, _next) => {
  const status = Number(err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message });
  }

  // Sem `await`: a resposta ao cliente não espera pela gravação, e a gravação
  // nunca rejeita (fail-open no serviço).
  monitoring.recordError(err, {
    method:  req.method,
    path:    req.originalUrl,
    status:  500,
    user_id: req.user?.sub,
  });

  return res.status(500).json({
    error: 'Erro interno do servidor.',
    correlation_id: req.correlationId,
  });
});

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, async () => {
  console.info(`[backend] Monólito modular em http://localhost:${PORT} (${IS_PRODUCTION ? 'produção' : 'desenvolvimento'})`);
  console.info(`[backend] Auth: contas de demonstração ${IS_PRODUCTION ? 'DESLIGADAS' : 'ligadas (dev)'} · CORS ${CORS_ORIGINS.length ? 'restrito' : 'aberto'}`);
  // Rastreio internacional: provedor + ciclo de polling em background.
  console.info(trackingSimulated()
    ? '[backend] Rastreio internacional: SIMULADO (defina TRACK17_API_KEY para o modo real 17TRACK).'
    : '[backend] Rastreio internacional: REAL via 17TRACK.');

  // Avaliar os alertas no arranque, e não só quando alguém abre a página: um
  // servidor que sobe com a base em baixo ou com o email simulado em produção
  // tem de o dizer na primeira linha do log, não à primeira queixa.
  const { status, alerts } = await monitoring.getAlerts({ auditHealth, providers: listProviders });
  if (status === 'ok') {
    logger.info('Arranque sem alertas ativos', { port: Number(PORT), env: IS_PRODUCTION ? 'production' : 'development' });
  } else {
    for (const alerta of alerts) {
      logger[alerta.severity === 'critical' ? 'error' : 'warn'](alerta.message, {
        alert: alerta.key,
        action: alerta.action,
      });
    }
  }

  startPolling();
});
