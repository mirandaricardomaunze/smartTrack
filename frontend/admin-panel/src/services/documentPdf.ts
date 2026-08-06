/**
 * @file documentPdf.ts
 * @description Exportadores PDF por documento, sobre o papel timbrado da empresa.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * Cada função aqui é fina de propósito: traduz um objeto do domínio para a
 * estrutura genérica de `companyPdf.ts`. Adicionar um PDF novo a qualquer página
 * é escrever mais uma destas — não mexer no motor.
 */

import { buildCompanyPdf, type PdfTable, type PdfMeta } from './companyPdf';
import type {
  CompanyProfile, Invoice, TaxReport, SubscriptionInvoice, DocType, IntegrityReport,
  HrPayroll, HrPayrollItem,
} from './api';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}
function fdate(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
}
function fdatetime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
/** Nome de ficheiro seguro em qualquer sistema. */
function slug(value: string): string {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

const DOC_TYPE_LABEL: Record<DocType, string> = {
  FT: 'Fatura',
  FR: 'Fatura-recibo',
  NC: 'Nota de crédito',
  ND: 'Nota de débito',
  RC: 'Recibo',
};

const STATUS_LABEL: Record<string, string> = { issued: 'Emitida', paid: 'Paga', void: 'Anulada' };

// ─── Documento fiscal (fatura, nota de crédito) ──────────────────────────────

/**
 * PDF do documento fiscal. Leva tudo o que a lei exige no papel: designação,
 * NUIT das duas partes, IVA discriminado por taxa, motivo de isenção,
 * referência ao documento retificado e a assinatura de inviolabilidade.
 */
export async function exportInvoicePdf(invoice: Invoice, profile: CompanyProfile | null): Promise<void> {
  const summary = invoice.tax_summary?.length
    ? invoice.tax_summary
    : [{ rate_pct: invoice.tax_rate_pct, base_cents: invoice.subtotal_cents, tax_cents: invoice.tax_cents }];

  const totals: PdfMeta[] = [
    { label: 'Subtotal (sem IVA)', value: mzn(invoice.subtotal_cents) },
    ...summary.map((t) => ({
      label: t.rate_pct === 0 ? `Isento sobre ${mzn(t.base_cents)}` : `IVA ${t.rate_pct}% sobre ${mzn(t.base_cents)}`,
      value: mzn(t.tax_cents),
    })),
    { label: 'Total', value: mzn(invoice.total_cents), strong: true },
  ];
  if (invoice.credited_cents > 0) {
    totals.push({ label: 'Já creditado', value: `-${mzn(invoice.credited_cents)}` });
  }

  const table: PdfTable = {
    columns: [
      { header: 'Descrição', width: 5 },
      { header: 'Qtd', width: 1, align: 'right' },
      { header: 'Preço unit.', width: 1.6, align: 'right' },
      { header: 'IVA', width: 1, align: 'right' },
      { header: 'Total', width: 1.8, align: 'right' },
    ],
    rows: invoice.items.map((item) => [
      item.description,
      String(item.quantity),
      mzn(item.unit_cents),
      item.tax_rate_pct === undefined ? '—' : `${item.tax_rate_pct}%`,
      mzn(item.total_cents),
    ]),
    totals,
  };

  const notes: string[] = [];
  for (const line of summary) {
    if (line.exemption_reason) notes.push(`Motivo da isenção: ${line.exemption_reason}`);
  }
  if (invoice.notes) notes.push(invoice.notes);
  if (invoice.status === 'paid') {
    notes.push(`Pago${invoice.payment_method ? ` por ${invoice.payment_method}` : ''} em ${fdatetime(invoice.paid_at)}.`);
  }
  if (invoice.status === 'void' && invoice.void_reason) {
    notes.push(`Documento anulado: ${invoice.void_reason}`);
  }

  // Sem repetir o tipo de documento: ele é a etiqueta por cima do número, no
  // cabeçalho. Repeti-lo aqui era ruído num documento que se quer limpo.
  const meta: PdfMeta[] = [
    { label: 'Data de emissão', value: fdatetime(invoice.issued_at) },
  ];
  if (invoice.tracking_code) meta.push({ label: 'Pedido', value: invoice.tracking_code });
  if (invoice.related_number) meta.push({ label: 'Retifica', value: invoice.related_number, strong: true });

  await buildCompanyPdf({
    profile,
    title: DOC_TYPE_LABEL[invoice.doc_type] ?? 'Documento',
    reference: invoice.number,
    badge: STATUS_LABEL[invoice.status]?.toUpperCase(),
    meta,
    parties: [{
      title: 'Cliente',
      lines: [
        invoice.client_name,
        invoice.client_tax_id ? `NUIT: ${invoice.client_tax_id}` : '',
        invoice.client_address ?? '',
        invoice.client_email ?? '',
      ].filter(Boolean),
    }],
    tables: [table],
    notes,
    legalNote: [
      invoice.hash_control ? `Assinatura do documento: ${invoice.hash_control} — Processado por computador.` : '',
      invoice.software ? `${invoice.software.name} v${invoice.software.version} · Certificado AT: ${invoice.software.certificate}${invoice.software.certificate === '0' ? ' (não certificado)' : ''}` : '',
    ].filter(Boolean).join(' '),
    filename: `${slug(invoice.number)}.pdf`,
  });
}

// ─── Mapa de IVA ──────────────────────────────────────────────────────────────

export async function exportTaxReportPdf(report: TaxReport, profile: CompanyProfile | null): Promise<void> {
  const rates: PdfTable = {
    title: 'Apuramento por taxa',
    columns: [
      { header: 'Taxa', width: 3 },
      { header: 'Base tributável', width: 2, align: 'right' },
      { header: 'IVA', width: 2, align: 'right' },
      { header: 'Documentos', width: 1.2, align: 'right' },
    ],
    rows: report.lines.map((line) => [
      line.exemption_reason ? `${line.label} — ${line.exemption_reason}` : line.label,
      mzn(line.base_cents),
      mzn(line.tax_cents),
      String(line.documents),
    ]),
    totals: [
      { label: 'Base tributável', value: mzn(report.totals.base_cents) },
      { label: 'IVA liquidado', value: mzn(report.totals.tax_cents) },
      { label: 'Total faturado', value: mzn(report.totals.gross_cents), strong: true },
    ],
    emptyLabel: 'Sem documentos emitidos no período.',
  };

  const documents: PdfTable = {
    title: 'Documentos emitidos',
    columns: [
      { header: 'Tipo', width: 3 },
      { header: 'Emitidos', width: 1.2, align: 'right' },
      { header: 'Anulados', width: 1.2, align: 'right' },
      { header: 'Valor', width: 2, align: 'right' },
    ],
    rows: report.documents.map((d) => [`${d.doc_type} · ${d.label}`, String(d.total), String(d.voided), mzn(d.total_cents)]),
  };

  await buildCompanyPdf({
    profile,
    title: 'Mapa de IVA',
    reference: report.period,
    subtitle: `Período de ${fdate(report.from)} a ${fdate(report.to)}`,
    meta: [
      { label: 'Emitido em', value: fdatetime(new Date().toISOString()) },
      { label: 'NUIT', value: report.issuer.tax_id },
    ],
    tables: [rates, documents],
    notes: [
      'As notas de crédito do período entram com sinal negativo, como na declaração periódica.',
    ],
    legalNote: 'Documento de apoio à declaração periódica de IVA. Confirme o apuramento com o seu contabilista antes de submeter.',
    filename: `mapa-iva-${report.period}.pdf`,
  });
}

// ─── Relatório de integridade do arquivo fiscal ──────────────────────────────

export async function exportIntegrityPdf(report: IntegrityReport, profile: CompanyProfile | null): Promise<void> {
  const table: PdfTable = {
    title: 'Cadeias verificadas',
    columns: [
      { header: 'Série', width: 2 },
      { header: 'Documentos', width: 1.2, align: 'right' },
      { header: 'Sem assinatura', width: 1.4, align: 'right' },
      { header: 'Estado', width: 3 },
    ],
    rows: report.chains.map((chain) => [
      `${chain.doc_type} · ${chain.series}`,
      String(chain.checked),
      String(chain.unsigned),
      chain.ok
        ? 'Íntegra'
        : [...chain.broken.map((b) => `${b.number}: ${b.reason}`),
           ...chain.gaps.map((g) => `Salto: esperado ${g.expected}, encontrado ${g.found}`)].join(' | '),
    ]),
  };

  await buildCompanyPdf({
    profile,
    title: 'Integridade do arquivo fiscal',
    badge: report.ok ? 'SEM VIOLAÇÕES' : 'VERIFICAR',
    meta: [
      { label: 'Verificado em', value: fdatetime(report.checked_at) },
      { label: 'Software', value: `${report.software.name} v${report.software.version}` },
      { label: 'Certificado AT', value: `${report.software.certificate}${report.software.certificate === '0' ? ' (não certificado)' : ''}` },
    ],
    tables: [table],
    notes: [
      'A verificação recalcula a assinatura de cada documento e confirma o encadeamento e a sequência de cada série.',
      'Documentos anteriores à conformidade fiscal não foram assinados na origem e são apenas contados.',
    ],
    filename: `integridade-fiscal-${new Date().toISOString().slice(0, 10)}.pdf`,
  });
}

// ─── Fatura de subscrição (plataforma → empresa) ─────────────────────────────

export async function exportSubscriptionInvoicePdf(invoice: SubscriptionInvoice, profile: CompanyProfile | null): Promise<void> {
  await buildCompanyPdf({
    profile,
    title: 'Fatura de subscrição',
    reference: invoice.number,
    badge: STATUS_LABEL[invoice.status]?.toUpperCase(),
    subtitle: `Plano ${invoice.plan_name}`,
    meta: [
      { label: 'Emitida em', value: fdatetime(invoice.issued_at) },
      { label: 'Período', value: `${fdate(invoice.period_start)} a ${fdate(invoice.period_end)}` },
      ...(invoice.paid_at ? [{ label: 'Paga em', value: fdatetime(invoice.paid_at) }] : []),
      ...(invoice.payment_ref ? [{ label: 'Referência', value: invoice.payment_ref }] : []),
    ],
    parties: [{ title: 'Empresa', lines: [invoice.company_name] }],
    tables: [{
      columns: [
        { header: 'Descrição', width: 6 },
        { header: 'Período', width: 3 },
        { header: 'Total', width: 2, align: 'right' },
      ],
      rows: [[
        `Subscrição da plataforma — plano ${invoice.plan_name}`,
        `${fdate(invoice.period_start)} a ${fdate(invoice.period_end)}`,
        mzn(invoice.total_cents),
      ]],
      totals: [
        { label: 'Base tributável', value: mzn(invoice.subtotal_cents) },
        { label: `IVA ${invoice.tax_rate_pct}%`, value: mzn(invoice.tax_cents) },
        { label: 'Total', value: mzn(invoice.total_cents), strong: true },
      ],
    }],
    legalNote: invoice.hash_control ? `Assinatura do documento: ${invoice.hash_control} — Processado por computador.` : undefined,
    filename: `${slug(invoice.number)}.pdf`,
  });
}

// ─── Recibo de remuneração ───────────────────────────────────────────────────

const PAYROLL_STATUS_LABEL: Record<string, string> = { draft: 'Rascunho', approved: 'Aprovado', paid: 'Pago' };

/**
 * Recibo de vencimento do colaborador, no papel timbrado da entidade
 * empregadora — que é a EMPRESA em sessão, não a plataforma.
 * Leva as duas linhas de assinatura que um recibo em papel exige.
 */
export async function exportPayslipPdf(
  payroll: HrPayroll,
  item: HrPayrollItem,
  profile: CompanyProfile | null,
): Promise<void> {
  const earnings: PdfTable = {
    title: 'Proventos',
    columns: [{ header: 'Componente', width: 4 }, { header: 'Valor', width: 2, align: 'right' }],
    rows: [
      ['Salário base', mzn(item.base_salary_cents)],
      ['Subsídios', mzn(item.allowances_cents)],
      ['Bónus', mzn(item.bonus_cents)],
      ['Horas extraordinárias', mzn(item.overtime_cents)],
    ],
    totals: [{ label: 'Total bruto', value: mzn(item.gross_cents), strong: true }],
  };

  const deductions: PdfTable = {
    title: 'Descontos',
    columns: [{ header: 'Componente', width: 4 }, { header: 'Valor', width: 2, align: 'right' }],
    rows: [
      ['Imposto', mzn(item.tax_cents)],
      ['Previdência social', mzn(item.social_security_cents)],
      ['Outros descontos', mzn(item.other_deductions_cents)],
    ],
    totals: [
      { label: 'Total de descontos', value: mzn(item.deductions_cents) },
      { label: 'Líquido a receber', value: mzn(item.net_cents), strong: true },
    ],
  };

  await buildCompanyPdf({
    profile,
    title: 'Recibo de remuneração',
    reference: payroll.period,
    badge: PAYROLL_STATUS_LABEL[payroll.status]?.toUpperCase(),
    meta: [
      { label: 'Período', value: payroll.period },
      { label: 'Emitido em', value: fdate(new Date().toISOString()) },
    ],
    parties: [{
      title: 'Colaborador',
      lines: [item.employee_name, `N.º de colaborador: ${item.employee_number}`],
    }],
    tables: [earnings, deductions],
    notes: item.notes ? [`Observações: ${item.notes}`] : [],
    signatures: ['Entidade empregadora', 'Colaborador'],
    legalNote: 'Documento interno de remuneração, sem certificação fiscal.',
    filename: `recibo-${slug(payroll.period)}-${slug(item.employee_number)}.pdf`,
  });
}

// ─── Relatórios operacionais e listagens ─────────────────────────────────────

export interface SimpleReportInput {
  title: string;
  subtitle?: string;
  meta?: PdfMeta[];
  tables: PdfTable[];
  notes?: string[];
  filename: string;
}

/**
 * Exportador genérico para qualquer listagem/relatório do painel — é o que
 * qualquer página nova deve usar para ganhar "Exportar PDF".
 */
export async function exportReportPdf(input: SimpleReportInput, profile: CompanyProfile | null): Promise<void> {
  await buildCompanyPdf({
    profile,
    title: input.title,
    subtitle: input.subtitle,
    meta: [{ label: 'Emitido em', value: fdatetime(new Date().toISOString()) }, ...(input.meta ?? [])],
    tables: input.tables,
    notes: input.notes,
    filename: input.filename,
  });
}

export { mzn as formatMzn, fdate as formatDate, fdatetime as formatDateTime, slug as slugify };
