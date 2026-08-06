/**
 * @file invoicePrint.ts
 * @description Impressão de fatura-recibo numa janela dedicada (documento isolado).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14
 * Partilhado entre /faturas e /pedidos. Sem dependências externas. Sem emojis.
 */
import type { Invoice, InvoiceStatus, DocType } from './api';

const STATUS_LABEL: Record<InvoiceStatus, string> = { issued: 'Emitida', paid: 'Paga', void: 'Anulada' };

/** Designação legal do documento — sai no cabeçalho impresso (spec § 3.19). */
const DOC_TYPE_LABEL: Record<DocType, string> = {
  FT: 'Fatura',
  FR: 'Fatura-recibo',
  NC: 'Nota de crédito',
  ND: 'Nota de débito',
  RC: 'Recibo',
};

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}
function fdate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString('pt-MZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Abre uma janela com o documento da fatura e dispara a impressão. */
export function printInvoice(inv: Invoice): void {
  // Discriminação do IVA por taxa e motivo de isenção (spec § 3.19) — sem isto o
  // documento não cumpre os requisitos de uma fatura.
  const summary = inv.tax_summary?.length
    ? inv.tax_summary
    : [{ rate_pct: inv.tax_rate_pct, base_cents: inv.subtotal_cents, tax_cents: inv.tax_cents }];

  const taxRows = summary.map((t) => `
      <div><span>${t.rate_pct === 0 ? 'Isento de IVA' : `IVA ${t.rate_pct}%`} sobre ${mzn(t.base_cents)}</span><span>${mzn(t.tax_cents)}</span></div>`).join('');

  const exemptions = summary
    .filter((t) => t.exemption_reason)
    .map((t) => `<div class="foot">Motivo da isenção: ${esc(t.exemption_reason)}</div>`)
    .join('');

  const software = inv.software
    ? `${esc(inv.software.name)} v${esc(inv.software.version)} · Certificado AT: ${esc(inv.software.certificate)}${inv.software.certificate === '0' ? ' (não certificado)' : ''}<br>`
    : '';

  const rows = inv.items.map((it) => `
    <tr>
      <td>${esc(it.description)}</td>
      <td class="num">${it.quantity}</td>
      <td class="num">${mzn(it.unit_cents)}</td>
      <td class="num">${mzn(it.total_cents)}</td>
    </tr>`).join('');
  const html = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
    <style>
      * { box-sizing: border-box; } body { font-family: Arial, Helvetica, sans-serif; color:#111; margin:32px; }
      h1 { font-size:20px; margin:0 0 4px; } .muted { color:#555; font-size:12px; }
      .row { display:flex; justify-content:space-between; gap:24px; }
      .box { margin-top:20px; } table { width:100%; border-collapse:collapse; margin-top:16px; font-size:13px; }
      th,td { border-bottom:1px solid #ddd; padding:8px; text-align:left; } th { background:#f5f5f5; }
      td.num, th.num { text-align:right; } .totals { margin-top:12px; width:280px; margin-left:auto; font-size:13px; }
      .totals div { display:flex; justify-content:space-between; padding:4px 0; }
      .totals .grand { border-top:2px solid #111; font-weight:bold; font-size:15px; padding-top:8px; }
      .status { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; font-weight:bold; margin-top:8px; }
      .paid { background:#e6f6ec; color:#0a7d3b; } .issued { background:#fdf2e2; color:#a8720f; } .void { background:#eee; color:#666; }
      .foot { margin-top:32px; font-size:11px; color:#777; }
    </style></head><body>
    <div class="row">
      <div>
        <h1>${esc(inv.issuer?.name ?? 'Fatura')}</h1>
        <div class="muted">NUIT: ${esc(inv.issuer?.tax_id ?? '')}</div>
        <div class="muted">${esc(inv.issuer?.address ?? '')}</div>
        <div class="muted">${esc(inv.issuer?.email ?? '')}</div>
      </div>
      <div style="text-align:right">
        <div class="muted"><strong>${esc(DOC_TYPE_LABEL[inv.doc_type] ?? 'Documento')}</strong> · Original</div>
        <h1>${esc(inv.number)}</h1>
        <div class="muted">Emitida: ${esc(fdate(inv.issued_at))}</div>
        <span class="status ${inv.status}">${esc(STATUS_LABEL[inv.status])}</span>
      </div>
    </div>
    <div class="box">
      <div class="muted"><strong>Cliente</strong></div>
      <div>${esc(inv.client_name)}</div>
      ${inv.client_tax_id ? `<div class="muted">NUIT: ${esc(inv.client_tax_id)}</div>` : ''}
      ${inv.client_address ? `<div class="muted">${esc(inv.client_address)}</div>` : ''}
      ${inv.client_email ? `<div class="muted">${esc(inv.client_email)}</div>` : ''}
      ${inv.tracking_code ? `<div class="muted">Pedido: ${esc(inv.tracking_code)}</div>` : ''}
      ${inv.related_number ? `<div class="muted">Retifica o documento: <strong>${esc(inv.related_number)}</strong></div>` : ''}
    </div>
    <table>
      <thead><tr><th>Descrição</th><th class="num">Qtd</th><th class="num">Preço</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal (sem IVA)</span><span>${mzn(inv.subtotal_cents)}</span></div>
      ${taxRows}
      <div class="grand"><span>Total</span><span>${mzn(inv.total_cents)}</span></div>
      ${inv.status === 'paid' ? `<div class="muted" style="justify-content:flex-end">Pago${inv.payment_method ? ` · ${esc(inv.payment_method)}` : ''} em ${esc(fdate(inv.paid_at))}</div>` : ''}
    </div>
    ${exemptions}
    <div class="foot">
      ${inv.hash_control ? `Assinatura do documento: <strong>${esc(inv.hash_control)}</strong> — Processado por computador.<br>` : ''}
      ${software}
      ${esc(inv.notes ?? '')}
    </div>
    <script>window.onload = function(){ window.print(); }</script>
    </body></html>`;
  const w = window.open('', '_blank', 'width=800,height=900');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}
