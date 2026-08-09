/**
 * @file receivables.service.spec.ts
 * @description Testes unitários da antiguidade da dívida.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.41
 *
 * A classificação por escalão é o que decide a quem se telefona primeiro. É pura
 * e é aqui que se afirma — com um dia de referência fixo, porque uma
 * antiguidade que depende de quando o teste corre não se pode afirmar de todo.
 */
import { describe, expect, it } from 'vitest';
import { ReceivablesFactory, RECEIVABLES_TODAY } from '../../../../tests/harness';

const { agingBucket, summarizeReceivables, BUCKETS } = require('./receivables.service');

const HOJE = RECEIVABLES_TODAY;

describe('Contas a receber · escalão de antiguidade', () => {
  it('should treat a future due date as current', () => {
    // Uma fatura a 30 dias emitida hoje NÃO está vencida. Classificá-la pela
    // emissão poria metade da carteira em atraso no primeiro dia.
    expect(agingBucket(ReceivablesFactory.depois(20), HOJE).bucket).toBe('corrente');
  });

  it('should not mark the due date itself as overdue', () => {
    // Há o dia inteiro para pagar; marcar atraso de manhã é discutir com o
    // cliente por nada.
    const r = agingBucket(HOJE, HOJE);
    expect(r.bucket).toBe('corrente');
    expect(r.days_overdue).toBe(0);
  });

  it.each([
    [1, 'd1_30'],
    [30, 'd1_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd90_mais'],
    [400, 'd90_mais'],
  ])('should put %i days overdue in %s', (dias, escalao) => {
    const r = agingBucket(ReceivablesFactory.antes(dias), HOJE);
    expect(r.bucket).toBe(escalao);
    expect(r.days_overdue).toBe(dias);
  });

  it('should put an invoice without a due date in its own bucket', () => {
    // Uma fatura-recibo é paga no ato e não leva prazo. Se ficou por pagar é
    // dívida real, mas a idade não é medível contra um prazo que nunca existiu.
    expect(agingBucket(null, HOJE).bucket).toBe('sem_prazo');
    expect(agingBucket(undefined, HOJE).bucket).toBe('sem_prazo');
  });

  it('should not crash on an unparseable date', () => {
    expect(agingBucket('não é data', HOJE).bucket).toBe('sem_prazo');
  });
});

describe('Contas a receber · carteira por cliente', () => {
  it('should spread the balance across the buckets', () => {
    const { clients, totals } = summarizeReceivables(ReceivablesFactory.onePerBucket(), HOJE);

    expect(clients).toHaveLength(1);
    expect(clients[0].buckets.corrente).toBe(10_000);
    expect(clients[0].buckets.d1_30).toBe(20_000);
    expect(clients[0].buckets.d31_60).toBe(30_000);
    expect(clients[0].buckets.d61_90).toBe(40_000);
    expect(clients[0].buckets.d90_mais).toBe(50_000);
    expect(clients[0].buckets.sem_prazo).toBe(60_000);
    expect(totals.balance_cents).toBe(210_000);
  });

  it('should count an invoice without a term in the total, outside the aging', () => {
    const { clients } = summarizeReceivables([
      ReceivablesFactory.invoice({ due_date: null, total_cents: 5_000 }),
    ], HOJE);

    expect(clients[0].balance_cents).toBe(5_000);
    expect(clients[0].buckets.d1_30).toBe(0);
  });

  it('should subtract a credit note from the balance', () => {
    // Um mapa que ignore a nota de crédito manda cobrar dinheiro que já não
    // existe, e estraga a relação mais depressa do que a própria dívida.
    const { clients } = summarizeReceivables([
      ReceivablesFactory.invoice({ total_cents: 100_000 }),
      ReceivablesFactory.creditNote(25_000),
    ], HOJE);

    expect(clients[0].balance_cents).toBe(75_000);
    expect(clients[0].credited_cents).toBe(25_000);
    // A nota de crédito não é uma fatura em aberto a cobrar.
    expect(clients[0].open_invoices).toBe(1);
  });

  it('should flag a client who is in credit instead of showing negative debt', () => {
    const { clients } = summarizeReceivables([
      ReceivablesFactory.invoice({ total_cents: 10_000 }),
      ReceivablesFactory.creditNote(30_000),
    ], HOJE);

    expect(clients[0].in_credit).toBe(true);
  });

  it('should leave paid and voided invoices out', () => {
    // Um mapa de dívida com o que já foi pago é um extrato, e serve outra
    // pergunta.
    const { clients, totals } = summarizeReceivables([
      ReceivablesFactory.paid(),
      ReceivablesFactory.voided(),
    ], HOJE);

    expect(clients).toEqual([]);
    expect(totals.balance_cents).toBe(0);
  });

  it('should put the most overdue client first', () => {
    // É por essa que se começa a telefonar.
    const recente = ReceivablesFactory.invoice({ client_ref_id: 'c-novo', due_date: ReceivablesFactory.antes(5) });
    const antigo  = ReceivablesFactory.invoice({ client_ref_id: 'c-antigo', due_date: ReceivablesFactory.antes(120) });

    const { clients } = summarizeReceivables([recente, antigo], HOJE);
    expect(clients[0].client_ref_id).toBe('c-antigo');
    expect(clients[0].oldest_days_overdue).toBe(120);
  });

  it('should separate clients from one another', () => {
    const { clients, totals } = summarizeReceivables([
      ReceivablesFactory.invoice({ client_ref_id: 'c-1', total_cents: 10_000 }),
      ReceivablesFactory.invoice({ client_ref_id: 'c-2', total_cents: 20_000 }),
    ], HOJE);

    expect(clients).toHaveLength(2);
    expect(totals.clients).toBe(2);
    expect(totals.balance_cents).toBe(30_000);
  });

  it('should survive an empty or missing portfolio', () => {
    expect(summarizeReceivables([], HOJE).clients).toEqual([]);
    expect(summarizeReceivables(undefined as unknown as [], HOJE).totals.balance_cents).toBe(0);
  });

  it('should always report every bucket, even at zero', () => {
    // Um escalão que desaparece quando está a zero faz o ecrã mudar de forma e
    // esconde que a pergunta foi feita.
    const { totals } = summarizeReceivables([ReceivablesFactory.invoice()], HOJE);
    for (const b of BUCKETS) expect(totals.buckets).toHaveProperty(b);
  });
});
