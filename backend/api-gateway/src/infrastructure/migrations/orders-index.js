/**
 * @file orders-index.js
 * @description Índice que serve a listagem paginada de pedidos.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1
 *
 * ADITIVO e idempotente. A listagem filtra por empresa e ordena por data
 * decrescente; sem um índice composto, cada página obrigava a ordenar a tabela
 * inteira da empresa só para devolver 25 linhas.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyOrdersIndexSchema(client) {
  await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_company_created ON orders (company_id, created_at DESC);`);
  // Filtro mais usado do ecrã, combinado com a empresa.
  await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_company_status ON orders (company_id, current_status);`);
}

module.exports = { applyOrdersIndexSchema };
