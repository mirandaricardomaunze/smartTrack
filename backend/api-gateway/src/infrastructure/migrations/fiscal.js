/**
 * @file fiscal.js
 * @description Esquema da conformidade fiscal — séries, assinatura e IVA por taxa.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão):
 * corre tanto em bases novas, a partir do migrate do núcleo, como em bases já
 * com faturas emitidas, a partir de `migrate-fiscal.js`.
 *
 * As faturas anteriores a esta migração ficam com `doc_type='FT'`, série por
 * omissão e **sem assinatura** — de propósito: assiná-las agora seria fabricar
 * uma prova que não existia na altura. O relatório de integridade conta-as como
 * "não assinadas (anteriores à conformidade)".
 */
'use strict';

const DEFAULT_SERIES = process.env.FISCAL_DEFAULT_SERIES || 'A';

/**
 * Aplica (ou verifica) o esquema fiscal. Não abre transação: o chamador decide.
 * @param {import('pg').PoolClient} client
 */
async function applyFiscalSchema(client) {
  // ── Séries de documentos: numeração sem saltos por (empresa, tipo, série, ano)
  await client.query(`
    CREATE TABLE IF NOT EXISTS document_series (
      id          TEXT        PRIMARY KEY,
      company_id  TEXT        NOT NULL,
      doc_type    TEXT        NOT NULL,      -- FT | FR | NC | ND | RC
      series      TEXT        NOT NULL,      -- A, LOJA1, ...
      year        INTEGER     NOT NULL,
      last_seq    INTEGER     NOT NULL DEFAULT 0,
      active      BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_document_series ON document_series (company_id, doc_type, series, year);`);

  // ── Campos fiscais do documento ───────────────────────────────────────────
  const columns = [
    ['doc_type',         `TEXT NOT NULL DEFAULT 'FT'`],
    ['series',           `TEXT NOT NULL DEFAULT '${DEFAULT_SERIES}'`],
    ['seq',              'INTEGER'],
    ['issuer_name',      'TEXT'],
    ['issuer_tax_id',    'TEXT'],
    ['client_address',   'TEXT'],
    ['tax_summary',      `JSONB NOT NULL DEFAULT '[]'`],
    ['hash',             'TEXT'],
    ['previous_hash',    'TEXT'],
    ['hash_control',     'TEXT'],
    ['signed_at',        'TIMESTAMPTZ'],
    ['related_invoice_id', 'TEXT'],
    ['related_number',   'TEXT'],
    ['void_reason',      'TEXT'],
    ['credited_cents',   'INTEGER NOT NULL DEFAULT 0'],
    ['issued_by',        'TEXT'],
    ['currency',         `TEXT NOT NULL DEFAULT 'MZN'`],
  ];
  for (const [name, type] of columns) {
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  }
  await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_doc_chain ON invoices (company_id, doc_type, series, seq);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_invoices_related ON invoices (related_invoice_id);`);

  // "Uma fatura ativa por pedido" (§ 3.14) passa a valer só para os documentos de
  // VENDA: a nota de crédito refere-se ao mesmo pedido e tem de poder coexistir.
  await client.query(`DROP INDEX IF EXISTS uidx_invoices_active_order;`);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_invoices_active_order
      ON invoices (order_id)
      WHERE order_id IS NOT NULL AND status <> 'void' AND doc_type IN ('FT', 'FR');
  `);

  // Documentos anteriores: resumo de IVA reconstruído a partir dos totais que já
  // existem (a taxa era única). Sem assinatura — ver nota no cabeçalho.
  await client.query(`
    UPDATE invoices
       SET tax_summary = jsonb_build_array(jsonb_build_object(
             'rate_pct',   tax_rate_pct,
             'base_cents', subtotal_cents,
             'tax_cents',  tax_cents))
     WHERE tax_summary = '[]'::jsonb;
  `);

  // Sequência dos documentos antigos, lida do próprio número (`FT2026/0007`),
  // para o relatório de integridade conseguir ordenar a série.
  await client.query(`
    UPDATE invoices
       SET seq = NULLIF(regexp_replace(number, '^.*/', ''), '')::int
     WHERE seq IS NULL AND number ~ '/[0-9]+$';
  `);

  // A numeração CONTINUA de onde o contador antigo (§ 3.14) ficou — recomeçar
  // do 1 no mesmo ano criaria duas séries a colidir aos olhos de um auditor.
  const counters = await client.query("SELECT to_regclass('public.invoice_counters') AS t");
  if (counters.rows[0].t !== null) {
    await client.query(`
      INSERT INTO document_series (id, company_id, doc_type, series, year, last_seq)
      SELECT 'ds-' || c.company_id || '-FT-' || $1 || '-' || c.year,
             c.company_id, 'FT', $1, c.year, c.last_seq
        FROM invoice_counters c
      ON CONFLICT (company_id, doc_type, series, year) DO NOTHING;
    `, [DEFAULT_SERIES]);
  }

  // ── Assinatura também nas faturas de subscrição (cadeia da plataforma) ────
  const { rows } = await client.query("SELECT to_regclass('public.subscription_invoices') AS t");
  if (rows[0].t !== null) {
    for (const [name, type] of [['hash', 'TEXT'], ['previous_hash', 'TEXT'], ['hash_control', 'TEXT'], ['signed_at', 'TIMESTAMPTZ'], ['seq', 'INTEGER']]) {
      await client.query(`ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS ${name} ${type};`);
    }
  }
}

module.exports = { applyFiscalSchema, DEFAULT_SERIES };
