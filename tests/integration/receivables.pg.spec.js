/**
 * @file receivables.pg.spec.js
 * @description Contas a receber contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.41
 *
 * A classificação por escalão é pura e está coberta em
 * receivables.service.spec.ts. O que só a base mostra é que o `due_date` gravado
 * pelo contrato (§ 3.35) volta com o dia certo — o mesmo defeito de fuso que já
 * trocou datas por um dia três vezes neste sistema — e que faturas pagas ou
 * anuladas ficam mesmo de fora da consulta.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const receivables = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/receivables.service`) : null;
const tenant      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool        = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-recv';
const CLIENTE = 'client-itest-recv';
const HOJE    = '2026-08-09';

/** `days` dias antes de HOJE. */
const antes = (days) => new Date(Date.parse(`${HOJE}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM invoices WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

/** Insere um documento fiscal cru — emitir pelo caso de uso exigiria pedidos. */
async function semearFatura({ id, numero, tipo = 'FT', estado = 'issued', total, vencimento }) {
  await pool.query(`
    INSERT INTO invoices (id, number, doc_type, client_ref_id, client_name, items,
      subtotal_cents, tax_rate_pct, tax_cents, total_cents, status, due_date,
      issued_at, created_at, updated_at, company_id)
    VALUES ($1,$2,$3,$4,'Cliente Devedor','[]'::jsonb,$5,16,0,$5,$6,$7,NOW(),NOW(),NOW(),$8)
  `, [id, numero, tipo, CLIENTE, total, estado, vencimento, EMPRESA]);
}

const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

describe.skipIf(!disponivel)('contas a receber · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await pool.query(
      `INSERT INTO companies (id, name, slug, status) VALUES ($1,'Recebimentos ITEST',$1,'active')`,
      [EMPRESA],
    );

    await semearFatura({ id: 'inv-recv-1', numero: 'FT2026/R1', total: 100_000, vencimento: antes(120) });
    await semearFatura({ id: 'inv-recv-2', numero: 'FT2026/R2', total:  50_000, vencimento: antes(10) });
    await semearFatura({ id: 'inv-recv-3', numero: 'FT2026/R3', total:  20_000, vencimento: null });
    await semearFatura({ id: 'inv-recv-4', numero: 'FT2026/R4', total: 900_000, vencimento: antes(5), estado: 'paid' });
    await semearFatura({ id: 'inv-recv-5', numero: 'FT2026/R5', total: 800_000, vencimento: antes(5), estado: 'void' });
    await semearFatura({ id: 'inv-recv-6', numero: 'NC2026/R6', total:  30_000, vencimento: null, tipo: 'NC' });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should build the portfolio from the open invoices only', async () => {
    const { clients, totals } = await naEmpresa(() => receivables.getReceivables(HOJE));

    expect(clients).toHaveLength(1);
    // 100.000 + 50.000 + 20.000 − 30.000 de nota de crédito. As pagas e anuladas
    // não entram: um mapa de dívida com o que já foi pago é um extrato.
    expect(totals.balance_cents).toBe(140_000);
  });

  it('should read the due date back with the right day', async () => {
    // Um DATE volta do driver à meia-noite LOCAL; a leste de Greenwich isso
    // recua um dia e mudava de escalão uma fatura que vence hoje. Já trocou
    // datas por um dia três vezes neste sistema.
    const detalhe = await naEmpresa(() => receivables.getClientReceivables(CLIENTE, HOJE));
    const antiga = detalhe.invoices.find((i) => i.number === 'FT2026/R1');

    expect(antiga.due_date).toBe(antes(120));
    expect(antiga.days_overdue).toBe(120);
    expect(antiga.bucket).toBe('d90_mais');
  });

  it('should spread the balance across the aging buckets', async () => {
    const { clients } = await naEmpresa(() => receivables.getReceivables(HOJE));

    expect(clients[0].buckets.d90_mais).toBe(100_000);
    expect(clients[0].buckets.d1_30).toBe(50_000);
    expect(clients[0].buckets.sem_prazo).toBe(20_000);
  });

  it('should list a client invoices oldest first', async () => {
    // É por essa que se começa a telefonar.
    const detalhe = await naEmpresa(() => receivables.getClientReceivables(CLIENTE, HOJE));

    expect(detalhe.invoices[0].number).toBe('FT2026/R1');
    expect(detalhe.credit_notes).toHaveLength(1);
    expect(detalhe.balance_cents).toBe(140_000);
  });

  it('should agree with the credit-limit balance used by contracts', async () => {
    // Duas definições de "dívida" a divergir seria pior do que não ter nenhuma:
    // o limite de crédito travaria encomendas por um número, e a cobrança
    // telefonaria por outro.
    const repos = require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`);
    const doContrato = await naEmpresa(() => repos.InvoiceRepository.outstandingForClient(CLIENTE));
    const { totals } = await naEmpresa(() => receivables.getReceivables(HOJE));

    expect(doContrato).toBe(totals.balance_cents);
  });

  it('should not see another company debt', async () => {
    const { clients } = await tenant.runWithCompany('company-itest-recv-outra', () =>
      receivables.getReceivables(HOJE));

    expect(clients).toEqual([]);
  });
});
