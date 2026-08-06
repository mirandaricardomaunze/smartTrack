'use client';

/**
 * @file page.tsx
 * @description Relatórios & analytics operacionais.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.8, § 3.4
 *
 * Gráficos em SVG (sem libs). Paleta categórica do gráfico de volume validada
 * para daltonismo (dataviz skill): criados #6366f1, entregues #059669. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi, type ReportsSummary, type ReportVolumePoint } from '@/services/api';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { exportReportPdf } from '@/services/documentPdf';
import { Button, Card, PageHeader, StatCard } from '@/components/ui';

// Paleta categórica validada (CVD-safe no fundo escuro) — ordem fixa.
const C_CREATED = '#6366f1';
const C_DELIVERED = '#059669';

const STATUS_META: Record<string, { label: string; color: string }> = {
  created:              { label: 'Criado',             color: '#818cf8' },
  collected:            { label: 'Coletado',           color: '#38bdf8' },
  in_transit:           { label: 'Em Trânsito',        color: '#0ea5e9' },
  at_warehouse:         { label: 'No Armazém',         color: '#f59e0b' },
  awaiting_destination: { label: 'Aguardando Destino', color: '#eab308' },
  out_for_delivery:     { label: 'Saiu p/ Entrega',    color: '#f97316' },
  delivered:            { label: 'Entregue',           color: '#10b981' },
  failed:               { label: 'Insucesso',          color: '#ef4444' },
  cancelled:            { label: 'Cancelado',          color: '#64748b' },
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

function formatDayShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('pt-MZ', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

// ─── Gráfico de volume (linha, 2 séries) ─────────────────────────────────────

function VolumeChart({ data }: { data: ReportVolumePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240;
  const padL = 36, padR = 16, padT = 16, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = data.length;

  const yMax = Math.max(1, ...data.map((d) => Math.max(d.created, d.delivered)));
  const x = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / yMax) * plotH;

  const line = (key: 'created' | 'delivered') => data.map((d, i) => `${x(i)},${y(d[key])}`).join(' ');
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const labelEvery = Math.ceil(n / 7);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Volume de pedidos criados e entregues por dia">
        {/* Grelha (recessiva) */}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 3} textAnchor="end" className="fill-slate-500" style={{ fontSize: 9 }}>{v}</text>
          </g>
        ))}
        {/* Eixo X */}
        {data.map((d, i) => (i % labelEvery === 0 || i === n - 1) ? (
          <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 9 }}>{formatDayShort(d.date)}</text>
        ) : null)}
        {/* Linhas */}
        <polyline points={line('created')} fill="none" stroke={C_CREATED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={line('delivered')} fill="none" stroke={C_DELIVERED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* Crosshair + marcadores no hover */}
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
            <circle cx={x(hover)} cy={y(data[hover].created)} r="4" fill={C_CREATED} stroke="#161b27" strokeWidth="2" />
            <circle cx={x(hover)} cy={y(data[hover].delivered)} r="4" fill={C_DELIVERED} stroke="#161b27" strokeWidth="2" />
          </>
        )}
        {/* Rótulos diretos no último ponto (secondary encoding p/ CVD) */}
        {n > 0 && (
          <>
            <text x={x(n - 1) + 4} y={y(data[n - 1].created)} className="fill-slate-300" style={{ fontSize: 9, fontWeight: 700 }}>{data[n - 1].created}</text>
            <text x={x(n - 1) + 4} y={y(data[n - 1].delivered)} className="fill-slate-300" style={{ fontSize: 9, fontWeight: 700 }}>{data[n - 1].delivered}</text>
          </>
        )}
        {/* Zonas de hover */}
        {data.map((d, i) => (
          <rect key={d.date} x={x(i) - (plotW / Math.max(1, n)) / 2} y={padT} width={plotW / Math.max(1, n)} height={plotH}
            fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))} />
        ))}
      </svg>

      {/* Legenda */}
      <div className="flex items-center gap-4 justify-center mt-1 text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-slate-400"><span className="w-3 h-[3px] rounded-full" style={{ background: C_CREATED }} /> Criados</span>
        <span className="inline-flex items-center gap-1.5 text-slate-400"><span className="w-3 h-[3px] rounded-full" style={{ background: C_DELIVERED }} /> Entregues</span>
      </div>

      {/* Tooltip */}
      {hover != null && (
        <div
          className="pointer-events-none absolute -top-1 z-10 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-white/10 text-[11px] shadow-xl whitespace-nowrap"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <p className="font-semibold text-slate-200">{formatDayShort(data[hover].date)}</p>
          <p style={{ color: C_CREATED }}>Criados: <strong>{data[hover].created}</strong></p>
          <p style={{ color: '#34d399' }}>Entregues: <strong>{data[hover].delivered}</strong></p>
        </div>
      )}
    </div>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────

const RANGES = [7, 14, 30];

export default function RelatoriosPage() {
  const { profile } = useCompanyProfile();
  const [data, setData] = useState<ReportsSummary | null>(null);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async (d: number) => {
    try {
      setLoading(true);
      setError('');
      setData(await adminApi.getReportsSummary(d));
    } catch {
      setError('Não foi possível carregar os relatórios. Confirme que o backend está a correr.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(days); }, [loadData, days]);

  const exportCsv = () => {
    if (!data) return;
    const lines = [
      'Métrica,Valor',
      `Total de pedidos,${data.overview.total}`,
      `Entregues,${data.overview.delivered}`,
      `Insucessos,${data.overview.failed}`,
      `Taxa de sucesso (%),${data.overview.success_rate_pct}`,
      `Tempo médio de entrega (h),${data.overview.avg_delivery_hours}`,
      `Entregues em ate 48h (%),${data.overview.within_48h_pct}`,
      `Valor total (MZN),${(data.overview.total_value_cents / 100).toFixed(2)}`,
      `COD numerario (MZN),${(data.overview.cod_collected_cash_cents / 100).toFixed(2)}`,
      '',
      'Motorista,Entregues,Insucessos,Taxa (%),COD numerario (MZN)',
      ...data.byDriver.map((d) => `${d.name},${d.delivered},${d.failed},${d.success_rate_pct},${(d.cod_cash_cents / 100).toFixed(2)}`),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `relatorio-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Relatório em PDF com o papel timbrado da empresa (spec § 3.17). */
  const exportPdf = async () => {
    if (!data) return;
    const o = data.overview;
    await exportReportPdf({
      title: 'Relatório operacional',
      subtitle: `Desempenho logístico dos últimos ${days} dias`,
      meta: [{ label: 'Período', value: `${days} dias` }],
      tables: [
        {
          title: 'Indicadores',
          columns: [{ header: 'Métrica', width: 4 }, { header: 'Valor', width: 2, align: 'right' }],
          rows: [
            ['Total de pedidos', String(o.total)],
            ['Entregues', String(o.delivered)],
            ['Insucessos', String(o.failed)],
            ['Taxa de sucesso', `${o.success_rate_pct}%`],
            ['Tempo médio de entrega', `${o.avg_delivery_hours} h`],
            ['Entregues em até 48h', `${o.within_48h_pct}%`],
            ['Valor total', formatCurrency(o.total_value_cents)],
            ['COD em numerário', formatCurrency(o.cod_collected_cash_cents)],
          ],
        },
        {
          title: 'Distribuição por estado',
          columns: [{ header: 'Estado', width: 4 }, { header: 'Pedidos', width: 2, align: 'right' }],
          rows: data.status.map((s) => [STATUS_META[s.status]?.label ?? s.status, String(s.count)]),
        },
        {
          title: 'Desempenho por motorista',
          columns: [
            { header: 'Motorista', width: 4 },
            { header: 'Entregues', width: 1.4, align: 'right' },
            { header: 'Insucessos', width: 1.4, align: 'right' },
            { header: 'Taxa', width: 1.2, align: 'right' },
            { header: 'COD numerário', width: 2, align: 'right' },
          ],
          rows: data.byDriver.map((d) => [
            d.name, String(d.delivered), String(d.failed), `${d.success_rate_pct}%`, formatCurrency(d.cod_cash_cents),
          ]),
          emptyLabel: 'Sem entregas atribuídas no período.',
        },
      ],
      filename: `relatorio-operacional-${new Date().toISOString().slice(0, 10)}.pdf`,
    }, profile);
  };

  const ov = data?.overview;
  const maxStatus = data ? Math.max(1, ...data.status.map((s) => s.count)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Relatórios"
        description="Desempenho logístico, volume e por motorista."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex rounded-xl border border-white/10 overflow-hidden">
              {RANGES.map((r) => (
                <button key={r} onClick={() => setDays(r)}
                  className={`px-3 h-10 text-xs font-semibold transition-colors ${days === r ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-slate-400 hover:text-slate-200'}`}>
                  {r}d
                </button>
              ))}
            </div>
            <Button variant="secondary" onClick={exportCsv} disabled={!data}>CSV</Button>
            <Button variant="primary" onClick={exportPdf} disabled={!data}>Exportar PDF</Button>
          </div>
        }
      />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => loadData(days)}>Tentar Novamente</Button>
        </div>
      )}

      {loading || !ov ? (
        <div className="p-12 text-center text-slate-500">A carregar relatórios...</div>
      ) : (
        <>
          {/* KPIs */}
          <div className="stats-grid">
            <StatCard label="Total de pedidos" value={ov.total} helper={`${ov.active} ativos`} />
            <StatCard label="Taxa de sucesso" value={`${ov.success_rate_pct}%`} helper={`${ov.delivered} entregues · ${ov.failed} insucessos`} />
            <StatCard label="Tempo médio de entrega" value={`${ov.avg_delivery_hours}h`} helper={`${ov.within_48h_pct}% em ate 48h`} />
            <StatCard label="Valor total" value={formatCurrency(ov.total_value_cents)} helper={`COD numerário ${formatCurrency(ov.cod_collected_cash_cents)}`} />
          </div>

          {/* Volume */}
          <Card>
            <div className="mb-3">
              <h3 className="text-sm font-bold text-slate-100">Volume por dia</h3>
              <p className="text-xs text-slate-500">Pedidos criados vs entregues nos últimos {days} dias.</p>
            </div>
            <VolumeChart data={data.volume} />
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Distribuição por estado */}
            <Card>
              <h3 className="text-sm font-bold text-slate-100 mb-1">Distribuição por estado</h3>
              <p className="text-xs text-slate-500 mb-4">Pedidos por estado atual.</p>
              {data.status.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">Sem dados.</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {data.status.map((s) => {
                    const meta = STATUS_META[s.status] ?? { label: s.status, color: '#64748b' };
                    return (
                      <div key={s.status} className="flex items-center gap-3 text-xs">
                        <span className="w-28 shrink-0 text-slate-400">{meta.label}</span>
                        <div className="flex-1 h-4 rounded bg-surface-overlay overflow-hidden">
                          <div className="h-full rounded" style={{ width: `${(s.count / maxStatus) * 100}%`, background: meta.color }} />
                        </div>
                        <span className="w-8 text-right font-semibold text-slate-200">{s.count}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Ranking de motoristas */}
            <Card>
              <h3 className="text-sm font-bold text-slate-100 mb-1">Desempenho por motorista</h3>
              <p className="text-xs text-slate-500 mb-4">Ordenado por entregas.</p>
              {data.byDriver.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center">Nenhum pedido atribuído a motoristas.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table min-w-[420px]">
                    <thead>
                      <tr>
                        <th>Motorista</th>
                        <th className="text-center">Entregues</th>
                        <th className="text-center">Insucessos</th>
                        <th className="text-center">Taxa</th>
                        <th className="text-right">COD numerário</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byDriver.map((d) => (
                        <tr key={d.driver_id}>
                          <td className="font-semibold text-slate-200">{d.name}</td>
                          <td className="text-center text-emerald-400 font-semibold">{d.delivered}</td>
                          <td className="text-center text-red-400">{d.failed}</td>
                          <td className="text-center">{d.success_rate_pct}%</td>
                          <td className="text-right font-mono text-xs">{formatCurrency(d.cod_cash_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <p className="text-[10px] text-slate-600 text-right">Gerado em {new Date(data.generated_at).toLocaleString('pt-MZ')}</p>
        </>
      )}
    </div>
  );
}
