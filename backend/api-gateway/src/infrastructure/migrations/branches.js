/**
 * @file branches.js
 * @description Âmbito de filial: quem vê que base da operação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * NÃO CRIA UMA TABELA `branches`: a filial é o armazém. Uma tabela nova teria
 * nome, morada, GPS e código — o que `warehouses` já tem — e as duas ficariam a
 * divergir à primeira base criada só num dos sítios.
 *
 * `branch_id` FICA A NULL NAS ENCOMENDAS EXISTENTES, e é deliberado. O armazém
 * onde uma encomenda está hoje não é a filial por onde entrou; preencher um a
 * partir do outro inventaria um facto que o sistema nunca guardou, e a receita
 * de meses passados passaria a ser atribuída à base errada. `NULL` significa
 * "não se sabe" e continua visível a toda a gente.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyBranchesSchema(client) {
  // Muitos-para-muitos: um responsável regional cobre mais do que uma base, e
  // uma coluna única na ficha do utilizador obrigá-lo-ia a ter duas contas.
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_branches (
      user_id      TEXT        NOT NULL,
      warehouse_id TEXT        NOT NULL,
      company_id   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, warehouse_id)
    );
  `);

  // O âmbito é lido a cada pedido (§ 3.45): este índice é o que torna essa
  // decisão sustentável em vez de a pagar em latência.
  await client.query(`CREATE INDEX IF NOT EXISTS idx_user_branches_user ON user_branches (user_id);`);

  // Filial de ORIGEM — nunca muda. `warehouse_id` continua a dizer onde a
  // mercadoria está agora, e são perguntas diferentes.
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS branch_id TEXT;`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_branch ON orders (company_id, branch_id);`);

  // Base de afetação de pessoas e viaturas: é o que permite ao painel de uma
  // filial mostrar a sua própria capacidade em vez da capacidade da empresa.
  await client.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS branch_id TEXT;`);
  await client.query(`ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS branch_id TEXT;`);
}

module.exports = { applyBranchesSchema };
