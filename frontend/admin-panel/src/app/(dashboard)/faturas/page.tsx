'use client';

/**
 * @file page.tsx
 * @description Faturação — documentos fiscais, detalhe imprimível e retificação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.14 (Faturação)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Lista todos os documentos emitidos ao cliente — faturas e notas de crédito —
 * com o IVA por taxa e a assinatura de inviolabilidade. Um documento pago não se
 * anula: retifica-se com nota de crédito. Impressão via janela dedicada.
 * Valores em MZN. Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi, type Invoice, type InvoiceStats, type InvoiceStatus, type DocType } from '@/services/api';
import { printInvoice } from '@/services/invoicePrint';
import { exportInvoicePdf } from '@/services/documentPdf';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { Button, Card, Input, Select, PageHeader, StatCard, DataTable, Pagination } from '@/components/ui';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}
function fdate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString('pt-MZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

const STATUS_META: Record<InvoiceStatus, { label: string; cls: string }> = {
  issued: { label: 'Emitida', cls: 'bg-amber-500/15 text-amber-400' },
  paid:   { label: 'Paga',    cls: 'bg-emerald-500/15 text-emerald-400' },
  void:   { label: 'Anulada', cls: 'bg-slate-500/15 text-slate-400' },
};

const DOC_TYPE_META: Record<DocType, { label: string; cls: string }> = {
  FT: { label: 'Fatura',         cls: 'bg-brand-500/15 text-brand-400' },
  FR: { label: 'Fatura-recibo',  cls: 'bg-brand-500/15 text-brand-400' },
  NC: { label: 'Nota de crédito', cls: 'bg-purple-500/15 text-purple-300' },
  ND: { label: 'Nota de débito',  cls: 'bg-purple-500/15 text-purple-300' },
  RC: { label: 'Recibo',          cls: 'bg-slate-500/15 text-slate-300' },
};

function StatusBadge({ status }: { status: InvoiceStatus }) {
  const m = STATUS_META[status];
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>;
}

function DocTypeBadge({ type }: { type: DocType }) {
  const m = DOC_TYPE_META[type] ?? DOC_TYPE_META.FT;
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>;
}

export default function FaturasPage() {
  const { profile } = useCompanyProfile();
  const [items, setItems] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | InvoiceStatus>('');
  const [typeFilter, setTypeFilter] = useState<'' | DocType>('');
  const [stats, setStats] = useState<InvoiceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);
  // Retificação: anular (antes de paga) ou nota de crédito (depois).
  const [creditTarget, setCreditTarget] = useState<Invoice | null>(null);
  const [creditReason, setCreditReason] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditError, setCreditError] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [res, s] = await Promise.all([
        adminApi.getInvoices({ search: search || undefined, status: statusFilter || undefined, doc_type: typeFilter || undefined, page, pageSize }),
        adminApi.getInvoiceStats().catch(() => null),
      ]);
      setItems(res.items);
      setTotal(res.total);
      setStats(s);
    } catch {
      setError('Não foi possível carregar as faturas.');
      setItems([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, typeFilter, page, pageSize]);

  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);

  const openDetail = async (inv: Invoice) => {
    setDetail(inv);
    try { setDetail(await adminApi.getInvoice(inv.id)); } catch { /* mantém resumo */ }
  };

  /**
   * PDF com o papel timbrado da empresa. Vai buscar o detalhe completo primeiro:
   * a listagem não traz o emissor nem o software, que têm de sair no documento.
   */
  const downloadPdf = async (inv: Invoice) => {
    setBusy(true);
    try {
      const full = inv.issuer ? inv : await adminApi.getInvoice(inv.id).catch(() => inv);
      await exportInvoicePdf(full, profile);
    } catch {
      setError('Falha ao gerar o PDF do documento.');
    } finally { setBusy(false); }
  };

  const pay = async (inv: Invoice) => {
    setBusy(true);
    try {
      const updated = await adminApi.payInvoice(inv.id);
      setDetail((d) => (d && d.id === inv.id ? { ...d, ...updated } : d));
      await load();
    } catch { setError('Falha ao marcar como paga.'); } finally { setBusy(false); }
  };

  const voidInv = async (inv: Invoice) => {
    const reason = window.prompt('Motivo da anulação (fica registado no arquivo fiscal):', 'Emitida por engano');
    if (reason === null) return;
    setBusy(true);
    try {
      const updated = await adminApi.voidInvoice(inv.id, reason);
      setDetail((d) => (d && d.id === inv.id ? { ...d, ...updated } : d));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao anular o documento.');
    } finally { setBusy(false); }
  };

  const submitCreditNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creditTarget) return;
    setBusy(true);
    setCreditError('');
    try {
      const cents = creditAmount ? Math.round(parseFloat(creditAmount) * 100) : undefined;
      const note = await adminApi.createCreditNote(creditTarget.id, creditReason, cents);
      setCreditTarget(null);
      setCreditReason('');
      setCreditAmount('');
      setDetail(null);
      await load();
      setError('');
      // A nota de crédito é para entregar ao cliente: sai logo em PDF timbrado.
      await exportInvoicePdf(note, profile);
    } catch (err) {
      setCreditError(err instanceof Error ? err.message : 'Falha ao emitir a nota de crédito.');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Faturas"
        description="Documentos fiscais emitidos ao cliente — numerados por série e assinados."
      />

      <div className="stats-grid">
        <StatCard label="Emitidas (por cobrar)" value={stats ? mzn(stats.issued_total_cents) : '—'} helper={`${stats?.issued ?? 0} faturas`} />
        <StatCard label="Cobrado (pagas)" value={stats ? mzn(stats.paid_total_cents) : '—'} helper={`${stats?.paid ?? 0} faturas`} />
        <StatCard label="Creditado" value={stats ? mzn(stats.credited_total_cents) : '—'} helper={`${stats?.credit_notes ?? 0} nota(s) de crédito`} />
        <StatCard label="Total de faturas" value={stats?.total ?? '—'} helper={`${stats?.void ?? 0} anuladas`} />
      </div>

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <Input label="Pesquisar" placeholder="Número, cliente ou código" value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="text-xs" containerClassName="flex-1" />
        <Select label="Estado" value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value as '' | InvoiceStatus); }}
          options={[{ value: '', label: 'Todos' }, { value: 'issued', label: 'Emitidas' }, { value: 'paid', label: 'Pagas' }, { value: 'void', label: 'Anuladas' }]}
          className="text-xs" containerClassName="sm:w-44" />
        <Select label="Tipo" value={typeFilter} onChange={(e) => { setPage(1); setTypeFilter(e.target.value as '' | DocType); }}
          options={[{ value: '', label: 'Todos' }, { value: 'FT', label: 'Faturas' }, { value: 'FR', label: 'Faturas-recibo' }, { value: 'NC', label: 'Notas de crédito' }]}
          className="text-xs" containerClassName="sm:w-44" />
      </div>

      <DataTable<Invoice>
        data={items}
        loading={loading}
        getRowKey={(i) => i.id}
        emptyTitle="Nenhuma fatura"
        emptyDescription="Emita faturas a partir do detalhe de um pedido."
        columns={[
          { key: 'number', header: 'Documento', cell: (i) => (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs font-semibold text-slate-200">{i.number}</span>
              <div className="flex items-center gap-1.5">
                <DocTypeBadge type={i.doc_type} />
                {i.related_number && <span className="text-[10px] text-slate-500">ref. {i.related_number}</span>}
              </div>
            </div>
          ) },
          { key: 'client', header: 'Cliente', cell: (i) => (
            <div className="flex flex-col">
              <span className="text-slate-200">{i.client_name}</span>
              {i.tracking_code && <span className="font-mono text-[11px] text-slate-500">{i.tracking_code}</span>}
            </div>
          ) },
          { key: 'date', header: 'Emitida', cellClassName: 'text-xs text-slate-400', cell: (i) => fdate(i.issued_at) },
          { key: 'total', header: 'Total', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (i) => mzn(i.total_cents) },
          { key: 'status', header: 'Estado', cell: (i) => <StatusBadge status={i.status} /> },
          { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right', cell: (i) => (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => openDetail(i)}>Ver</Button>
              <Button size="sm" variant="ghost" onClick={() => downloadPdf(i)}>PDF</Button>
            </div>
          ) },
        ]}
        footer={<Pagination page={page} pageSize={pageSize} totalItems={total} itemLabel="faturas"
          onPageChange={setPage} onPageSizeChange={(s) => { setPage(1); setPageSize(s); }} />}
      />

      {/* Detalhe */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-100 font-mono">{detail.number}</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Emitida em {fdate(detail.issued_at)}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <StatusBadge status={detail.status} />
                  <DocTypeBadge type={detail.doc_type} />
                </div>
              </div>

              <div className="text-xs text-slate-400">
                <p className="text-slate-300 font-semibold">{detail.client_name}</p>
                {detail.client_tax_id && <p>NUIT: <span className="font-mono">{detail.client_tax_id}</span></p>}
                {detail.tracking_code && <p>Pedido: <span className="font-mono">{detail.tracking_code}</span></p>}
                {detail.related_number && (
                  <p className="text-purple-300">Retifica o documento <span className="font-mono">{detail.related_number}</span></p>
                )}
              </div>

              <div className="rounded-xl bg-surface-elevated p-3 flex flex-col gap-1.5 text-xs">
                {detail.items.map((it, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="text-slate-400">
                      {it.description}
                      {it.tax_rate_pct !== undefined && <span className="text-slate-600"> · IVA {it.tax_rate_pct}%</span>}
                    </span>
                    <span className="font-mono">{mzn(it.total_cents)}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1"><span className="text-slate-400">Subtotal</span><span className="font-mono">{mzn(detail.subtotal_cents)}</span></div>
                {/* IVA discriminado por taxa (spec § 3.19). */}
                {(detail.tax_summary ?? []).map((t, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="text-slate-400">
                      {t.rate_pct === 0 ? 'Isento' : `IVA ${t.rate_pct}%`}
                      <span className="text-slate-600"> sobre {mzn(t.base_cents)}</span>
                    </span>
                    <span className="font-mono">{mzn(t.tax_cents)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-bold text-slate-100"><span>Total</span><span className="font-mono">{mzn(detail.total_cents)}</span></div>
                {detail.credited_cents > 0 && (
                  <div className="flex justify-between text-purple-300"><span>Já creditado</span><span className="font-mono">-{mzn(detail.credited_cents)}</span></div>
                )}
              </div>

              {(detail.tax_summary ?? []).filter((t) => t.exemption_reason).map((t, idx) => (
                <p key={idx} className="text-[11px] text-slate-500">Isenção: {t.exemption_reason}</p>
              ))}

              {detail.status === 'paid' && (
                <p className="text-xs text-emerald-400">Paga{detail.payment_method ? ` · ${detail.payment_method}` : ''} em {fdate(detail.paid_at)}</p>
              )}
              {detail.status === 'void' && detail.void_reason && (
                <p className="text-xs text-slate-400">Anulada: {detail.void_reason}</p>
              )}

              {detail.hash_control && (
                <p className="text-[11px] text-slate-500 border-t border-white/[0.06] pt-2">
                  Assinatura: <span className="font-mono text-slate-400">{detail.hash_control}</span>
                  {detail.software && ` · ${detail.software.name} v${detail.software.version}`}
                  {' '}— documento inviolável, encadeado no anterior da série.
                </p>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-3">
                <Button variant="primary" size="sm" loading={busy} onClick={() => downloadPdf(detail)}>Descarregar PDF</Button>
                <Button variant="secondary" size="sm" onClick={() => printInvoice(detail)}>Imprimir</Button>
                {detail.doc_type !== 'NC' && detail.status === 'issued' && (
                  <Button variant="primary" size="sm" loading={busy} onClick={() => pay(detail)}>Marcar paga</Button>
                )}
                {detail.doc_type !== 'NC' && detail.status !== 'void' && detail.credited_cents < detail.total_cents && (
                  <Button variant="secondary" size="sm" onClick={() => { setCreditTarget(detail); setCreditReason(''); setCreditAmount(''); setCreditError(''); }}>
                    Nota de crédito
                  </Button>
                )}
                {detail.status === 'issued' && (
                  <Button variant="ghost" size="sm" className="text-red-400" loading={busy} onClick={() => voidInv(detail)}>Anular</Button>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Nota de crédito — a via legal para corrigir um documento já entregue */}
      {creditTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={() => setCreditTarget(null)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={submitCreditNote} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">Nota de crédito</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreditTarget(null)}>Fechar</Button>
              </div>

              <div className="rounded-xl bg-surface-elevated p-3 text-xs flex flex-col gap-1.5">
                <div className="flex justify-between"><span className="text-slate-400">Documento</span><span className="font-mono">{creditTarget.number}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Cliente</span><span>{creditTarget.client_name}</span></div>
                <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1 font-bold text-slate-100">
                  <span>Por creditar</span>
                  <span className="font-mono">{mzn(creditTarget.total_cents - creditTarget.credited_cents)}</span>
                </div>
              </div>

              <Input
                label="Motivo da retificação" value={creditReason} className="text-xs"
                placeholder="Ex.: serviço não prestado; cliente cancelou a entrega"
                onChange={(e) => setCreditReason(e.target.value)}
              />
              <Input
                label="Valor a creditar (MZN) — vazio credita tudo" type="number" min="0" step="0.01"
                value={creditAmount} className="text-xs"
                onChange={(e) => setCreditAmount(e.target.value)}
              />

              <p className="text-[11px] text-slate-500">
                A nota de crédito é um documento novo, numerado e assinado, que referencia
                {' '}<span className="font-mono">{creditTarget.number}</span>. O original mantém-se no
                arquivo — é assim que a correção fica auditável.
              </p>

              {creditError && <p className="text-xs text-red-400">{creditError}</p>}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setCreditTarget(null)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={busy}>Emitir e descarregar</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
