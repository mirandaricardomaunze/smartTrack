/**
 * @file companies.router.js
 * @description Router Express das empresas (/v1/companies) — multi-tenant.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4
 *
 *   POST /v1/companies/register        auto-registo SaaS (público, rate-limited)
 *   GET  /v1/companies                 lista com resumo (SUPERADMIN)
 *   GET  /v1/companies/:id             detalhe (SUPERADMIN)
 *   POST /v1/companies/:id/status      ativar/suspender (SUPERADMIN)
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const { rateLimit } = require('../infrastructure/rate-limit');
const companies = require('../application/companies.service');
const audit = require('../application/audit.service');

const router = Router();

const registerLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.COMPANY_REGISTER_RATE_LIMIT_MAX) || 5,
  message: 'Demasiados registos de empresa. Aguarde um minuto.',
});

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[companies.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// Auto-registo público.
router.post('/register', registerLimiter, async (req, res) => {
  try { res.status(201).json(await companies.registerCompany(req.body)); }
  catch (err) { handleError(err, res); }
});

// ─── Perfil / marca da empresa (spec § 3.17) ─────────────────────────────────
// Cabeçalho de todos os documentos PDF e emissor das faturas fiscais.

/** A empresa do token — o perfil é sempre o da empresa em sessão. */
function companyOf(req, res) {
  const companyId = req.user?.company_id;
  if (!companyId) {
    res.status(400).json({ error: 'Esta operação exige um utilizador de empresa.' });
    return null;
  }
  return companyId;
}

router.get('/me/profile', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) return undefined;
    return res.json(await companies.getProfile(companyId));
  } catch (err) { return handleError(err, res); }
});

router.put('/me/profile', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const companyId = companyOf(req, res);
    if (!companyId) return undefined;
    return res.json(await companies.updateProfile(companyId, req.body));
  } catch (err) { return handleError(err, res); }
});

// Gestão da plataforma — apenas SUPERADMIN.
router.get('/', requireAuth, requireRoles(['SUPERADMIN']), async (_req, res) => {
  try { res.json(await companies.listCompanies()); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', requireAuth, requireRoles(['SUPERADMIN']), async (req, res) => {
  try { res.json(await companies.getCompany(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/:id/status', requireAuth, requireRoles(['SUPERADMIN']), async (req, res) => {
  try {
    const company = await companies.setStatus(req.params.id, req.body?.status);
    // Suspender uma empresa corta o acesso a todos os seus utilizadores.
    await audit.recordFromRequest(req, {
      action: 'companies.status',
      company_id: company.id,
      summary: `${req.user?.email ?? 'plataforma'} definiu a empresa ${company.name} como ${company.status === 'active' ? 'ativa' : 'suspensa'}`,
      entity_type: 'company', entity_id: company.id, entity_label: company.name,
      metadata: { status: company.status },
    });
    res.json(company);
  } catch (err) { handleError(err, res); }
});

module.exports = router;
