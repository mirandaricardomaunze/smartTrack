/**
 * @file delivery-windows.js
 * @description Janela de entrega combinada com o destinatário.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.48
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * NULL POR OMISSÃO, e é o que faz esta migração ser segura: sem janela, o motor
 * de rotas comporta-se exatamente como antes — quilómetros e mais nada. Uma
 * janela por omissão (as 8h às 18h, por exemplo) criaria compromissos com
 * milhares de clientes que ninguém assumiu, e o primeiro relatório apareceria a
 * acusar a operação de os falhar.
 *
 * TIMESTAMPTZ e não TIME: a janela é de um dia concreto. Guardada como hora do
 * dia, uma encomenda reagendada (§ 3.37) levaria a janela de ontem para amanhã
 * sem ninguém reparar.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyDeliveryWindowsSchema(client) {
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ;`);
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS window_end   TIMESTAMPTZ;`);

  // alta | normal | baixa — decide entre paradas IGUALMENTE possíveis (§ 3.48).
  // Nunca atropela uma janela: um expresso entregue depois de a janela fechar
  // não é uma entrega prioritária, é uma entrega falhada mais cedo na lista.
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_priority TEXT;`);

  // O despacho procura encomendas com janela para as ordenar primeiro; sem
  // índice, isso é uma varredura da tabela inteira a cada plano.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orders_window
        ON orders (company_id, window_end)
     WHERE window_end IS NOT NULL;
  `);
}

module.exports = { applyDeliveryWindowsSchema };
