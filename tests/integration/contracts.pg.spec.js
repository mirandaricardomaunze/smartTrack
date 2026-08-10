/**
 * @file contracts.pg.spec.js
 * @description Contratos de cliente contra a base real — os efeitos, não o cadastro.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 * Um contrato que só se grava e se lê não vale nada. O que aqui se prova é que
 * ele MUDA o que acontece: o orçamento sai com o preço acordado, a fatura ganha
 * o vencimento do prazo, e o limite de crédito trava uma encomenda nova.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { ContractFactory } from '../harness/factories/contract.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const contracts = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/contracts.service`) : null;
const pricing   = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/pricing.service`) : null;
const orders    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const invoices  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const repos     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const CLIENTE  = 'client-itest-contract-0001';
const ZONA     = 'MAPUTO_CITY';
const CODIGOS  = ['TRK910000001BR', 'TRK910000002BR', 'TRK910000003BR'];

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM invoices WHERE client_ref_id = $1', [CLIENTE]);
  await pool.query('DELETE FROM orders WHERE client_ref_id = $1 OR tracking_code = ANY($2::text[])', [CLIENTE, CODIGOS]);
  await pool.query('DELETE FROM client_contracts WHERE client_ref_id = $1', [CLIENTE]);
  await pool.query('DELETE FROM clients WHERE id = $1', [CLIENTE]);
}

/** Cria um contrato ativo para o cliente do teste. */
function contratoDe(overrides = {}) {
  return ContractFactory.build({
    client_ref_id: CLIENTE,
    code: `CT-ITEST/${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    starts_on: '2020-01-01',
    ends_on: null,
    ...overrides,
  });
}

describe.skipIf(!disponivel)('contratos de cliente · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await repos.ClientRepository.create({
      id: CLIENTE,
      name: 'Cliente Contratado, Lda',
      type: 'business',
      email: 'contrato.itest@exemplo.mz',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  afterEachCleanup();

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  /** Cada teste parte sem contratos — a resolução depende do que está na base. */
  function afterEachCleanup() {
    beforeEach(async () => {
      if (!disponivel) return;
      await pool.query('DELETE FROM client_contracts WHERE client_ref_id = $1', [CLIENTE]);
      await pool.query('DELETE FROM invoices WHERE client_ref_id = $1', [CLIENTE]);
      await pool.query('DELETE FROM orders WHERE client_ref_id = $1 OR tracking_code = ANY($2::text[])', [CLIENTE, CODIGOS]);
    });
  }

  // ── Escrita ────────────────────────────────────────────────────────────────

  it('should refuse a second active contract overlapping the first', async () => {
    // Sem esta recusa, o preço passaria a depender da ordem das linhas e
    // "porque é que esta encomenda saiu a este preço" ficaria sem resposta.
    await contracts.createContract(contratoDe({ starts_on: '2026-01-01', ends_on: '2026-12-31' }));

    await expect(
      contracts.createContract(contratoDe({ starts_on: '2026-06-01', ends_on: null })),
    ).rejects.toThrow(/sobrepõe/i);
  });

  it('should accept a second contract that starts after the first ends', async () => {
    await contracts.createContract(contratoDe({ starts_on: '2026-01-01', ends_on: '2026-06-30' }));
    const segundo = await contracts.createContract(contratoDe({ starts_on: '2026-07-01', ends_on: null }));

    expect(segundo.status).toBe('active');
  });

  it('should allow a draft to overlap — it is not in force yet', async () => {
    await contracts.createContract(contratoDe({ starts_on: '2026-01-01', ends_on: null }));
    const rascunho = await contracts.createContract(contratoDe({ status: 'draft', starts_on: '2026-06-01' }));

    expect(rascunho.status).toBe('draft');
  });

  it('should end a contract instead of deleting it', async () => {
    // As encomendas já faturadas apontam para ele: sem a linha, ninguém explica
    // o preço que saiu.
    const contrato = await contracts.createContract(contratoDe());
    const terminado = await contracts.endContract(contrato.id);

    expect(terminado.status).toBe('ended');
    expect(terminado.ends_on).toBeTruthy();
    expect(await contracts.getContract(contrato.id)).toBeTruthy();
  });

  // ── Efeito no orçamento ────────────────────────────────────────────────────

  it('should quote the public table when the client has no contract', async () => {
    const publico = await pricing.quote({ zone_code: ZONA, weight_grams: 5_000 });
    const semContrato = await pricing.quote({ zone_code: ZONA, weight_grams: 5_000, client_ref_id: CLIENTE });

    expect(semContrato.total_cents).toBe(publico.total_cents);
    expect(semContrato.contract_code).toBeNull();
  });

  it('should apply the contract discount to the quote automatically', async () => {
    const publico = await pricing.quote({ zone_code: ZONA, weight_grams: 5_000 });
    const contrato = await contracts.createContract(contratoDe({ discount_pct: 20 }));

    const comContrato = await pricing.quote({ zone_code: ZONA, weight_grams: 5_000, client_ref_id: CLIENTE });

    expect(comContrato.contract_code).toBe(contrato.code);
    expect(comContrato.contract_discount_cents).toBe(Math.round(publico.total_cents * 0.2));
    expect(comContrato.total_cents).toBeLessThan(publico.total_cents);
  });

  it('should let the negotiated zone rate carry the express multiplier', async () => {
    // A tarifa acordada substitui a tabela ANTES do multiplicador. Aplicá-la
    // depois daria um expresso calculado sobre um preço que o cliente não paga.
    await contracts.createContract(contratoDe({
      discount_pct: 0,
      zone_rates: [{ zone_code: ZONA, base_cents: 10_000, per_kg_cents: 1_000, included_kg: 1 }],
    }));

    const normal   = await pricing.quote({ zone_code: ZONA, weight_grams: 3_000, client_ref_id: CLIENTE });
    const expresso = await pricing.quote({ zone_code: ZONA, weight_grams: 3_000, client_ref_id: CLIENTE, service: 'express' });

    // base 10.000 + 2 kg de excesso × 1.000 = 12.000
    expect(normal.base_cents).toBe(10_000);
    expect(normal.weight_cents).toBe(2_000);
    expect(normal.negotiated_zone_rate).toBe(true);
    // O expresso incide sobre os 12.000 acordados, não sobre a tabela pública.
    expect(expresso.service_cents).toBe(Math.round(12_000 * 0.5));
  });

  it('should not discount the COD surcharge', async () => {
    // Regra do § 3.35: a sobretaxa é um custo repassado. O teste vale mesmo com
    // a sobretaxa desligada por ambiente — nesse caso é 0 dos dois lados.
    await contracts.createContract(contratoDe({ discount_pct: 50 }));
    const orcamento = await pricing.quote({
      zone_code: ZONA, weight_grams: 1_000, client_ref_id: CLIENTE, cod_amount: 500_000,
    });

    const frete = orcamento.base_cents + orcamento.weight_cents + orcamento.service_cents + orcamento.modal_cents;
    expect(orcamento.total_cents).toBe(frete - orcamento.contract_discount_cents + orcamento.cod_surcharge_cents);
  });

  // ── Efeito na fatura ───────────────────────────────────────────────────────

  it('should date the invoice from the agreed payment terms', async () => {
    await contracts.createContract(contratoDe({ payment_terms_days: 30 }));
    const pedido = await orders.createOrder({
      tracking_code: CODIGOS[0], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 50_000,
    });

    const fatura = await invoices.createInvoiceForOrder(pedido.id);

    expect(fatura.due_date).toBeTruthy();
    const dias = Math.round((Date.parse(`${fatura.due_date}T00:00:00Z`) - Date.parse(fatura.issued_at)) / 86_400_000);
    expect(dias).toBeGreaterThanOrEqual(29);
    expect(dias).toBeLessThanOrEqual(30);
  });

  it('should leave a cash-on-issue invoice without a due date', async () => {
    // Datar uma fatura-recibo com o dia da emissão faria o mapa de dívida
    // contá-la como vencida na manhã seguinte.
    await contracts.createContract(contratoDe({ payment_terms_days: 0 }));
    const pedido = await orders.createOrder({
      tracking_code: CODIGOS[1], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 50_000,
    });

    const fatura = await invoices.createInvoiceForOrder(pedido.id);
    expect(fatura.due_date).toBeUndefined();
  });

  // ── Efeito no limite de crédito ────────────────────────────────────────────

  it('should count only issued and unpaid invoices as debt', async () => {
    await contracts.createContract(contratoDe({ credit_limit_cents: 200_000, payment_terms_days: 30 }));

    const pedido = await orders.createOrder({
      tracking_code: CODIGOS[0], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 60_000,
    });
    await invoices.createInvoiceForOrder(pedido.id);

    const situacao = await contracts.creditStatus(CLIENTE);
    expect(situacao.outstanding_cents).toBe(60_000);
    expect(situacao.available_cents).toBe(140_000);
  });

  it('should block a new order that would cross the credit limit', async () => {
    await contracts.createContract(contratoDe({ credit_limit_cents: 80_000, payment_terms_days: 30 }));

    const primeiro = await orders.createOrder({
      tracking_code: CODIGOS[0], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 70_000,
    });
    await invoices.createInvoiceForOrder(primeiro.id);

    // Travar aqui e não na fatura é o ponto: aceitar a encomenda e recusar a
    // fatura depois deixava a operação a transportar carga de um cliente que já
    // não devia estar a receber serviço.
    await expect(orders.createOrder({
      tracking_code: CODIGOS[1], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 30_000,
    })).rejects.toThrow(/limite de crédito/i);

    const naBase = await pool.query('SELECT 1 FROM orders WHERE tracking_code = $1', [CODIGOS[1]]);
    expect(naBase.rowCount).toBe(0);
  });

  it('should let orders through again once the invoice is paid', async () => {
    await contracts.createContract(contratoDe({ credit_limit_cents: 80_000, payment_terms_days: 30 }));

    const primeiro = await orders.createOrder({
      tracking_code: CODIGOS[0], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 70_000,
    });
    const fatura = await invoices.createInvoiceForOrder(primeiro.id);
    await invoices.markPaid(fatura.id, { payment_method: 'CASH' });

    const segundo = await orders.createOrder({
      tracking_code: CODIGOS[1], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 70_000,
    });
    expect(segundo.tracking_code).toBe(CODIGOS[1]);
  });

  it('should not block a client without a contract', async () => {
    // A esmagadora maioria das encomendas passa por aqui e não pode pagar o
    // custo de uma decisão que não lhe diz respeito.
    const pedido = await orders.createOrder({
      tracking_code: CODIGOS[2], client: 'contrato.itest@exemplo.mz',
      destination: 'Maputo', client_ref_id: CLIENTE, value: 9_000_000,
    });
    expect(pedido.tracking_code).toBe(CODIGOS[2]);
  });
});
