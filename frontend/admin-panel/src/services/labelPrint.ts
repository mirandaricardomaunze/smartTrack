/**
 * @file labelPrint.ts
 * @description Impressão de etiquetas de expedição (com código de barras Code128).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.15
 *
 * Abre uma janela com uma ou mais etiquetas (~100x60mm) e dispara a impressão.
 * O código de barras codifica o código de rastreio para leitura no armazém.
 * Sem dependências externas. Sem emojis.
 */
import { toSvg } from './code128';

export interface LabelData {
  trackingCode: string;
  client: string;
  destination: string;
  valueCents?: number;
  codCents?: number;
  extra?: string;    // ex.: "Grande Maputo · Expresso · 3.5 kg"
  brand?: string;    // default 'SmartTrack'
}

function mzn(cents?: number): string {
  if (cents == null) return '';
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(cents / 100);
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function labelHtml(l: LabelData): string {
  const barcode = toSvg(l.trackingCode, { module: 1.7, height: 54 });
  const cod = l.codCents && l.codCents > 0 ? `<span class="cod">COD ${mzn(l.codCents)}</span>` : '';
  const value = l.valueCents != null ? `<span>Frete ${mzn(l.valueCents)}</span>` : '';
  return `<div class="label">
    <div class="top">
      <span class="brand">${esc(l.brand ?? 'SmartTrack')}</span>
      ${l.extra ? `<span class="extra">${esc(l.extra)}</span>` : ''}
    </div>
    <div class="dest">
      <span class="muted">Destino</span>
      <strong>${esc(l.destination)}</strong>
      <span class="client">${esc(l.client)}</span>
    </div>
    <div class="barcode">${barcode}</div>
    <div class="code">${esc(l.trackingCode)}</div>
    <div class="foot">${value}${cod}</div>
  </div>`;
}

/** Abre uma janela com as etiquetas e imprime. */
export function printLabels(labels: LabelData[]): void {
  if (!labels.length) return;
  const html = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Etiquetas</title>
    <style>
      * { box-sizing: border-box; margin:0; padding:0; }
      body { font-family: Arial, Helvetica, sans-serif; color:#111; background:#fff; }
      .label { width:100mm; height:60mm; padding:5mm; border:1px solid #000; display:flex; flex-direction:column;
               page-break-after: always; break-after: page; }
      .top { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #000; padding-bottom:3px; }
      .brand { font-weight:bold; font-size:14px; letter-spacing:.5px; }
      .extra { font-size:10px; color:#333; }
      .dest { margin-top:6px; display:flex; flex-direction:column; }
      .dest .muted { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:#666; }
      .dest strong { font-size:16px; }
      .dest .client { font-size:12px; color:#333; }
      .barcode { margin-top:auto; text-align:center; }
      .barcode svg { max-width:100%; height:54px; }
      .code { text-align:center; font-family: "Courier New", monospace; font-size:13px; letter-spacing:2px; margin-top:2px; }
      .foot { display:flex; justify-content:space-between; font-size:11px; margin-top:4px; border-top:1px solid #000; padding-top:3px; }
      .foot .cod { font-weight:bold; }
      @media print { .label { border:none; } }
    </style></head><body>
    ${labels.map(labelHtml).join('')}
    <script>window.onload = function(){ window.print(); }</script>
    </body></html>`;
  const w = window.open('', '_blank', 'width=820,height=640');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}
