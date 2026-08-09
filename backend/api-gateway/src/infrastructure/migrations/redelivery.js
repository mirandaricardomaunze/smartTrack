/**
 * @file redelivery.js
 * @description Reagendamento e devolução ao remetente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.37
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE COLUNAS E NÃO JSONB: `delivery_attempts` e `next_attempt_on` são
 * consultados — "quantas encomendas estão marcadas para hoje", "quais já
 * gastaram as tentativas". Enterrá-los num JSONB obrigava a percorrer a tabela
 * inteira para responder. O bloco `return` fica em JSONB porque é lido sempre
 * inteiro, com o pedido, e nunca filtrado por dentro.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyRedeliverySchema(client) {
  // Quantas tentativas de entrega já foram feitas. Sem teto, uma encomenda
  // entra em ciclo indefinido e ninguém repara — é o custo que não aparece em
  // relatório nenhum.
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0;`);

  // O dia combinado com o destinatário. No pedido e não num comentário: é o que
  // permite não pôr a encomenda numa rota antes da data acordada.
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS next_attempt_on DATE;`);

  // Motivo, quem decidiu, quando, e a prova de quem recebeu de volta.
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_info JSONB;`);

  // "O que está marcado para hoje" é a consulta que abre o dia de quem despacha.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_next_attempt
      ON orders (next_attempt_on) WHERE next_attempt_on IS NOT NULL;
  `);
}

module.exports = { applyRedeliverySchema };
