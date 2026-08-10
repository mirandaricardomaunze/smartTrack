/**
 * @file routes-tenant.js
 * @description Isolamento por empresa na tabela `routes`.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4 (Multiempresa)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE EXISTE: `routes` foi a única tabela de serviço que ficou sem
 * `company_id`. `notifications`, `tracked_shipments` e as restantes já o tinham,
 * e os respetivos repositórios já filtravam — este ficou para trás. O resultado
 * era `SELECT * FROM routes` sem filtro nenhum: um ADMIN de uma empresa via as
 * rotas de todas as outras, com os identificadores dos motoristas, as moradas
 * das paradas e os números das encomendas. Numa plataforma multiempresa isso é
 * uma fuga entre inquilinos, não um detalhe de relatório.
 *
 * O BACKFILL VEM DO MOTORISTA: cada rota tem `driver_id`, e o motorista tem
 * empresa. É a única atribuição defensável para as linhas que já existem —
 * pô-las todas na empresa por omissão daria rotas de um cliente a outro, que é
 * exatamente o problema que esta migração corrige.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyRoutesTenantSchema(client) {
  await client.query(`ALTER TABLE routes ADD COLUMN IF NOT EXISTS company_id TEXT;`);

  // Backfill pelo motorista. Rotas cujo motorista já não exista ficam a NULL e
  // deixam de aparecer em qualquer listagem com empresa em contexto — o que é
  // preferível a aparecerem na empresa errada.
  //
  // Condicional à existência de `drivers`: na base única de produção ela existe
  // sempre, mas o ambiente de desenvolvimento tem uma `routes_db` separada onde
  // não existe. Uma migração que parte por causa de uma tabela de onde só
  // queria LER não deve travar a coluna que é o objetivo real.
  const { rows } = await client.query(`SELECT to_regclass('public.drivers') AS t`);
  if (rows[0]?.t) {
    await client.query(`
      UPDATE routes r
         SET company_id = d.company_id
        FROM drivers d
       WHERE d.id = r.driver_id
         AND r.company_id IS NULL;
    `);
  } else {
    console.warn('[migrate:routes-tenant] Sem tabela `drivers` nesta base — coluna criada sem backfill.');
  }

  await client.query(`CREATE INDEX IF NOT EXISTS idx_routes_company ON routes (company_id);`);
}

module.exports = { applyRoutesTenantSchema };
