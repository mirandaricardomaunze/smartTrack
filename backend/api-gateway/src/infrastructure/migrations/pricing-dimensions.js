/**
 * @file pricing-dimensions.js
 * @description Tarifação por volume e por distância.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE EXISTE: a tabela cobria zona e peso. Faltavam as duas dimensões que
 * fazem a diferença entre cobrar bem e perder dinheiro numa transportadora:
 *
 *   - **Volume.** Um colchão pesa 8 kg e ocupa a carrinha inteira. Cobrado ao
 *     peso, essa entrega dá prejuízo — o custo não é o peso, é o espaço que
 *     nega a outra encomenda. Daí o peso volumétrico.
 *   - **Distância.** Dentro da mesma zona, 3 km e 60 km não custam o mesmo.
 *     Sem esta parcela, ou se cobra a mais perto e se perde o cliente, ou se
 *     cobra a menos longe e se perde dinheiro em cada viagem.
 *
 * Os valores por omissão são ZERO de propósito: uma base já em uso continua a
 * cobrar exatamente o mesmo depois da migração, e cada empresa liga a parcela
 * quando decidir a sua tabela. Uma migração que muda preços sozinha seria a
 * pior surpresa possível.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyPricingDimensionsSchema(client) {
  // Preço por km ACIMA do incluído. 0 = a zona não cobra distância.
  await client.query(`ALTER TABLE pricing_zones ADD COLUMN IF NOT EXISTS per_km_cents INTEGER NOT NULL DEFAULT 0;`);

  // Km incluídos no preço base. Numa zona urbana, cobrar ao km desde o primeiro
  // metro faz a entrega ao lado do armazém sair mais cara do que a concorrência.
  await client.query(`ALTER TABLE pricing_zones ADD COLUMN IF NOT EXISTS included_km NUMERIC NOT NULL DEFAULT 0;`);
}

module.exports = { applyPricingDimensionsSchema };
