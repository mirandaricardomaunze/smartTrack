/**
 * @file users.router.js
 * @description Router Express para /v1/users — contas de acesso e localização.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * Endpoints:
 *   GET  /v1/users             — contas da empresa (ADMIN/SUPERADMIN)
 *   POST /v1/users             — cria conta de painel: ADMIN ou SUPPORT (ADMIN)
 *   PUT  /v1/users/:id/password — reemite a senha de uma conta (ADMIN/SUPERADMIN)
 *   PUT  /v1/users/:id/status   — suspende/reativa uma conta (ADMIN/SUPERADMIN)
 *   POST /v1/users/me/location  — regista a localização atual do próprio utilizador
 *   GET  /v1/users/locations    — lista as últimas localizações (ADMIN, monitorização)
 */
'use strict';

const { Router } = require('express');
const { UserLocationRepository } = require('../infrastructure/pg.repository');
const {
  requireAuth,
  requireRoles,
  UnauthorizedError,
  ForbiddenError,
} = require('../application/auth.service');
const users = require('../application/users.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err instanceof users.UsersError) {
    return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  // Limite de utilizadores do plano (SaaS, spec § 2.5).
  if (err.statusCode === 402) {
    return res.status(402).json({ error: err.message, code: err.name });
  }
  console.error('[users.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** Contexto do pedido para o registo de auditoria (§ 3.21). */
function requestContext(req) {
  return { actor: req.user, ip: req.ip, request_id: req.requestId };
}

// ─── Contas e acessos (spec § 3.32) ───────────────────────────────────────────
// Antes destes endpoints, uma empresa ficava com a conta única criada no
// auto-registo e não tinha como criar outra, reemitir uma senha ou cortar um
// acesso. Declarados ANTES de `/me/location` e `/locations` não faz diferença
// (os caminhos não colidem), mas ficam juntos por serem o mesmo assunto.

/** GET /v1/users — quem tem acesso a esta empresa. */
router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPERADMIN']), async (_req, res) => {
  try { res.json(await users.listUsers()); }
  catch (err) { handleError(err, res); }
});

/** POST /v1/users — cria uma conta de painel (ADMIN ou SUPPORT). */
router.post('/', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.status(201).json(await users.createPanelUser(req.body ?? {}, requestContext(req))); }
  catch (err) { handleError(err, res); }
});

/** PUT /v1/users/:id/password — reemite a senha (não pede a antiga; ver o serviço). */
router.put('/:id/password', requireAuth, requireRoles(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try { res.json(await users.setUserPassword(req.params.id, req.body ?? {}, requestContext(req))); }
  catch (err) { handleError(err, res); }
});

/** PUT /v1/users/:id/status — suspende ou reativa o acesso. */
router.put('/:id/status', requireAuth, requireRoles(['ADMIN', 'SUPERADMIN']), async (req, res) => {
  try { res.json(await users.setUserStatus(req.params.id, req.body ?? {}, requestContext(req))); }
  catch (err) { handleError(err, res); }
});

// ─── POST /v1/users/me/location ───────────────────────────────────────────────
router.post('/me/location', requireAuth, async (req, res) => {
  const { lat, lng, accuracy } = req.body ?? {};
  const nlat = Number(lat);
  const nlng = Number(lng);

  if (Number.isNaN(nlat) || Number.isNaN(nlng) || nlat < -90 || nlat > 90 || nlng < -180 || nlng > 180) {
    return res.status(400).json({ error: 'lat e lng são obrigatórios e devem ser coordenadas válidas.' });
  }

  try {
    await UserLocationRepository.ensureTable();
    const saved = await UserLocationRepository.upsert({
      user_id:  req.user.sub,
      email:    req.user.email,
      role:     req.user.role,
      lat:      nlat,
      lng:      nlng,
      accuracy: accuracy != null && !Number.isNaN(Number(accuracy)) ? Number(accuracy) : null,
    });
    res.json({ success: true, updatedAt: saved.updated_at instanceof Date ? saved.updated_at.toISOString() : saved.updated_at });
  } catch (err) {
    handleError(err, res);
  }
});

// ─── GET /v1/users/locations ──────────────────────────────────────────────────
router.get('/locations', requireAuth, requireRoles(['ADMIN']), async (_req, res) => {
  try {
    await UserLocationRepository.ensureTable();
    res.json(await UserLocationRepository.findAll());
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
