/**
 * @file warehouse-inventory.js
 * @description Transferências entre filiais e contagens de inventário.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE EXISTE: havia entrada e envio, mas mover carga entre duas unidades da
 * mesma empresa fazia-se como um envio seguido de uma entrada — dois atos sem
 * ligação nenhuma. Entre um e outro a encomenda não estava em lado nenhum, e se
 * não chegasse, ninguém tinha como saber que devia ter chegado. A transferência
 * existe para dar um **manifesto** ao que sai e uma **conferência** ao que
 * entra: é na transferência que as encomendas se perdem, e sem os dois lados
 * ninguém sabe onde.
 *
 * PORQUE OS ITENS TÊM TABELA E AS CONTAGENS NÃO: um item de transferência tem
 * ciclo de vida próprio (pendente → recebido / em falta) e responde-se por ele
 * individualmente — "esta encomenda não chegou, em que transferência ia?". Uma
 * contagem é uma fotografia de um instante: o que interessa é o relatório, e
 * ninguém pergunta "em que contagens é que esta encomenda apareceu". Daí a
 * assimetria, que é deliberada.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyWarehouseInventorySchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS warehouse_transfers (
      id             TEXT        PRIMARY KEY,
      company_id     TEXT,
      code           TEXT        NOT NULL,
      origin_id      TEXT        NOT NULL REFERENCES warehouses (id),
      destination_id TEXT        NOT NULL REFERENCES warehouses (id),
      -- draft | in_transit | received | cancelled
      status         TEXT        NOT NULL DEFAULT 'draft',
      notes          TEXT,
      dispatched_at  TIMESTAMPTZ,
      dispatched_by  TEXT,
      received_at    TIMESTAMPTZ,
      received_by    TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // O código é único DENTRO da empresa (multiempresa, § 2.4).
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_warehouse_transfers_company_code
      ON warehouse_transfers (company_id, code);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_transfers_origin
      ON warehouse_transfers (origin_id, created_at DESC);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_transfers_destination
      ON warehouse_transfers (destination_id, created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS warehouse_transfer_items (
      id            TEXT        PRIMARY KEY,
      transfer_id   TEXT        NOT NULL REFERENCES warehouse_transfers (id) ON DELETE CASCADE,
      order_id      TEXT        NOT NULL,
      -- Guardado na linha e não só no pedido: se a encomenda desaparecer da
      -- listagem por qualquer razão, o manifesto continua a dizer o que ia lá.
      tracking_code TEXT,
      -- pending | received | missing | unexpected
      status        TEXT        NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Uma encomenda entra uma vez em cada manifesto.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_transfer_items_transfer_order
      ON warehouse_transfer_items (transfer_id, order_id);
  `);
  // "Esta encomenda não chegou — em que transferência ia?"
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_transfer_items_order
      ON warehouse_transfer_items (order_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS warehouse_counts (
      id           TEXT        PRIMARY KEY,
      company_id   TEXT,
      warehouse_id TEXT        NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
      -- open | closed
      status       TEXT        NOT NULL DEFAULT 'open',
      -- O que o sistema dizia estar cá, no instante em que a contagem abriu.
      -- Congelado de propósito: comparar com o estado atual no fim da contagem
      -- acusaria como divergência tudo o que entrou e saiu legitimamente durante
      -- as duas horas em que se andou a ler códigos.
      expected     JSONB       NOT NULL DEFAULT '[]',
      scanned      JSONB       NOT NULL DEFAULT '[]',
      -- Relatório final: found / missing / unexpected.
      result       JSONB,
      notes        TEXT,
      opened_by    TEXT,
      closed_by    TEXT,
      opened_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at    TIMESTAMPTZ
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_counts_warehouse
      ON warehouse_counts (warehouse_id, opened_at DESC);
  `);
}

module.exports = { applyWarehouseInventorySchema };
