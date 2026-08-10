/**
 * @file exports.router.js
 * @description Router Express para exportação em Excel (/v1/exports).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * Endpoints:
 *   GET /v1/exports/rentabilidade?from&to   — ADMIN
 *   GET /v1/exports/contas-a-receber        — ADMIN
 *   GET /v1/exports/desempenho?from&to      — ADMIN
 *   GET /v1/exports/ocorrencias             — ADMIN, SUPPORT
 *
 * O PAPEL EXIGIDO É O MESMO DO RELATÓRIO DE ORIGEM. Um ficheiro exportado é uma
 * cópia integral do relatório que sai do sistema e circula por email; deixar a
 * exportação mais aberta do que o ecrã seria abrir uma porta lateral aos mesmos
 * dados.
 */
'use strict';

const { Router } = require('express');
const { requireAuth, requireRoles, UnauthorizedError, ForbiddenError } = require('../application/auth.service');
const { exportReport } = require('../application/exports.service');

const router = Router();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function handleError(err, res) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError || err.statusCode) {
    return res.status(err.statusCode ?? 400).json({ error: err.message });
  }
  console.error('[exports.router] Erro inesperado:', err.message);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
}

/** Devolve o ficheiro com os cabeçalhos que fazem o browser guardá-lo. */
function send(res, { filename, buffer }) {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  // Sem isto o browser serve a exportação da semana passada a partir da cache.
  res.setHeader('Cache-Control', 'no-store');
  res.end(buffer);
}

/** Janela pedida; ambas opcionais — cada serviço aplica o seu próprio default. */
function janela(req) {
  return { from: req.query.from || undefined, to: req.query.to || undefined };
}

function rota(caminho, papeis, relatorio) {
  router.get(caminho, requireAuth, requireRoles(papeis), async (req, res) => {
    try { send(res, await exportReport(relatorio, janela(req))); }
    catch (err) { handleError(err, res); }
  });
}

rota('/rentabilidade', ['ADMIN'], 'rentabilidade');
rota('/contas-a-receber', ['ADMIN'], 'contas-a-receber');
rota('/desempenho', ['ADMIN'], 'desempenho');
rota('/ocorrencias', ['ADMIN', 'SUPPORT'], 'ocorrencias');

module.exports = router;
