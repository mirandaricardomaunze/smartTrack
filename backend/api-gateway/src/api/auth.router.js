/**
 * @file auth.router.js
 * @description Router Express para endpoints de autenticação (/v1/auth).
 *
 * Endpoints:
 *   POST /v1/auth/register — cria uma conta (persiste em `users`) e devolve token
 *   POST /v1/auth/login    — autentica (contas mock ou `users`) e devolve token
 */
'use strict';

const { Router } = require('express');
const {
  login,
  register,
  requireAuth,
  requireRoles,
  InvalidCredentialsError,
  CompanySuspendedError,
  AccountBlockedError,
  ValidationError,
  EmailInUseError,
} = require('../application/auth.service');
const passwordReset = require('../application/password-reset.service');

const router = Router();

function handleError(err, res) {
  const known = [InvalidCredentialsError, CompanySuspendedError, AccountBlockedError, ValidationError, EmailInUseError, passwordReset.PasswordResetError];
  if (known.some((E) => err instanceof E)) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  // Limite de utilizadores do plano (SaaS, spec § 2.5).
  if (err.statusCode === 402) {
    return res.status(402).json({ error: err.message, code: err.name });
  }
  console.error('[auth.router] Erro inesperado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// ─── Recuperação de senha (spec § 3.22) ──────────────────────────────────────
// Públicas por natureza — quem perdeu a senha não consegue autenticar-se. A
// proteção é outra: resposta neutra (não revela que contas existem), token de
// uso único com prazo curto, e o rate limit estrito já aplicado a /v1/auth.

/** POST /v1/auth/forgot-password — pede o link por email. */
router.post('/forgot-password', async (req, res) => {
  try {
    const result = await passwordReset.requestReset(req.body ?? {}, { ip: req.ip, request_id: req.requestId });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

/** GET /v1/auth/reset-password/:token — o link ainda serve? */
router.get('/reset-password/:token', async (req, res) => {
  try { res.json(await passwordReset.checkToken(req.params.token)); }
  catch (err) { handleError(err, res); }
});

/** POST /v1/auth/reset-password — define a senha nova. */
router.post('/reset-password', async (req, res) => {
  try {
    const result = await passwordReset.resetPassword(req.body ?? {}, { ip: req.ip, request_id: req.requestId });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/auth/register ──────────────────────────────────────────────────
// Contas operacionais são provisionadas apenas por administradores autenticados.
router.post('/register', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  const { name, email, password, role } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  try {
    const result = await register({ name, email, password, role });
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ─── POST /v1/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail corporativo e senha são obrigatórios.' });
  }

  try {
    const result = await login(email, password);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

module.exports = router;
