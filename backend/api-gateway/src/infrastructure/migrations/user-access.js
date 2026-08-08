/**
 * @file user-access.js
 * @description Esquema do estado de acesso de uma conta.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE EXISTE UMA COLUNA E NÃO UM DELETE: quando alguém sai da empresa, o
 * acesso tem de ser cortado hoje, mas os documentos que essa pessoa assinou, os
 * eventos de auditoria que provocou e as entregas que fez continuam a apontar
 * para ela. Apagar a linha partia esse rasto — que é precisamente o que a § 3.21
 * existe para garantir. Suspender é reversível, apagar não é.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyUserAccessSchema(client) {
  // 'active' | 'blocked'. Sem CHECK: o mesmo critério do resto do esquema, onde
  // o estado é validado no caso de uso e não amarrado por uma restrição que
  // obriga a migração sempre que aparece um estado novo.
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);
  // Quem suspendeu e quando — sem isto, "porque é que esta conta está bloqueada?"
  // só se responde a ler o registo de auditoria linha por linha.
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

  // A listagem de contas é sempre por empresa (multiempresa, § 2.4).
  await client.query(`CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id);`);
}

module.exports = { applyUserAccessSchema };
