/**
 * @file branches.router.js
 * @description Router Express do âmbito de filial (/v1/branches).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * Endpoints:
 *   GET    /v1/branches                  — filiais da empresa (= armazéns ativos)
 *   GET    /v1/branches/breakdown?days   — operação repartida por filial
 *   GET    /v1/branches/users/:id        — filiais de um utilizador
 *   PUT    /v1/branches/users/:id        — substitui as filiais de um utilizador
 *
 * A ATRIBUIÇÃO É SÓ DE ADMIN. Não é uma fronteira de segurança (§ 3.45), mas
 * quem se pudesse atribuir filiais a si próprio poderia também retirar-se todas
 * e passar a ver a empresa inteira — o contrário do que a restrição pretende.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const branches = require('../application/branches.service');

const router = Router();

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err.statusCode) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[branches.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

// A lista das filiais é legível por quem opera: sem ela, o filtro da lista de
// encomendas não teria opções para mostrar.
router.get('/', requireAuth, requireRoles(['ADMIN', 'SUPPORT']), async (req, res) => {
  try { res.json({ branches: await branches.listBranches() }); }
  catch (err) { handleError(err, res); }
});

router.get('/breakdown', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try { res.json(await branches.getBranchBreakdown({ days: Number(req.query.days) || 30 })); }
  catch (err) { handleError(err, res); }
});

router.get('/users/:id', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const lista = await branches.getUserBranches(req.params.id);
    // `restricted` explícito para o ecrã não ter de reinterpretar uma lista
    // vazia — que aqui significa "vê tudo" e não "não vê nada".
    res.json({ user_id: req.params.id, branches: lista, restricted: lista.length > 0 });
  } catch (err) { handleError(err, res); }
});

router.put('/users/:id', requireAuth, requireRoles(['ADMIN']), async (req, res) => {
  try {
    const lista = await branches.setUserBranches(req.params.id, req.body?.branches ?? []);
    res.json({ user_id: req.params.id, branches: lista, restricted: lista.length > 0 });
  } catch (err) { handleError(err, res); }
});

module.exports = router;
