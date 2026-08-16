/**
 * @file receivables.service.js
 * @description Contas a receber por cliente, com antiguidade da dívida.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.41
 *
 * PORQUÊ EXISTE: o § 3.17 registava contas a receber avulsas e o § 3.35 já
 * somava a dívida de um cliente para travar o limite de crédito. Faltava a
 * pergunta que quem cobra faz todas as semanas — quem deve, quanto, e há quanto
 * tempo. Sem antiguidade, uma dívida vencida há noventa dias é indistinguível de
 * uma emitida ontem, e é a primeira que decide a tesouraria do mês seguinte.
 *
 * A ANTIGUIDADE CONTA-SE DO VENCIMENTO, não da emissão: uma fatura a 30 dias
 * emitida hoje não está vencida, e classificá-la pela emissão poria metade da
 * carteira em atraso no dia em que este relatório entrasse.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId } = require('../infrastructure/tenant-context');

/**
 * Escalões de antiguidade. São os que qualquer contabilista reconhece, e
 * existem porque a probabilidade de cobrar cai a cada um deles.
 */
const BUCKETS = Object.freeze(['corrente', 'd1_30', 'd31_60', 'd61_90', 'd90_mais', 'sem_prazo']);

const BUCKET_LABELS = Object.freeze({
  corrente:  'Por vencer',
  d1_30:     'Vencida 1–30 dias',
  d31_60:    'Vencida 31–60 dias',
  d61_90:    'Vencida 61–90 dias',
  d90_mais:  'Vencida há mais de 90 dias',
  sem_prazo: 'Sem prazo acordado',
});

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Escalão de antiguidade de uma fatura. PURA.
 *
 * Sem vencimento vai para `sem_prazo`: uma fatura-recibo é paga no ato e por
 * isso não leva prazo (§ 3.35). Se ficou por pagar é dívida real, mas a idade
 * dela não é medível contra um prazo que nunca existiu — e inventar-lhe um
 * vencimento igual à emissão era exatamente o que o § 3.35 recusou fazer.
 *
 * @param {string|null|undefined} dueDate YYYY-MM-DD
 * @param {string} today YYYY-MM-DD
 * @returns {{ bucket: string, days_overdue: number }}
 */
function agingBucket(dueDate, today) {
  if (!dueDate) return { bucket: 'sem_prazo', days_overdue: 0 };

  const vencimento = Date.parse(`${String(dueDate).slice(0, 10)}T00:00:00Z`);
  const hoje = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(vencimento) || !Number.isFinite(hoje)) {
    return { bucket: 'sem_prazo', days_overdue: 0 };
  }

  const dias = Math.floor((hoje - vencimento) / 86_400_000);
  // No próprio dia do vencimento ainda não está vencida — há o dia inteiro para
  // pagar, e marcar atraso de manhã é discutir com o cliente por nada.
  if (dias <= 0) return { bucket: 'corrente', days_overdue: 0 };
  if (dias <= 30) return { bucket: 'd1_30', days_overdue: dias };
  if (dias <= 60) return { bucket: 'd31_60', days_overdue: dias };
  if (dias <= 90) return { bucket: 'd61_90', days_overdue: dias };
  return { bucket: 'd90_mais', days_overdue: dias };
}

/**
 * Carteira por cliente a partir das faturas em aberto. PURA.
 *
 * Notas de crédito ABATEM: um cliente a quem se creditou uma devolução não deve
 * o valor devolvido, e um mapa que o ignore manda cobrar dinheiro que já não
 * existe — o que estraga a relação mais depressa do que a própria dívida.
 *
 * @param {Array<object>} invoices
 * @param {string} today
 * @returns {{ clients: object[], totals: object }}
 */
function summarizeReceivables(invoices, today) {
  const porCliente = new Map();

  for (const inv of invoices ?? []) {
    // Pagas e anuladas não são dívida. Um mapa com o que já foi pago é um
    // extrato, e serve outra pergunta.
    if (inv?.status === 'paid' || inv?.status === 'void') continue;

    const chave = inv.client_ref_id ?? inv.client_name;
    const atual = porCliente.get(chave) ?? {
      client_ref_id: inv.client_ref_id ?? null,
      client_name: inv.client_name,
      open_invoices: 0,
      credited_cents: 0,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])),
      oldest_days_overdue: 0,
      balance_cents: 0,
    };

    const valor = Math.max(0, Math.round(Number(inv.total_cents) || 0));

    if (inv.doc_type === 'NC') {
      atual.credited_cents += valor;
      atual.balance_cents -= valor;
    } else {
      const { bucket, days_overdue } = agingBucket(inv.due_date, today);
      atual.buckets[bucket] += valor;
      atual.balance_cents += valor;
      atual.open_invoices += 1;
      atual.oldest_days_overdue = Math.max(atual.oldest_days_overdue, days_overdue);
    }

    porCliente.set(chave, atual);
  }

  // Saldo negativo é crédito a favor do cliente, não dívida: marcá-lo é o que
  // impede alguém de lhe telefonar a cobrar.
  const clients = [...porCliente.values()]
    .map((c) => ({ ...c, in_credit: c.balance_cents < 0 }))
    .sort((a, b) => b.oldest_days_overdue - a.oldest_days_overdue || b.balance_cents - a.balance_cents);

  const totals = {
    balance_cents: clients.reduce((s, c) => s + c.balance_cents, 0),
    clients: clients.length,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, clients.reduce((s, c) => s + c.buckets[b], 0)])),
  };

  return { clients, totals };
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

function companyFilter(params) {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  return ` AND company_id = $${params.length}`;
}

/** Faturas em aberto, cruas. Partilhadas pelos dois casos de uso. */
async function openInvoices(clientRefId) {
  const params = [];
  const filtro = companyFilter(params);
  let porCliente = '';
  if (clientRefId) {
    params.push(clientRefId);
    porCliente = ` AND client_ref_id = $${params.length}`;
  }

  const { rows } = await pool.query(`
    SELECT id, number, doc_type, status, client_ref_id, client_name,
           total_cents, issued_at, due_date
      FROM invoices
     WHERE status = 'issued'${filtro}${porCliente}
     ORDER BY due_date ASC NULLS LAST, issued_at ASC
  `, params);

  // `dateOnly` e não `toISOString`: um DATE volta do driver à meia-noite LOCAL,
  // e a leste de Greenwich isso recua um dia — o que mudaria de escalão uma
  // fatura que vence exatamente hoje.
  const { dateOnly } = require('../infrastructure/pg.repository');
  return rows.map((r) => ({ ...r, due_date: dateOnly(r.due_date) ?? null }));
}

/**
 * Expressão SQL do escalão de antiguidade — o espelho de `agingBucket`.
 *
 * DUAS IMPLEMENTAÇÕES DA MESMA REGRA é o preço de somar na base em vez de em
 * memória, e é um preço que se paga com cuidado: `receivables.pg.spec.js`
 * confronta as duas sobre as mesmas faturas e falha se divergirem. Sem esse
 * teste, isto seria a segunda definição de dívida que o § 3.41 existe para
 * evitar.
 *
 * @param {string} coluna nome da coluna de vencimento
 * @param {number} indiceHoje índice do parâmetro com a data de referência
 */
function bucketSql(coluna, indiceHoje) {
  const dias = `($${indiceHoje}::date - ${coluna}::date)`;
  return `
    CASE
      WHEN ${coluna} IS NULL THEN 'sem_prazo'
      WHEN ${dias} <= 0  THEN 'corrente'
      WHEN ${dias} <= 30 THEN 'd1_30'
      WHEN ${dias} <= 60 THEN 'd31_60'
      WHEN ${dias} <= 90 THEN 'd61_90'
      ELSE 'd90_mais'
    END`;
}

/**
 * Carteira de todos os clientes com dívida em aberto.
 *
 * SOMADA NA BASE, sem teto. A versão anterior trazia 1000 faturas e somava-as em
 * memória: uma empresa com mais do que isso via um total de dívida a MENOS, sem
 * aviso nenhum, num ecrã onde se decide a quem telefonar. É o mesmo defeito que
 * o § 3.39 corrigiu no painel — um teto silencioso apresentado como o todo.
 *
 * A agregação devolve uma linha por cliente, não uma por fatura: o custo deixa
 * de crescer com o volume de faturação e passa a crescer com o número de
 * clientes, que é outra ordem de grandeza.
 */
async function getReceivables(today = new Date().toISOString().slice(0, 10)) {
  const params = [today];
  const filtro = companyFilter(params);

  const { rows } = await pool.query(`
    WITH em_aberto AS (
      SELECT client_ref_id, client_name, doc_type,
             GREATEST(0, ROUND(total_cents))::bigint AS valor,
             CASE WHEN due_date IS NULL THEN 0
                  ELSE GREATEST(0, $1::date - due_date::date) END AS dias,
             ${bucketSql('due_date', 1)} AS escalao
        FROM invoices
       WHERE status = 'issued'${filtro}
    )
    SELECT COALESCE(client_ref_id, client_name)                              AS chave,
           MIN(client_ref_id)                                                AS client_ref_id,
           MIN(client_name)                                                  AS client_name,
           COUNT(*) FILTER (WHERE doc_type <> 'NC')::int                     AS open_invoices,
           COALESCE(SUM(valor) FILTER (WHERE doc_type = 'NC'), 0)::bigint    AS credited_cents,
           COALESCE(MAX(dias) FILTER (WHERE doc_type <> 'NC'), 0)::int       AS oldest_days_overdue,
           COALESCE(SUM(CASE WHEN doc_type = 'NC' THEN -valor ELSE valor END), 0)::bigint AS balance_cents,
           ${BUCKETS.map((b) => `COALESCE(SUM(valor) FILTER (WHERE doc_type <> 'NC' AND escalao = '${b}'), 0)::bigint AS b_${b}`).join(',\n           ')}
      FROM em_aberto
     GROUP BY COALESCE(client_ref_id, client_name)
  `, params);

  const clients = rows
    .map((r) => ({
      client_ref_id: r.client_ref_id ?? null,
      client_name: r.client_name,
      open_invoices: r.open_invoices,
      credited_cents: Number(r.credited_cents),
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, Number(r[`b_${b}`])])),
      oldest_days_overdue: r.oldest_days_overdue,
      balance_cents: Number(r.balance_cents),
      // Saldo negativo é crédito a favor do cliente, não dívida: marcá-lo é o
      // que impede alguém de lhe telefonar a cobrar.
      in_credit: Number(r.balance_cents) < 0,
    }))
    // A ordenação fica em JS: é sobre uma linha por cliente, e assim há um só
    // sítio a definir "por qual se começa a telefonar".
    .sort((a, b) => b.oldest_days_overdue - a.oldest_days_overdue || b.balance_cents - a.balance_cents);

  return {
    clients,
    totals: {
      balance_cents: clients.reduce((s, c) => s + c.balance_cents, 0),
      clients: clients.length,
      buckets: Object.fromEntries(
        BUCKETS.map((b) => [b, clients.reduce((s, c) => s + c.buckets[b], 0)]),
      ),
    },
  };
}

/**
 * As faturas em aberto de um cliente, da mais antiga para a mais recente — é
 * por essa que se começa a telefonar.
 */
async function getClientReceivables(clientRefId, today = new Date().toISOString().slice(0, 10)) {
  const faturas = await openInvoices(clientRefId);
  const resumo = summarizeReceivables(faturas, today);

  return {
    ...(resumo.clients[0] ?? { client_ref_id: clientRefId, balance_cents: 0, open_invoices: 0 }),
    invoices: faturas
      .filter((f) => f.doc_type !== 'NC')
      .map((f) => ({
        id: f.id,
        number: f.number,
        total_cents: Number(f.total_cents),
        issued_at: f.issued_at,
        due_date: f.due_date,
        ...agingBucket(f.due_date, today),
      })),
    credit_notes: faturas.filter((f) => f.doc_type === 'NC').map((f) => ({
      id: f.id, number: f.number, total_cents: Number(f.total_cents),
    })),
  };
}

module.exports = {
  // Puros
  agingBucket,
  bucketSql,
  summarizeReceivables,
  BUCKETS,
  BUCKET_LABELS,
  // Leitura
  openInvoices,
  getReceivables,
  getClientReceivables,
};
