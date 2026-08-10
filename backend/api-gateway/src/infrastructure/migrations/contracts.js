/**
 * @file contracts.js
 * @description Esquema dos contratos de cliente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35 (Contratos de cliente)
 *
 * ADITIVO e idempotente (ver `migrations/saas.js` para o porquê deste padrão).
 *
 * PORQUE EXISTE: um cliente recorrente não paga a tabela pública. Sem contrato,
 * quem regista o pedido tem de se lembrar do desconto acordado e escrever o
 * preço à mão — e é aí que o dinheiro foge, num sentido e no outro. O contrato
 * põe as condições no sistema e o orçamento passa a aplicá-las sozinho.
 *
 * PORQUE `zone_rates` É JSONB E NÃO UMA TABELA: as tarifas negociadas são uma
 * lista curta, lida SEMPRE com o contrato e nunca consultada por si. Uma tabela
 * à parte acrescentava um join a todas as leituras para não responder a
 * pergunta nenhuma. Se um dia for preciso relatar "que clientes têm tarifa
 * negociada na zona X", passa a tabela — até lá, não.
 */
'use strict';

/**
 * @param {import('pg').PoolClient} client
 */
async function applyContractsSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS client_contracts (
      id                   TEXT        PRIMARY KEY,
      company_id           TEXT,
      client_ref_id        TEXT        NOT NULL,
      -- Referência humana (CT2026/0001): é o que aparece na fatura e é por ela
      -- que o cliente discute a condição ao telefone.
      code                 TEXT        NOT NULL,
      -- draft | active | suspended | ended. Sem CHECK, como no resto do esquema:
      -- o estado é validado no caso de uso, não amarrado por uma restrição que
      -- obriga a migrar sempre que aparece um estado novo.
      status               TEXT        NOT NULL DEFAULT 'draft',
      starts_on            DATE        NOT NULL,
      -- NULL = sem termo. Um contrato aberto é o caso comum e não deve obrigar
      -- a inventar uma data longínqua que depois ninguém percebe.
      ends_on              DATE,
      discount_pct         NUMERIC     NOT NULL DEFAULT 0,
      -- Piso por expedição. Sem ele, um desconto grande numa encomenda pequena
      -- dá um frete que não paga o combustível.
      minimum_charge_cents INTEGER     NOT NULL DEFAULT 0,
      -- 0 = pronto pagamento. Alimenta o vencimento da fatura.
      payment_terms_days   INTEGER     NOT NULL DEFAULT 0,
      -- 0 = sem limite. Acima disto, novas encomendas são travadas.
      credit_limit_cents   INTEGER     NOT NULL DEFAULT 0,
      zone_rates           JSONB       NOT NULL DEFAULT '[]',
      notes                TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // O código é único DENTRO da empresa, não globalmente (multiempresa, § 2.4):
  // duas empresas podem ambas ter o seu CT2026/0001.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_client_contracts_company_code
      ON client_contracts (company_id, code);
  `);

  // A consulta quente é "qual o contrato deste cliente à data de hoje".
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_client_contracts_client
      ON client_contracts (client_ref_id, starts_on DESC);
  `);

  // Vencimento da fatura. NULL nas faturas antigas e nas de pronto pagamento —
  // uma fatura-recibo paga no ato não tem vencimento nenhum, e pôr lá a data de
  // emissão faria qualquer relatório de dívida contá-la como vencida hoje.
  await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_date DATE;`);

  // NÃO há coluna `orders.contract_id`, de propósito. O pedido já guarda o
  // orçamento inteiro em `orders.pricing` (JSONB), e o orçamento passou a trazer
  // `contract_id` e `contract_code` — o preço negociado fica defensível seis
  // meses depois sem duplicar o dado em dois sítios que podem divergir. Se um
  // dia for preciso relatar por contrato, o caminho é um índice de expressão
  // sobre `pricing->>'contract_id'`, não uma coluna que alguém tem de se lembrar
  // de preencher.
}

module.exports = { applyContractsSchema };
