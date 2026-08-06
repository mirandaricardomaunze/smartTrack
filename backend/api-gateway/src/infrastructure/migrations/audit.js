/**
 * @file audit.js
 * @description Esquema do registo de auditoria — quem fez o quê, quando e de onde.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * A tabela é **append-only**: não há UPDATE nem DELETE em lado nenhum do código,
 * e cada evento é assinado e encadeado no anterior DA MESMA EMPRESA — apagar uma
 * linha parte a cadeia e o relatório de integridade denuncia.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyAuditSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id            TEXT        PRIMARY KEY,
      company_id    TEXT        NOT NULL,
      /** Ordem dentro da empresa — é o que permite detetar buracos. */
      seq           BIGINT      NOT NULL,
      occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      /** Quem: do JWT. Nulo em rotas públicas (rastreio, registo de empresa). */
      actor_id      TEXT,
      actor_email   TEXT,
      actor_role    TEXT,
      /** O quê: 'orders.create', 'invoices.void', 'payroll.approve'… */
      action        TEXT        NOT NULL,
      entity_type   TEXT,
      entity_id     TEXT,
      /** Rótulo legível: código de rastreio, número da fatura, nome. */
      entity_label  TEXT,
      /** Frase pronta a ler na listagem. */
      summary       TEXT        NOT NULL,
      /** Contexto curado — NUNCA corpos de pedido nem segredos (§ 3.21). */
      metadata      JSONB       NOT NULL DEFAULT '{}',
      outcome       TEXT        NOT NULL DEFAULT 'success',
      status_code   INTEGER,
      method        TEXT,
      path          TEXT,
      ip            TEXT,
      user_agent    TEXT,
      request_id    TEXT,
      duration_ms   INTEGER,
      /** Inviolabilidade: encadeamento por empresa. */
      hash          TEXT        NOT NULL,
      previous_hash TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Sequência sem buracos por empresa.
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_audit_company_seq ON audit_events (company_id, seq);`);
  // Consultas da página: por data, por ator, por ação e por entidade.
  await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_company_time ON audit_events (company_id, occurred_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_company_action ON audit_events (company_id, action);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_company_actor ON audit_events (company_id, actor_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (company_id, entity_type, entity_id);`);
}

module.exports = { applyAuditSchema };
