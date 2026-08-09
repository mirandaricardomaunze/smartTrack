'use client';

/**
 * @file page.tsx
 * @description Acerto de caixa do motorista (COD) — abrir e reconciliar.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.5
 *
 * O numerário (CASH) é o que o motorista entrega em caixa; mobile money é
 * informativo (já na conta). Sem emojis — apenas SVG.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type DriverSettlement,
  type SettlementStats,
  type BackendDriver,
  type Order,
} from '@/services/api';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { exportReportPdf } from '@/services/documentPdf';
import { Button, Card, Input, PageHeader, StatCard } from '@/components/ui';

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

function IconClose({ className = 'w-6 h-6' }: { className?: string }) {
  return (<svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>);
}

interface PendingDriver {
  driverId: string;
  cash: number;
  mobile: number;
  count: number;
}

export default function AcertosPage() {
  const { profile } = useCompanyProfile();
  const [settlements, setSettlements] = useState<DriverSettlement[]>([]);
  const [stats, setStats] = useState<SettlementStats | null>(null);
  const [drivers, setDrivers] = useState<BackendDriver[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openingDriver, setOpeningDriver] = useState<string | null>(null);

  // Modal de reconciliação
  const [reconcileTarget, setReconcileTarget] = useState<DriverSettlement | null>(null);
  const [receivedInput, setReceivedInput] = useState('');
  const [reconcileNotes, setReconcileNotes] = useState('');
  const [reconcileSubmitting, setReconcileSubmitting] = useState(false);
  const [reconcileError, setReconcileError] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [s, statsData, drv, ords] = await Promise.all([
        adminApi.getSettlements(),
        adminApi.getSettlementStats().catch(() => null),
        adminApi.getDrivers().catch(() => [] as BackendDriver[]),
        adminApi.getOrders().catch(() => [] as Order[]),
      ]);
      setSettlements(s);
      setStats(statsData);
      setDrivers(drv);
      setOrders(ords);
    } catch {
      setError('Não foi possível carregar os acertos. Confirme que o backend está a correr.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const driverName = (id: string) => drivers.find((d) => d.id === id)?.name ?? id;

  /**
   * Mapa de acertos em PDF timbrado (spec § 3.17) — é o documento que se
   * arquiva ou entrega ao motorista como comprovativo do numerário.
   */
  const exportPdf = async () => {
    await exportReportPdf({
      title: 'Acertos de caixa',
      subtitle: 'Cobrança na entrega (COD) e reconciliação do numerário por motorista',
      tables: [{
        columns: [
          { header: 'Motorista', width: 3 },
          { header: 'Aberto em', width: 2 },
          { header: 'Pedidos', width: 1.1, align: 'right' },
          { header: 'Esperado', width: 2, align: 'right' },
          { header: 'Recebido', width: 2, align: 'right' },
          { header: 'Diferença', width: 2, align: 'right' },
          { header: 'Estado', width: 1.6 },
        ],
        rows: settlements.map((s) => [
          driverName(s.driver_id),
          new Date(s.opened_at).toLocaleDateString('pt-PT'),
          String(s.order_count),
          formatCurrency(s.expected_cash_cents),
          s.received_cash_cents == null ? '—' : formatCurrency(s.received_cash_cents),
          s.difference_cents == null ? '—' : formatCurrency(s.difference_cents),
          s.status === 'open' ? 'Aberto' : 'Reconciliado',
        ]),
        totals: [
          { label: 'Numerário esperado', value: formatCurrency(settlements.reduce((sum, s) => sum + s.expected_cash_cents, 0)) },
          { label: 'Numerário recebido', value: formatCurrency(settlements.reduce((sum, s) => sum + (s.received_cash_cents ?? 0), 0)), strong: true },
        ],
        emptyLabel: 'Sem acertos registados.',
      }],
      notes: ['O mobile money é informativo — o valor já entrou em conta. Só o numerário passa por caixa.'],
      filename: `acertos-caixa-${new Date().toISOString().slice(0, 10)}.pdf`,
    }, profile);
  };

  // COD recolhido por acertar, agrupado por motorista (deriva das encomendas).
  const pendingByDriver: PendingDriver[] = (() => {
    const map = new Map<string, PendingDriver>();
    for (const o of orders) {
      if (o.codStatus !== 'collected' || !o.cod || !o.driver) continue;
      const e = map.get(o.driver) ?? { driverId: o.driver, cash: 0, mobile: 0, count: 0 };
      if (o.cod.method === 'CASH') e.cash += o.cod.amount;
      else e.mobile += o.cod.amount;
      e.count += 1;
      map.set(o.driver, e);
    }
    return [...map.values()].sort((a, b) => b.cash - a.cash);
  })();

  const handleOpen = async (driverId: string) => {
    setOpeningDriver(driverId);
    setError('');
    try {
      await adminApi.openSettlement(driverId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Falha ao abrir o acerto.');
    } finally {
      setOpeningDriver(null);
    }
  };

  const openReconcile = (s: DriverSettlement) => {
    setReconcileTarget(s);
    setReceivedInput(String(s.expected_cash_cents));
    setReconcileNotes('');
    setReconcileError('');
  };

  const handleReconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reconcileTarget) return;
    const received = parseInt(receivedInput, 10);
    if (Number.isNaN(received) || received < 0) { setReconcileError('Informe um valor válido (centavos).'); return; }
    setReconcileSubmitting(true);
    setReconcileError('');
    try {
      await adminApi.reconcileSettlement(reconcileTarget.id, received, reconcileNotes.trim() || undefined);
      setReconcileTarget(null);
      await loadData();
    } catch (err) {
      setReconcileError(err instanceof Error && err.message ? err.message : 'Falha ao reconciliar.');
    } finally {
      setReconcileSubmitting(false);
    }
  };

  const previewDiff = reconcileTarget ? (parseInt(receivedInput, 10) || 0) - reconcileTarget.expected_cash_cents : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Acertos de Caixa"
        description="Cobrança na entrega (COD) e reconciliação do numerário por motorista."
        actions={<Button variant="primary" size="sm" onClick={exportPdf} disabled={settlements.length === 0}>Exportar PDF</Button>}
      />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={loadData}>Tentar Novamente</Button>
        </div>
      )}

      <div className="stats-grid">
        <StatCard label="Acertos abertos" value={stats ? stats.open : settlements.filter((s) => s.status === 'open').length} helper="À espera do numerário" />
        <StatCard label="Reconciliados" value={stats ? stats.reconciled : settlements.filter((s) => s.status === 'reconciled').length} helper="Fechados" />
        <StatCard label="Numerário pendente" value={formatCurrency(stats ? stats.pendingCashCents : pendingByDriver.reduce((s, d) => s + d.cash, 0))} helper="Por acertar" />
        <StatCard label="Motoristas com pendências" value={stats ? stats.driversPending : pendingByDriver.length} helper="Com COD por acertar" />
      </div>

      {/* Motoristas com COD por acertar */}
      <Card>
        <h3 className="text-sm font-bold text-slate-100 mb-1">Por acertar</h3>
        <p className="text-xs text-slate-500 mb-4">Motoristas com COD cobrado e ainda não acertado. Abrir um acerto agrupa as cobranças.</p>
        {loading ? (
          <p className="text-xs text-slate-500 py-4 text-center">A carregar...</p>
        ) : pendingByDriver.length === 0 ? (
          <p className="text-xs text-slate-500 py-6 text-center bg-surface/30 rounded-xl">Sem cobranças COD por acertar.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {pendingByDriver.map((d) => (
              <div key={d.driverId} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-surface/50 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-100 truncate">{driverName(d.driverId)}</p>
                  <p className="text-[11px] text-slate-500">{d.count} encomenda(s)</p>
                </div>
                <div className="flex items-center gap-4 text-xs whitespace-nowrap">
                  <div className="text-right">
                    <span className="block text-[10px] text-slate-500 uppercase">Numerário</span>
                    <span className="font-bold text-emerald-400">{formatCurrency(d.cash)}</span>
                  </div>
                  <div className="text-right">
                    <span className="block text-[10px] text-slate-500 uppercase">Mobile</span>
                    <span className="font-semibold text-slate-300">{formatCurrency(d.mobile)}</span>
                  </div>
                  <Button size="sm" variant="primary" loading={openingDriver === d.driverId} onClick={() => handleOpen(d.driverId)}>
                    Abrir acerto
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Histórico de acertos */}
      <div className="table-wrapper">
        <table className="data-table min-w-[860px]">
          <thead>
            <tr>
              <th className="min-w-[160px]">Motorista</th>
              <th className="w-[90px] text-center">Pedidos</th>
              <th className="w-[130px] text-right">Esp. numerário</th>
              <th className="w-[130px] text-right">Recebido</th>
              <th className="w-[130px] text-right">Diferença</th>
              <th className="w-[110px]">Estado</th>
              <th className="w-[130px] text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="text-center py-8 text-slate-500">A carregar...</td></tr>
            ) : settlements.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-8 text-slate-500">Nenhum acerto registado.</td></tr>
            ) : (
              settlements.map((s) => {
                const diff = s.difference_cents;
                return (
                  <tr key={s.id}>
                    <td className="font-semibold text-slate-200">{driverName(s.driver_id)}</td>
                    <td className="text-center">{s.order_count}</td>
                    <td className="text-right font-semibold">{formatCurrency(s.expected_cash_cents)}</td>
                    <td className="text-right">{s.received_cash_cents == null ? <span className="text-slate-600">—</span> : formatCurrency(s.received_cash_cents)}</td>
                    <td className="text-right font-semibold">
                      {diff == null ? <span className="text-slate-600">—</span>
                        : diff === 0 ? <span className="text-emerald-400">0</span>
                        : diff > 0 ? <span className="text-amber-400">+{formatCurrency(diff)}</span>
                        : <span className="text-red-400">{formatCurrency(diff)}</span>}
                    </td>
                    <td>
                      <span className={`badge ${s.status === 'reconciled' ? 'badge-success' : 'badge-warning'}`}>
                        {s.status === 'reconciled' ? 'Reconciliado' : 'Aberto'}
                      </span>
                    </td>
                    <td className="text-right">
                      {s.status === 'open' && (
                        <Button size="sm" variant="primary" onClick={() => openReconcile(s)}>Reconciliar</Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal de reconciliação */}
      {reconcileTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Reconciliar acerto</span>
                <h2 className="text-lg font-bold text-slate-100 mt-0.5">{driverName(reconcileTarget.driver_id)}</h2>
              </div>
              <button onClick={() => setReconcileTarget(null)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar"><IconClose /></button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs bg-surface/50 border border-white/[0.04] rounded-xl p-3">
              <div>
                <span className="block text-[10px] text-slate-500 uppercase">Esperado (numerário)</span>
                <span className="font-bold text-slate-100">{formatCurrency(reconcileTarget.expected_cash_cents)}</span>
              </div>
              <div>
                <span className="block text-[10px] text-slate-500 uppercase">Encomendas</span>
                <span className="font-semibold text-slate-200">{reconcileTarget.order_count}</span>
              </div>
            </div>

            {reconcileError && <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">{reconcileError}</div>}

            <form onSubmit={handleReconcile} className="flex flex-col gap-4">
              <Input
                label="Numerário recebido (centavos)"
                type="number"
                min={0}
                value={receivedInput}
                onChange={(e) => setReceivedInput(e.target.value)}
                required
              />
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Diferença</span>
                <span className={`font-bold ${previewDiff === 0 ? 'text-emerald-400' : previewDiff > 0 ? 'text-amber-400' : 'text-red-400'}`}>
                  {previewDiff > 0 ? '+' : ''}{formatCurrency(previewDiff)} {previewDiff < 0 ? '(falta)' : previewDiff > 0 ? '(sobra)' : ''}
                </span>
              </div>
              <Input label="Observação (opcional)" value={reconcileNotes} onChange={(e) => setReconcileNotes(e.target.value)} placeholder="Ex.: entregou em duas vezes" />
              <div className="flex justify-end gap-2 mt-1">
                <Button type="button" variant="secondary" onClick={() => setReconcileTarget(null)} disabled={reconcileSubmitting}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={reconcileSubmitting}>Reconciliar</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
