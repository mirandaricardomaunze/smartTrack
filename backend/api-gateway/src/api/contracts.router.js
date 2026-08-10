/**
 * @file contracts.router.js
 * @description Router Express dos contratos de cliente (/v1/contracts).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 *   GET    /v1/contracts                lista (filtros client_ref_id, status)
 *   GET    /v1/contracts/:id            detalhe
 *   POST   /v1/contracts                criar
 *   PUT    /v1/contracts/:id            alterar
 *   POST   /v1/contracts/:id/end        terminar (não apaga — ver o serviço)
 *   GET    /v1/contracts/credit/:clientRefId   situação de crédito do cliente
 *
 * RBAC: ler é de ADMIN e SUPPORT — quem atende o cliente precisa de saber a
 * condição acordada para lhe responder. ESCREVER é só de ADMIN: alterar um
 * desconto é alterar a receita.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const contracts = require('../application/contracts.service');
const audit = require('./../application/audit.service');

const router = Router();
const READ_ROLES  = ['ADMIN', 'SUPPORT'];
const WRITE_ROLES = ['ADMIN'];

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return res.status(err.statusCode ?? 401).json({ error: err.message });
  }
  if (typeof err.statusCode === 'number' && err.statusCode < 500) {
    // O limite de crédito traz o detalhe: quem está a registar a encomenda
    // precisa de ver quanto falta regularizar, não só que foi recusado.
    return res.status(err.statusCode).json({ error: err.message, detail: err.detail });
  }
  console.error('[contracts.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

router.get('/', requireAuth, requireRoles(READ_ROLES), async (req, res) => {
  try {
    res.json(await contracts.listContracts({
      client_ref_id: req.query.client_ref_id,
      status: req.query.status,
    }));
  } catch (err) { handleError(err, res); }
});

router.get('/credit/:clientRefId', requireAuth, requireRoles(READ_ROLES), async (req, res) => {
  try { res.json(await contracts.creditStatus(req.params.clientRefId)); }
  catch (err) { handleError(err, res); }
});

router.get('/:id', requireAuth, requireRoles(READ_ROLES), async (req, res) => {
  try { res.json(await contracts.getContract(req.params.id)); }
  catch (err) { handleError(err, res); }
});

router.post('/', requireAuth, requireRoles(WRITE_ROLES), async (req, res) => {
  try {
    const contrato = await contracts.createContract(req.body ?? {});
    await audit.record({
      action: 'contracts.create',
      summary: `Contrato ${contrato.code} criado (desconto ${contrato.discount_pct}%)`,
      entity_type: 'contract', entity_id: contrato.id, entity_label: contrato.code,
      outcome: audit.Outcome.SUCCESS,
      metadata: {
        client_ref_id: contrato.client_ref_id,
        discount_pct: contrato.discount_pct,
        payment_terms_days: contrato.payment_terms_days,
        credit_limit_cents: contrato.credit_limit_cents,
      },
      request: { ip: req.ip, request_id: req.correlationId },
    });
    res.status(201).json(contrato);
  } catch (err) { handleError(err, res); }
});

router.put('/:id', requireAuth, requireRoles(WRITE_ROLES), async (req, res) => {
  try {
    const contrato = await contracts.updateContract(req.params.id, req.body ?? {});
    await audit.record({
      action: 'contracts.update',
      summary: `Contrato ${contrato.code} alterado (desconto ${contrato.discount_pct}%, estado ${contrato.status})`,
      entity_type: 'contract', entity_id: contrato.id, entity_label: contrato.code,
      outcome: audit.Outcome.SUCCESS,
      metadata: { discount_pct: contrato.discount_pct, status: contrato.status },
      request: { ip: req.ip, request_id: req.correlationId },
    });
    res.json(contrato);
  } catch (err) { handleError(err, res); }
});

router.post('/:id/end', requireAuth, requireRoles(WRITE_ROLES), async (req, res) => {
  try {
    const contrato = await contracts.endContract(req.params.id);
    await audit.record({
      action: 'contracts.end',
      summary: `Contrato ${contrato.code} terminado em ${contrato.ends_on}`,
      entity_type: 'contract', entity_id: contrato.id, entity_label: contrato.code,
      outcome: audit.Outcome.SUCCESS,
      request: { ip: req.ip, request_id: req.correlationId },
    });
    res.json(contrato);
  } catch (err) { handleError(err, res); }
});

module.exports = router;
