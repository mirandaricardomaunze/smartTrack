'use client';

/**
 * @file page.tsx
 * @description Fiscal — mapa de IVA, integridade do arquivo, SAF-T e séries.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * É a página que o contabilista abre no fim do mês: o apuramento do IVA por
 * taxa (com as notas de crédito já subtraídas), o ficheiro de auditoria para
 * entregar, a prova de que o arquivo não foi adulterado e as séries de
 * numeração em uso. Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type TaxReport,
  type IntegrityReport,
  type DocumentSeries,
  type DocType,
} from '@/services/api';
import { useAdminUser } from '@/hooks/useAdminUser';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { exportTaxReportPdf, exportIntegrityPdf } from '@/services/documentPdf';
import { Button, Card, Input, Select, PageHeader, StatCard, DataTable } from '@/components/ui';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

/** Período corrente em AAAA-MM (UTC, como o backend). */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

const DOC_TYPE_OPTIONS: Array<{ value: DocType; label: string }> = [
  { value: 'FT', label: 'FT — Fatura' },
  { value: 'FR', label: 'FR — Fatura-recibo' },
  { value: 'NC', label: 'NC — Nota de crédito' },
  { value: 'ND', label: 'ND — Nota de débito' },
  { value: 'RC', label: 'RC — Recibo' },
];

export default function FiscalPage() {
  const { role, isAuthenticated } = useAdminUser();
  const { profile } = useCompanyProfile();
  const [period, setPeriod] = useState(currentPeriod());
  const [report, setReport] = useState<TaxReport | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null);
  const [series, setSeries] = useState<DocumentSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Nova série
  const [formOpen, setFormOpen] = useState(false);
  const [newType, setNewType] = useState<DocType>('FT');
  const [newSeries, setNewSeries] = useState('');
  const [formError, setFormError] = useState('');

  const isAdmin = role === 'ADMIN';

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [r, i, s] = await Promise.all([
        adminApi.getTaxReport(period),
        adminApi.getFiscalIntegrity(),
        adminApi.getDocumentSeries(),
      ]);
      setReport(r);
      setIntegrity(i);
      setSeries(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar os dados fiscais.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { if (isAdmin) void load(); else setLoading(false); }, [isAdmin, load]);

  const downloadSaft = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { filename, xml } = await adminApi.downloadSaft(period);
      const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setNotice(`Ficheiro ${filename} gerado. Entregue-o ao contabilista ou guarde-o no arquivo do período.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao gerar o ficheiro SAF-T.');
    } finally {
      setBusy(false);
    }
  };

  /** Mapa de IVA em PDF timbrado — é o que segue para o contabilista. */
  const downloadTaxReportPdf = async () => {
    if (!report) return;
    setBusy(true);
    setError('');
    try {
      await exportTaxReportPdf(report, profile);
      setNotice(`Mapa de IVA de ${report.period} exportado em PDF.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao gerar o PDF do mapa de IVA.');
    } finally {
      setBusy(false);
    }
  };

  /** Prova documental de que o arquivo não foi adulterado. */
  const downloadIntegrityPdf = async () => {
    if (!integrity) return;
    setBusy(true);
    setError('');
    try {
      await exportIntegrityPdf(integrity, profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao gerar o PDF de integridade.');
    } finally {
      setBusy(false);
    }
  };

  const submitSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    try {
      await adminApi.createDocumentSeries(newType, newSeries);
      setFormOpen(false);
      setNewSeries('');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Falha ao criar a série.');
    }
  };

  if (isAuthenticated && !isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Fiscal" description="Obrigações fiscais da empresa." />
        <Card className="p-10 text-center text-sm text-slate-400">
          Esta área é do <strong className="text-slate-200">administrador</strong> da empresa.
        </Card>
      </div>
    );
  }

  const brokenChains = integrity?.chains.filter((c) => !c.ok) ?? [];
  const unsignedTotal = integrity?.chains.reduce((s, c) => s + c.unsigned, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Fiscal"
        description="Apuramento do IVA, arquivo inviolável e ficheiro de auditoria."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => load()}>Atualizar</Button>
            <Button variant="secondary" size="sm" loading={busy} onClick={downloadSaft}>Exportar SAF-T</Button>
            <Button variant="primary" size="sm" loading={busy} onClick={downloadTaxReportPdf}>Mapa de IVA (PDF)</Button>
          </div>
        }
      />

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}
      {notice && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-2xl text-xs">{notice}</div>
      )}

      {/* ── Apuramento do período ── */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <Input
          label="Período" type="month" value={period} className="text-xs" containerClassName="sm:w-52"
          onChange={(e) => setPeriod(e.target.value || currentPeriod())}
        />
        <p className="text-xs text-slate-500 pb-2">
          As notas de crédito do período entram com sinal negativo, como na declaração.
        </p>
      </div>

      <div className="stats-grid">
        <StatCard label="Base tributável" value={report ? mzn(report.totals.base_cents) : '—'} helper={`Período ${report?.period ?? period}`} />
        <StatCard label="IVA liquidado" value={report ? mzn(report.totals.tax_cents) : '—'} helper="A entregar ao Estado" />
        <StatCard label="Total faturado" value={report ? mzn(report.totals.gross_cents) : '—'} helper="Base + imposto" />
        <StatCard
          label="Arquivo"
          value={integrity ? (integrity.ok ? 'Íntegro' : 'Com falhas') : '—'}
          helper={integrity ? `${integrity.chains.length} série(s) verificada(s)` : ''}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Mapa de IVA */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-slate-100">Mapa de IVA por taxa</h2>
          <DataTable<NonNullable<TaxReport['lines']>[number]>
            data={report?.lines ?? []}
            loading={loading}
            getRowKey={(l) => `${l.rate_pct}-${l.exemption_code ?? ''}`}
            emptyTitle="Sem movimento no período"
            emptyDescription="Não há documentos emitidos neste período."
            columns={[
              { key: 'rate', header: 'Taxa', cell: (l) => (
                <div className="flex flex-col">
                  <span className="text-slate-200">{l.label}</span>
                  {l.exemption_reason && <span className="text-[11px] text-slate-500">{l.exemption_reason}</span>}
                </div>
              ) },
              { key: 'base', header: 'Base', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (l) => mzn(l.base_cents) },
              { key: 'tax', header: 'IVA', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (l) => mzn(l.tax_cents) },
              { key: 'docs', header: 'Docs', headerClassName: 'text-center', cellClassName: 'text-center text-xs', cell: (l) => l.documents },
            ]}
          />

          <h2 className="text-sm font-bold text-slate-100 mt-2">Documentos emitidos</h2>
          <DataTable<NonNullable<TaxReport['documents']>[number]>
            data={report?.documents ?? []}
            loading={loading}
            getRowKey={(d) => d.doc_type}
            emptyTitle="Sem documentos"
            emptyDescription="Nada emitido neste período."
            columns={[
              { key: 'type', header: 'Tipo', cell: (d) => (
                <span className="text-slate-200"><span className="font-mono text-xs text-slate-400">{d.doc_type}</span> · {d.label}</span>
              ) },
              { key: 'total', header: 'Emitidos', headerClassName: 'text-center', cellClassName: 'text-center text-xs', cell: (d) => d.total },
              { key: 'void', header: 'Anulados', headerClassName: 'text-center', cellClassName: 'text-center text-xs', cell: (d) => d.voided },
              { key: 'value', header: 'Valor', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (d) => mzn(d.total_cents) },
            ]}
          />
        </div>

        {/* Integridade + séries */}
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-100">Integridade do arquivo</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Recalcula a assinatura de cada documento e procura saltos na numeração.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {integrity && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${integrity.ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                    {integrity.ok ? 'Sem violações' : 'Verificar'}
                  </span>
                )}
                <Button size="sm" variant="ghost" loading={busy} onClick={downloadIntegrityPdf}>PDF</Button>
              </div>
            </div>

            {integrity?.chains.map((c) => (
              <div key={`${c.doc_type}-${c.series}`} className="rounded-xl bg-surface-elevated p-3 text-xs flex flex-col gap-1">
                <div className="flex justify-between">
                  <span className="text-slate-300 font-semibold">{c.doc_type} · série {c.series}</span>
                  <span className={c.ok ? 'text-emerald-400' : 'text-red-400'}>{c.ok ? 'íntegra' : 'com falhas'}</span>
                </div>
                <span className="text-slate-500">{c.checked} documento(s){c.unsigned > 0 ? ` · ${c.unsigned} anterior(es) à conformidade fiscal` : ''}</span>
                {c.broken.map((b) => (
                  <span key={b.number} className="text-red-400">{b.number}: {b.reason}</span>
                ))}
                {c.gaps.map((g, i) => (
                  <span key={i} className="text-amber-400">Salto na numeração: esperado {g.expected}, encontrado {g.found}.</span>
                ))}
              </div>
            ))}

            {unsignedTotal > 0 && (
              <p className="text-[11px] text-slate-500">
                Os documentos anteriores à conformidade fiscal não foram assinados na origem —
                assiná-los agora fabricaria uma prova que não existiu, por isso são apenas contados.
              </p>
            )}
            {brokenChains.length > 0 && (
              <p className="text-[11px] text-red-400">
                Uma cadeia com falhas significa que um documento foi alterado fora do sistema.
                Guarde este relatório e reponha a partir de cópia de segurança.
              </p>
            )}

            {integrity && (
              <p className="text-[11px] text-slate-500 border-t border-white/[0.06] pt-2">
                Software: {integrity.software.name} v{integrity.software.version} · Certificado AT:{' '}
                <span className="font-mono">{integrity.software.certificate}</span>
                {integrity.software.certificate === '0' && ' (não certificado)'}
              </p>
            )}
          </Card>

          <Card className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-100">Séries de numeração</h2>
                <p className="text-xs text-slate-500 mt-0.5">Cada série numera de forma independente.</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => { setFormOpen(true); setFormError(''); }}>Nova série</Button>
            </div>

            {series.length === 0 && !loading && (
              <p className="text-xs text-slate-500">Ainda não há séries — a primeira é criada na primeira emissão.</p>
            )}
            {series.map((s) => (
              <div key={s.id} className="flex justify-between items-center text-xs rounded-xl bg-surface-elevated px-3 py-2">
                <span className="text-slate-200"><span className="font-mono">{s.doc_type} {s.series}{s.year}</span></span>
                <span className="text-slate-500">último nº {String(s.last_seq).padStart(4, '0')}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      {report && (
        <p className="text-[11px] text-slate-500">
          Emitente: {report.issuer.name} · NUIT {report.issuer.tax_id}. Confirme sempre o apuramento
          com o seu contabilista antes de submeter a declaração — o sistema prepara os números, não
          substitui o parecer técnico nem a certificação do software pela AT.
        </p>
      )}

      {/* Modal: nova série */}
      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setFormOpen(false)}>
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={submitSeries} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">Nova série</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>Fechar</Button>
              </div>
              <Select
                label="Tipo de documento" value={newType} className="text-xs"
                onChange={(e) => setNewType(e.target.value as DocType)}
                options={DOC_TYPE_OPTIONS}
              />
              <Input
                label="Série" value={newSeries} className="text-xs font-mono" placeholder="A, LOJA1..."
                onChange={(e) => setNewSeries(e.target.value)}
              />
              <p className="text-[11px] text-slate-500">
                1 a 6 caracteres. A numeração começa no 1 e nunca reutiliza um número.
              </p>
              {formError && <p className="text-xs text-red-400">{formError}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>Cancelar</Button>
                <Button type="submit" variant="primary">Criar</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
