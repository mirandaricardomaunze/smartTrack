/**
 * @file monitoring.js
 * @description Esquema do registo central de erros.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE NÃO REAPROVEITA `audit_events`: a auditoria responde a "quem fez o
 * quê" e é encadeada por hash — acrescentar-lhe avarias do servidor misturava
 * duas perguntas diferentes e fazia a cadeia crescer com linhas que ninguém
 * assinou. Além disso a auditoria é para guardar anos; um erro deixa de
 * interessar assim que for corrigido, e tem uma política de expurgo própria.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyMonitoringSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS error_events (
      id             TEXT PRIMARY KEY,
      company_id     TEXT,
      -- O mesmo id que o cliente recebeu em X-Request-Id. É por aqui que uma
      -- queixa ("deu erro às 14h20") chega à linha certa.
      correlation_id TEXT,
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      method         TEXT,
      path           TEXT,
      status         INTEGER,
      error_name     TEXT,
      message        TEXT,
      stack          TEXT,
      user_id        TEXT
    );
  `);

  // A consulta é sempre "os últimos erros desta empresa".
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_error_events_company_time
      ON error_events (company_id, occurred_at DESC);
  `);

  // E a busca por correlação, que é como se investiga uma queixa concreta.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_error_events_correlation
      ON error_events (correlation_id);
  `);
}

module.exports = { applyMonitoringSchema };
