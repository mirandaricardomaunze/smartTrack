/**
 * @file password-reset.js
 * @description Esquema da recuperação de senha.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.22 (Recuperação de senha)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * Guarda-se o **hash** do token, nunca o token. Quem ler a base não consegue
 * redefinir a senha de ninguém — é a mesma regra das senhas, aplicada ao
 * mecanismo que as substitui.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyPasswordResetSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id           TEXT        PRIMARY KEY,
      user_id      TEXT        NOT NULL,
      /** Empresa do utilizador; nula para o SUPERADMIN da plataforma. */
      company_id   TEXT,
      /** SHA-256 do token enviado por email — o token em claro nunca é gravado. */
      token_hash   TEXT        NOT NULL UNIQUE,
      expires_at   TIMESTAMPTZ NOT NULL,
      /** Uso único: preenchido quando a senha é efetivamente trocada. */
      used_at      TIMESTAMPTZ,
      /** Invalidado por um pedido novo ou por uma redefinição bem-sucedida. */
      invalidated_at TIMESTAMPTZ,
      requested_ip TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);`);
  // Serve a limpeza dos expirados e a contagem de pedidos recentes por utilizador.
  await client.query(`CREATE INDEX IF NOT EXISTS idx_password_reset_expiry ON password_reset_tokens (expires_at);`);
}

module.exports = { applyPasswordResetSchema };
