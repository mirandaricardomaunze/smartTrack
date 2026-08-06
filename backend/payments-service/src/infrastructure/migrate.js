/**
 * @file migrate.js
 * @description Migração inicial do payments-service — cria a tabela `payments`.
 *
 * DDL idempotente, sem DROP: dados financeiros nunca são destruídos por um
 * comando de migração corrido por engano.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Pagamento)
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md
 *
 * Uso:
 *   node src/infrastructure/migrate.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate] Iniciando migração do payments-service...');
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                     TEXT        PRIMARY KEY,
        order_id               TEXT        NOT NULL,
        -- Centavos inteiros. BIGINT e não NUMERIC/FLOAT: regra 3 da skill.
        value                  BIGINT      NOT NULL,
        status                 TEXT        NOT NULL DEFAULT 'pending',
        gateway                TEXT        NOT NULL,
        gateway_transaction_id TEXT,
        idempotency_key        TEXT        NOT NULL,
        attempt_number         INTEGER     NOT NULL DEFAULT 1,
        failure_reason         TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT payments_status_check
          CHECK (status IN ('pending','processing','succeeded','failed','refunded','cancelled')),
        CONSTRAINT payments_gateway_check
          CHECK (gateway IN ('MERCADO_PAGO','STRIPE','PAGSEGURO')),
        CONSTRAINT payments_value_positive
          CHECK (value > 0),
        CONSTRAINT payments_attempt_positive
          CHECK (attempt_number >= 1)
      );
    `);

    // A defesa estrutural contra cobrança dupla: o banco recusa duas linhas
    // com a mesma chave, mesmo que dois processos tentem em simultâneo.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key
        ON payments (idempotency_key);
    `);

    // Idem para a transação do gateway — um tx_id só pode pertencer a um pagamento.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_tx_id
        ON payments (gateway_transaction_id)
        WHERE gateway_transaction_id IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
    `);

    await client.query('COMMIT');
    console.info('[migrate] Tabela "payments" pronta.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] Falha na migração — rollback aplicado:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
