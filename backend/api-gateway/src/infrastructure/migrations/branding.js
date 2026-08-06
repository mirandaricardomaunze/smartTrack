/**
 * @file branding.js
 * @description Esquema do perfil/marca da empresa — cabeçalho dos documentos.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUÊ UMA TABELA À PARTE E NÃO COLUNAS EM `companies`: o logótipo vive aqui
 * como data URL (texto, potencialmente centenas de KB). Mantê-lo fora de
 * `companies` evita arrastar esse peso em todas as leituras de tenant, que são
 * das mais frequentes do sistema.
 */
'use strict';

/**
 * Aplica (ou verifica) o esquema de marca. Não abre transação: o chamador decide.
 * @param {import('pg').PoolClient} client
 */
async function applyBrandingSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS company_profiles (
      company_id   TEXT        PRIMARY KEY,
      legal_name   TEXT        NOT NULL,
      trade_name   TEXT,
      tax_id       TEXT,                    -- NUIT (9 dígitos)
      address      TEXT,
      city         TEXT,
      country      TEXT        NOT NULL DEFAULT 'Moçambique',
      phone        TEXT,
      email        TEXT,
      website      TEXT,
      /** Logótipo como data URL — desenhado no cabeçalho dos PDF. */
      logo         TEXT,
      /** Cor da marca em hexadecimal (#RRGGBB) — filetes e títulos do documento. */
      brand_color  TEXT        NOT NULL DEFAULT '#0F172A',
      /** Coordenadas bancárias impressas nas faturas. */
      bank_details TEXT,
      /** Rodapé livre: capital social, conservatória, avisos legais. */
      footer_note  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Cada empresa começa com um perfil mínimo a partir do nome que já tem — assim
  // um documento emitido antes de alguém preencher a marca sai com o nome certo
  // em vez do emissor genérico da plataforma.
  const { rows } = await client.query("SELECT to_regclass('public.companies') AS t");
  if (rows[0].t !== null) {
    await client.query(`
      INSERT INTO company_profiles (company_id, legal_name)
      SELECT c.id, c.name FROM companies c
      WHERE NOT EXISTS (SELECT 1 FROM company_profiles p WHERE p.company_id = c.id);
    `);
  }
}

module.exports = { applyBrandingSchema };
