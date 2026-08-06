'use client';

/**
 * @file page.tsx
 * @description Rastreio Internacional — registar códigos, polling e timeline normalizada.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.10, § 8.3, § 6
 *
 * Consome o tracking-intl-service via o gateway (/v1/tracking). Ambiente simulado
 * e determinístico (sem chamadas reais). Sem emojis — apenas SVG.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type TrackedShipment,
  type TrackingStats,
  type TrackingDetail,
  type CycleResult,
} from '@/services/api';
import { Button, DataTable, PageHeader, Pagination, StatCard, paginationMeta, type DataTableColumn } from '@/components/ui';

// ─── Rótulos de status canônico (StatusMapper) ───────────────────────────────

const STATUS_LABELS: Record<string, { label: string; badge: string }> = {
  created:              { label: 'Criado',             badge: 'badge-brand' },
  collected:            { label: 'Coletado',           badge: 'badge-info' },
  in_transit:           { label: 'Em Trânsito',        badge: 'badge-info' },
  at_warehouse:         { label: 'No Armazém',         badge: 'badge-warning' },
  awaiting_destination: { label: 'Aguardando Destino', badge: 'badge-warning' },
  out_for_delivery:     { label: 'Saiu para Entrega',  badge: 'badge-warning' },
  delivered:            { label: 'Entregue',           badge: 'badge-success' },
  failed:               { label: 'Insucesso',          badge: 'badge-error' },
  cancelled:            { label: 'Cancelado',          badge: 'badge-neutral' },
};

function statusMeta(status: string | null) {
  if (!status) return { label: 'Sem eventos', badge: 'badge-neutral' };
  return STATUS_LABELS[status] ?? { label: status, badge: 'badge-neutral' };
}

// ─── Ícones (SVG) ─────────────────────────────────────────────────────────────

function IconGlobe({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21C9.5 18.5 8.2 15.3 8.2 12S9.5 5.5 12 3z" />
    </svg>
  );
}
function IconPlus({ className = 'w-4 h-4' }: { className?: string }) {
  return (<svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>);
}
function IconRefresh({ className = 'w-4 h-4' }: { className?: string }) {
  return (<svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>);
}
function IconClose({ className = 'w-6 h-6' }: { className?: string }) {
  return (<svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>);
}
function IconLocation({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export default function RastreioInternacionalPage() {
  const [shipments, setShipments] = useState<TrackedShipment[]>([]);
  const [stats, setStats] = useState<TrackingStats | null>(null);
  const [carriers, setCarriers] = useState<string[]>([]);
  const [simulated, setSimulated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Ciclo de polling
  const [cycleRunning, setCycleRunning] = useState(false);
  const [cycleResult, setCycleResult] = useState<CycleResult | null>(null);

  // Poll por linha
  const [pollingCode, setPollingCode] = useState<string | null>(null);

  // Modal de registo
  const [isRegOpen, setIsRegOpen] = useState(false);
  const [regCode, setRegCode] = useState('');
  const [regCarrier, setRegCarrier] = useState('');
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regError, setRegError] = useState('');

  // Modal de timeline
  const [detail, setDetail] = useState<TrackingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [list, statsData] = await Promise.all([
        adminApi.getTrackingShipments(),
        adminApi.getTrackingStats().catch(() => null),
      ]);
      setShipments(list);
      setStats(statsData);
    } catch {
      setError('Não foi possível carregar o rastreio internacional. Confirme que o backend está a correr.');
      setShipments([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    void adminApi.getTrackingCarriers().then(setCarriers).catch(() => setCarriers(['17TRACK', 'CAINIAO', 'CORREIOS_BR']));
    void adminApi.getTrackingProvider().then((p) => setSimulated(p.simulated)).catch(() => setSimulated(false));
  }, [loadData]);

  const openRegister = () => {
    setRegCode('');
    setRegCarrier(carriers[0] ?? '17TRACK');
    setRegError('');
    setIsRegOpen(true);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regCode.trim()) { setRegError('Informe o código de rastreio.'); return; }
    if (!regCarrier) { setRegError('Selecione a transportadora.'); return; }
    setRegSubmitting(true);
    setRegError('');
    try {
      await adminApi.registerTracking(regCode.trim().toUpperCase(), regCarrier);
      setIsRegOpen(false);
      await loadData();
    } catch (err) {
      setRegError(err instanceof Error && err.message ? err.message : 'Falha ao registar o rastreio.');
    } finally {
      setRegSubmitting(false);
    }
  };

  const handleCycle = async () => {
    setCycleRunning(true);
    setCycleResult(null);
    try {
      const r = await adminApi.runTrackingCycle();
      setCycleResult(r);
      await loadData();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Falha ao executar o ciclo de polling.');
    } finally {
      setCycleRunning(false);
    }
  };

  const handlePoll = async (s: TrackedShipment) => {
    setPollingCode(s.trackingCode);
    try {
      await adminApi.pollTracking(s.trackingCode, s.carrier);
      await loadData();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Falha ao consultar a transportadora.');
    } finally {
      setPollingCode(null);
    }
  };

  const openTimeline = async (code: string) => {
    setDetailLoading(true);
    setDetailError('');
    setDetail({ trackingCode: code, carrier: '', currentStatus: '', events: [] });
    try {
      const d = await adminApi.getTrackingDetail(code);
      setDetail(d);
    } catch (err) {
      setDetailError(err instanceof Error && err.message ? err.message : 'Sem eventos para este código ainda.');
    } finally {
      setDetailLoading(false);
    }
  };

  const pageMeta = paginationMeta(shipments.length, page, pageSize);
  const visibleShipments = shipments.slice((pageMeta.currentPage - 1) * pageSize, pageMeta.currentPage * pageSize);
  const columns: DataTableColumn<TrackedShipment>[] = [
    { key: 'code', header: 'Código', headerClassName: 'min-w-[170px]', cellClassName: 'font-semibold text-brand-400 font-mono whitespace-nowrap', cell: (shipment) => shipment.trackingCode },
    { key: 'carrier', header: 'Transportadora', headerClassName: 'w-[140px]', cell: (shipment) => <span className="badge badge-info">{shipment.carrier}</span> },
    { key: 'status', header: 'Estado atual', headerClassName: 'w-[160px]', cell: (shipment) => { const meta = statusMeta(shipment.currentStatus); return <span className={`badge ${meta.badge}`}>{meta.label}</span>; } },
    { key: 'active', header: 'Acompanhamento', headerClassName: 'w-[130px]', cell: (shipment) => <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${shipment.active ? 'text-emerald-400' : 'text-slate-500'}`}><span className={`h-1.5 w-1.5 rounded-full ${shipment.active ? 'bg-emerald-400' : 'bg-slate-500'}`} />{shipment.active ? 'Ativo' : 'Finalizado'}</span> },
    { key: 'events', header: 'Eventos', headerClassName: 'w-[100px] text-center', cellClassName: 'text-center font-semibold text-slate-300', cell: (shipment) => shipment.eventCount },
    { key: 'poll', header: 'Última consulta', headerClassName: 'w-[150px]', cellClassName: 'text-xs whitespace-nowrap text-slate-400', cell: (shipment) => shipment.lastPolledAt ?? <span className="text-slate-600">Nunca</span> },
    { key: 'actions', header: 'Ações', headerClassName: 'w-[220px] text-right', cellClassName: 'text-right', cell: (shipment) => <div className="flex justify-end gap-2 whitespace-nowrap"><Button size="sm" loading={pollingCode === shipment.trackingCode} onClick={() => void handlePoll(shipment)}>Poll agora</Button><Button size="sm" variant="primary" onClick={() => void openTimeline(shipment.trackingCode)}>Ver timeline</Button></div> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Rastreio Internacional" description="Consolidação de estados de transportadoras (17TRACK, Cainiao, Correios) por polling." actions={<><Button onClick={() => void handleCycle()} loading={cycleRunning} leftIcon={<IconRefresh />}>Executar ciclo</Button><Button onClick={openRegister} variant="primary" leftIcon={<IconPlus />}>Rastrear encomenda</Button></>} />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button onClick={loadData} size="sm" className="shrink-0">Tentar Novamente</Button>
        </div>
      )}

      {simulated && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 p-4 rounded-2xl text-xs flex items-start gap-2">
          <svg className="w-4 h-4 shrink-0 mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            Provedor <strong>não configurado</strong>: a usar o simulador (dados não reais). Para rastreio real, defina{' '}
            <span className="font-mono text-amber-200">TRACK17_API_KEY</span> no ambiente do backend e reinicie.
          </span>
        </div>
      )}

      {cycleResult && (
        <div className="bg-brand-500/10 border border-brand-500/20 text-brand-300 p-4 rounded-2xl text-xs flex items-center justify-between gap-3">
          <span>
            Ciclo concluído: <strong className="text-slate-100">{cycleResult.checked}</strong> código(s) verificado(s),{' '}
            <strong className="text-emerald-400">{cycleResult.newEvents}</strong> evento(s) novo(s),{' '}
            <strong className={cycleResult.failures ? 'text-red-400' : 'text-slate-300'}>{cycleResult.failures}</strong> falha(s).
          </span>
          <button onClick={() => setCycleResult(null)} className="text-slate-500 hover:text-slate-200" aria-label="Fechar"><IconClose className="w-4 h-4" /></button>
        </div>
      )}

      {/* Stats */}
      <div className="stats-grid">
        <StatCard label="Eventos" value={stats ? stats.events : '—'} helper={<span className="text-xs text-slate-500">Leituras normalizadas</span>} />
        <StatCard label="Envios Ativos" value={stats ? stats.activeShipments : shipments.filter((shipment) => shipment.active).length} helper={<span className="text-xs text-slate-500">Em acompanhamento</span>} />
        <StatCard label="Finalizados" value={stats ? stats.finishedShipments : shipments.filter((shipment) => !shipment.active).length} helper={<span className="text-xs text-slate-500">Estado final atingido</span>} />
        <StatCard label="Transportadoras" value={stats ? stats.carriers : new Set(shipments.map((shipment) => shipment.carrier)).size} helper={<span className="text-xs text-slate-500">Distintas</span>} />
      </div>

      {/* Tabela */}
      <div className="table-wrapper">
        {loading ? (
          <div className="p-8 text-center text-slate-500">Carregando envios rastreados...</div>
        ) : shipments.length === 0 ? (
          <div className="p-12 text-center text-slate-500 flex flex-col items-center gap-3">
            <IconGlobe className="w-8 h-8 text-slate-600" />
            <p className="text-sm">Nenhuma encomenda em rastreio internacional.</p>
            <button onClick={openRegister} className="btn btn-primary btn-sm"><IconPlus /> Rastrear a primeira</button>
          </div>
        ) : <DataTable data={visibleShipments} columns={columns} getRowKey={(shipment) => shipment.trackingCode} tableClassName="min-w-[1080px]" footer={<Pagination page={pageMeta.currentPage} pageSize={pageSize} totalItems={shipments.length} itemLabel="envios" onPageChange={setPage} onPageSizeChange={(next) => { setPageSize(next); setPage(1); }} />} />}
      </div>

      {/* ── Modal de registo ── */}
      {isRegOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Rastreio Internacional</span>
                <h2 className="text-lg font-bold text-slate-100 mt-0.5">Rastrear encomenda</h2>
              </div>
              <button onClick={() => setIsRegOpen(false)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar"><IconClose /></button>
            </div>

            {regError && <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">{regError}</div>}

            <form onSubmit={handleRegister} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Código de rastreio</label>
                <input type="text" autoFocus placeholder="LX987654321CN" className="input uppercase font-mono" value={regCode}
                  onChange={(e) => { setRegCode(e.target.value.toUpperCase()); setRegError(''); }} required />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Transportadora</label>
                <select className="input bg-surface-elevated" value={regCarrier} onChange={(e) => setRegCarrier(e.target.value)} required>
                  {carriers.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="text-[10px] text-slate-500 leading-relaxed bg-surface/40 border border-white/[0.05] rounded-xl p-3">
                Ambiente simulado e determinístico: o nº de eventos devolvidos depende do último dígito do código.
                Sufixos <span className="font-mono text-slate-400">-ERR</span> (falha da API) e{' '}
                <span className="font-mono text-slate-400">-EMPTY</span> (sem eventos) permitem testar os percursos.
              </div>
              <div className="flex gap-3 justify-end mt-1">
                <button type="button" onClick={() => setIsRegOpen(false)} className="btn btn-secondary" disabled={regSubmitting}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={regSubmitting}>{regSubmitting ? 'A registar...' : 'Rastrear'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal de timeline ── */}
      {detail && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-2xl card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5 max-h-[88vh] overflow-y-auto">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Timeline Internacional</span>
                <h2 className="text-xl font-extrabold text-slate-100 font-mono mt-0.5">{detail.trackingCode}</h2>
                {detail.carrier && <span className="badge badge-info mt-2 inline-block">{detail.carrier}</span>}
              </div>
              <button onClick={() => setDetail(null)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar"><IconClose /></button>
            </div>

            {detailError && <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs rounded-xl">{detailError}</div>}

            {detailLoading ? (
              <p className="text-xs text-slate-500 py-6 text-center">A carregar timeline...</p>
            ) : detail.events.length === 0 && !detailError ? (
              <p className="text-xs text-slate-500 py-6 text-center bg-surface/30 rounded-xl">Sem eventos registados para este código.</p>
            ) : (
              <div className="relative flex flex-col gap-4 pl-11">
                <div className="absolute left-[17px] top-5 bottom-5 w-px bg-gradient-to-b from-brand-500/60 via-white/10 to-transparent" />
                {detail.events.map((evt, idx) => {
                  const meta = statusMeta(evt.status);
                  const isLatest = idx === 0;
                  return (
                    <div key={evt.id} className={`relative rounded-2xl border p-4 ${isLatest ? 'border-brand-500/25 bg-brand-500/[0.045]' : 'border-white/[0.06] bg-surface/50'}`}>
                      <div className={`absolute -left-[43px] top-4 w-9 h-9 rounded-xl flex items-center justify-center border-2 z-10 ${isLatest ? 'bg-brand-600 border-brand-400 text-white ring-4 ring-brand-500/15' : 'bg-surface-elevated border-white/10 text-slate-500'}`}>
                        <IconGlobe className="w-4 h-4" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`badge ${meta.badge} text-[9px]`}>{meta.label}</span>
                            {isLatest && <span className="text-[9px] font-bold uppercase tracking-widest text-brand-300">Estado atual</span>}
                          </div>
                          <p className="text-[11px] font-mono text-slate-500 shrink-0">{evt.carrierTimestamp}</p>
                        </div>
                        {evt.description && <p className="text-sm text-slate-200 font-medium">{evt.description}</p>}
                        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap pt-1.5 border-t border-white/[0.05]">
                          <span className="text-[10px] text-slate-500">Cru da transportadora: <strong className="text-slate-400 font-mono">{evt.rawStatus}</strong></span>
                          {evt.location && <span className="text-[10px] text-slate-400 inline-flex items-center gap-1"><IconLocation className="w-3 h-3 text-brand-400" /> {evt.location}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex justify-end">
              <button onClick={() => setDetail(null)} className="btn btn-secondary w-full sm:w-auto">Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
