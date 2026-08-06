'use client';

import { useState } from 'react';
import { fetchTrackingStatus, requestShipment } from '@/services/api';
import { Button, Input } from '@/components/ui';

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────
interface Evento {
  status: string;
  descricao: string;
  localizacao: string;
  timestamp: string;
}

interface Pedido {
  codigoRastreio: string;
  statusAtual: string;
  statusCode: string;
  origem: string;
  destino: string;
  historico: Evento[];
}

/** Estados em que o cliente pode solicitar o envio para um destino (spec § 8.2). */
const WAREHOUSE_CODES = ['at_warehouse', 'awaiting_destination'];

// ────────────────────────────────────────────────────────────────────────────
// Configuração visual da timeline (mapeamento de status → ícone/cor)
// ────────────────────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  // ── Nacionais ──
  'Criado': {
    color: 'text-slate-400',
    bg: 'bg-slate-700/60 border-slate-600/40',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  'Coletado': {
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10" />
      </svg>
    ),
  },
  'Em Trânsito': {
    color: 'text-indigo-400',
    bg: 'bg-indigo-500/10 border-indigo-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0" />
      </svg>
    ),
  },
  'No Armazém': {
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
  'Saiu para Entrega': {
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  'Entregue': {
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  // ── Internacionais ──
  'Saiu da Origem': {
    color: 'text-purple-400',
    bg: 'bg-purple-500/10 border-purple-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
      </svg>
    ),
  },
  'Em Trânsito Internacional': {
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10 border-cyan-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  'Despacho Aduaneiro': {
    color: 'text-rose-400',
    bg: 'bg-rose-500/10 border-rose-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  },
  'Recebido pela transportadora': {
    color: 'text-teal-400',
    bg: 'bg-teal-500/10 border-teal-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
      </svg>
    ),
  },
};

// Fallback para status desconhecido
function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? {
    color: 'text-slate-400',
    bg: 'bg-slate-700/60 border-slate-600/40',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Barra de progresso de etapas (estilo Shein)
// ────────────────────────────────────────────────────────────────────────────
const PROGRESS_STEPS = [
  { key: 'criado',            label: 'Pedido',      matchStatuses: ['Criado'] },
  { key: 'coletado',          label: 'Coletado',    matchStatuses: ['Coletado', 'Saiu da Origem'] },
  { key: 'transito',          label: 'Em Trânsito', matchStatuses: ['Em Trânsito', 'Em Trânsito Internacional', 'Despacho Aduaneiro', 'No Armazém', 'Recebido pela transportadora'] },
  { key: 'saiu',              label: 'Saiu p/ Entrega', matchStatuses: ['Saiu para Entrega'] },
  { key: 'entregue',          label: 'Entregue',    matchStatuses: ['Entregue'] },
];

function getProgressIndex(historico: Evento[]): number {
  for (let i = PROGRESS_STEPS.length - 1; i >= 0; i--) {
    const step = PROGRESS_STEPS[i];
    if (historico.some(e => step.matchStatuses.some(s => e.status.toLowerCase().includes(s.toLowerCase())))) {
      return i;
    }
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Formata timestamp ISO ou string legível
// ────────────────────────────────────────────────────────────────────────────
function formatTs(ts: string): { date: string; time: string } {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) {
      // Já é string legível como "18/07/2026 15:30"
      const parts = ts.split(' ');
      return { date: parts[0] || ts, time: parts[1] || '' };
    }
    return {
      date: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }),
      time: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    };
  } catch {
    return { date: ts, time: '' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Dados de fallback (backend offline)
// ────────────────────────────────────────────────────────────────────────────
const FALLBACK_DB: Record<string, Pedido> = {
  'TRK00000001BR': {
    codigoRastreio: 'TRK00000001BR',
    statusAtual: 'Em Trânsito',
    statusCode: 'in_transit',
    origem: 'São Paulo - SP',
    destino: 'Rio de Janeiro - RJ',
    historico: [
      { status: 'Em Trânsito',  descricao: 'Encomenda em transferência entre filiais',       localizacao: 'São Paulo - SP', timestamp: new Date().toISOString() },
      { status: 'Coletado',     descricao: 'Encomenda coletada pela equipe de logística',    localizacao: 'São Paulo - SP', timestamp: new Date(Date.now() - 3600000).toISOString() },
      { status: 'Criado',       descricao: 'Pedido registrado no sistema',                   localizacao: 'São Paulo - SP', timestamp: new Date(Date.now() - 7200000).toISOString() },
    ],
  },
  'LX987654321CN': {
    codigoRastreio: 'LX987654321CN',
    statusAtual: 'No Armazém',
    statusCode: 'at_warehouse',
    origem: 'Shenzhen - China',
    destino: 'Belo Horizonte - MG',
    historico: [
      { status: 'No Armazém',                  descricao: 'Encomenda recebida no hub nacional de triagem',   localizacao: 'Curitiba - PR',              timestamp: new Date().toISOString() },
      { status: 'Despacho Aduaneiro',           descricao: 'Liberado pela Receita Federal do Brasil',        localizacao: 'Aeroporto de Guarulhos - SP', timestamp: new Date(Date.now() - 86400000).toISOString() },
      { status: 'Em Trânsito Internacional',    descricao: 'Encomenda em trânsito rumo ao Brasil',           localizacao: 'Hong Kong',                  timestamp: new Date(Date.now() - 172800000).toISOString() },
      { status: 'Saiu da Origem',               descricao: 'Pedido despachado pelo remetente',               localizacao: 'Shenzhen - China',            timestamp: new Date(Date.now() - 604800000).toISOString() },
    ],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Componente Principal
// ────────────────────────────────────────────────────────────────────────────
export default function Home() {
  const [code,     setCode]     = useState('');
  const [pedido,   setPedido]   = useState<Pedido | null>(null);
  const [searched, setSearched] = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  const [reqDestino, setReqDestino] = useState('');
  const [reqNotes, setReqNotes] = useState('');
  const [reqCoords, setReqCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [reqGeoLoading, setReqGeoLoading] = useState(false);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqError, setReqError] = useState('');
  const [reqDone, setReqDone] = useState(false);

  function resetRequestForm(p: Pedido | null) {
    setReqDestino(p?.destino || '');
    setReqNotes('');
    setReqCoords(null);
    setReqGeoLoading(false);
    setReqError('');
    setReqDone(false);
  }

  const captureLocation = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setReqError('Este navegador não suporta geolocalização.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setReqError('O navegador só permite GPS em HTTPS ou localhost.');
      return;
    }
    setReqGeoLoading(true);
    setReqError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setReqCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setReqGeoLoading(false);
      },
      () => {
        setReqGeoLoading(false);
        setReqError('Não foi possível obter a sua localização.');
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );
  };

  const handleRequestShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pedido) return;
    if (!reqDestino.trim()) {
      setReqError('Informe o destino de entrega.');
      return;
    }

    setReqSubmitting(true);
    setReqError('');
    try {
      const updated = await requestShipment(
        pedido.codigoRastreio,
        reqDestino.trim(),
        reqNotes.trim() || undefined,
        reqCoords ?? undefined,
      );
      setPedido(updated);
      setReqDone(true);
    } catch (err) {
      setReqError(err instanceof Error ? err.message : 'Falha ao solicitar o envio.');
    } finally {
      setReqSubmitting(false);
    }
  };

  const isInternational = (pedido?.codigoRastreio ?? code)
    ? !((pedido?.codigoRastreio ?? code).toUpperCase().endsWith('BR'))
    : false;

  const progressIndex = pedido ? getProgressIndex(pedido.historico) : 0;

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearched(true);
    setLoading(true);
    setIsOffline(false);

    try {
      const data = await fetchTrackingStatus(code.toUpperCase().trim());
      setPedido(data);
      resetRequestForm(data);
    } catch {
      setIsOffline(true);
      const found = FALLBACK_DB[code.toUpperCase().trim()];
      setPedido(found ?? null);
      resetRequestForm(found ?? null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 py-10 max-w-2xl mx-auto w-full">

      {/* ── Hero ── */}
      <div className="text-center flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Rastreie seu Pedido</h1>
        <p className="text-slate-400 text-sm">Acompanhe o trajeto em tempo real — nacional ou internacional.</p>
      </div>

      {/* ── Search bar ── */}
      <form onSubmit={handleSearch} className="w-full flex gap-3">
        <Input
          type="text"
          placeholder="Código de rastreio (ex: TRK00000001BR ou LX987654321CN)"
          className="font-mono uppercase"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <Button type="submit" variant="primary" className="shrink-0 px-6" loading={loading}>Buscar</Button>
      </form>

      {/* ── Aviso offline ── */}
      {isOffline && searched && (
        <div className="w-full bg-amber-500/10 border border-amber-500/20 text-amber-400 p-3.5 rounded-xl text-xs flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          Servidor offline — exibindo dados locais de demonstração.
        </div>
      )}

      {/* ── Resultados ── */}
      {searched && !loading && (
        <div className="w-full animate-fade-in">
          {pedido ? (
            <div className="flex flex-col gap-5">

              {/* ──── Card de cabeçalho ──── */}
              <div className="card p-5 flex flex-col gap-4">
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-bold text-white font-mono">{pedido.codigoRastreio}</h2>
                      {isInternational && (
                        <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                          Internacional
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      <span className="text-slate-400">De:</span> {pedido.origem} &nbsp;→&nbsp;
                      <span className="text-slate-400">Para:</span> {pedido.destino}
                    </p>
                  </div>
                  <span className="badge badge-brand shrink-0">{pedido.statusAtual ?? pedido.historico[0]?.status}</span>
                </div>

                {/* ──── Barra de progresso estilo Shein ──── */}
                <div className="mt-2">
                  <div className="flex items-center">
                    {PROGRESS_STEPS.map((step, idx) => {
                      const done    = idx <= progressIndex;
                      const current = idx === progressIndex;
                      const isLast  = idx === PROGRESS_STEPS.length - 1;

                      return (
                        <div key={step.key} className="flex items-center flex-1 last:flex-none">
                          {/* Dot */}
                          <div className="flex flex-col items-center gap-1.5">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${
                              current ? 'border-brand-400 bg-brand-500/20 ring-4 ring-brand-500/20' :
                              done    ? 'border-brand-500 bg-brand-500' :
                                        'border-slate-700 bg-surface-elevated'
                            }`}>
                              {done && !current ? (
                                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7"/>
                                </svg>
                              ) : current ? (
                                <span className="w-2.5 h-2.5 rounded-full bg-brand-400 animate-pulse"/>
                              ) : (
                                <span className="w-2 h-2 rounded-full bg-slate-600"/>
                              )}
                            </div>
                            <span className={`text-[9px] font-semibold whitespace-nowrap leading-tight text-center ${
                              done ? 'text-brand-400' : 'text-slate-600'
                            }`}>{step.label}</span>
                          </div>

                          {/* Linha conectora */}
                          {!isLast && (
                            <div className="flex-1 h-0.5 mx-1 mb-4 rounded-full overflow-hidden bg-slate-700/80">
                              <div className={`h-full rounded-full transition-all duration-700 ${
                                idx < progressIndex ? 'w-full bg-brand-500' : 'w-0 bg-brand-500'
                              }`}/>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {pedido.statusCode && WAREHOUSE_CODES.includes(pedido.statusCode) && !reqDone && (
                <div className="card p-5 flex flex-col gap-4 border-brand-500/30 bg-brand-500/[0.04]">
                  <div>
                    <h3 className="text-sm font-bold text-white">A sua encomenda está no armazém</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      Confirme para onde quer que seja entregue e solicite o envio.
                    </p>
                  </div>

                  {reqError && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">
                      {reqError}
                    </div>
                  )}

                  <form onSubmit={handleRequestShipment} className="flex flex-col gap-3">
                    <Input
                        label="Destino de entrega"
                        type="text"
                        placeholder="Cidade - Província"
                        value={reqDestino}
                        onChange={(e) => setReqDestino(e.target.value)}
                        required
                      />

                    <div>
                      <label className="block text-xs font-semibold text-slate-400 mb-1.5">Localização (opcional)</label>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          type="button"
                          onClick={captureLocation}
                          disabled={reqGeoLoading}
                          size="sm"
                          variant="secondary"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8a4 4 0 100 8 4 4 0 000-8z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v3m0 14v3m10-10h-3M5 12H2" />
                          </svg>
                          {reqGeoLoading ? 'A localizar...' : 'Usar a minha localização'}
                        </Button>
                        {reqCoords && (
                          <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            {reqCoords.lat.toFixed(5)}, {reqCoords.lng.toFixed(5)}
                            <Button type="button" size="sm" variant="ghost" onClick={() => setReqCoords(null)} className="ml-1 h-auto min-h-0 px-1 py-0 font-sans">remover</Button>
                          </span>
                        )}
                      </div>
                    </div>

                    <Button type="submit" variant="primary" loading={reqSubmitting} fullWidth className="mt-1">Solicitar envio para este destino</Button>
                  </form>
                </div>
              )}

              {reqDone && (
                <div className="card p-5 flex items-start gap-3 border-emerald-500/30 bg-emerald-500/[0.06]">
                  <svg className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <h3 className="text-sm font-bold text-emerald-300">Envio solicitado</h3>
                    <p className="text-xs text-slate-400 mt-1">
                      O seu pedido segue agora para <strong className="text-slate-200">{pedido.destino}</strong>. Acompanhe o estado abaixo.
                    </p>
                  </div>
                </div>
              )}

              {/* ──── Timeline estilo Shein ──── */}
              <div className="card p-5 flex flex-col gap-1">
                <h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center gap-2">
                  <svg className="w-4 h-4 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                  </svg>
                  Histórico de Movimentações
                </h3>

                <div className="relative">
                  {/* Linha vertical de fundo */}
                  <div className="absolute left-[22px] top-0 bottom-0 w-0.5 bg-gradient-to-b from-brand-500/50 via-slate-700/50 to-transparent rounded-full" />

                  <div className="flex flex-col gap-3">
                    {pedido.historico.map((evt, idx) => {
                      const cfg     = getStatusConfig(evt.status);
                      const isMostRecent = idx === 0;
                      const { date, time } = formatTs(evt.timestamp);

                      return (
                        <div
                          key={idx}
                          className={`relative flex gap-4 items-start p-4 rounded-2xl border transition-all duration-300 ${
                            isMostRecent
                              ? `${cfg.bg} shadow-lg shadow-brand-500/5`
                              : 'bg-transparent border-transparent hover:bg-surface-elevated/50'
                          }`}
                        >
                          {/* Ícone / Dot */}
                          <div className={`relative z-10 shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center border-2 ${
                            isMostRecent
                              ? `border-current ${cfg.color} bg-slate-900/60`
                              : 'border-slate-700/60 bg-surface-elevated text-slate-500'
                          }`}>
                            <span className={isMostRecent ? cfg.color : 'text-slate-500'}>
                              {cfg.icon}
                            </span>
                          </div>

                          {/* Conteúdo */}
                          <div className="flex-1 min-w-0 pt-0.5">
                            <div className="flex items-start justify-between gap-2">
                              <h4 className={`text-sm font-bold leading-tight ${
                                isMostRecent ? cfg.color : 'text-slate-300'
                              }`}>
                                {evt.status}
                                {isMostRecent && (
                                  <span className="ml-2 inline-block px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest rounded bg-brand-500/20 text-brand-400">
                                    Atual
                                  </span>
                                )}
                              </h4>
                              <div className="text-right shrink-0">
                                <p className="text-[10px] font-bold text-slate-400">{date}</p>
                                {time && <p className="text-[10px] text-slate-600">{time}</p>}
                              </div>
                            </div>

                            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{evt.descricao}</p>

                            {/* Localização */}
                            <div className="flex items-center gap-1 mt-2">
                              <svg className="w-3 h-3 text-slate-600 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
                              </svg>
                              <span className="text-[11px] text-slate-500 font-medium">{evt.localizacao}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* ── Não encontrado ── */
            <div className="card text-center py-12 border-red-500/10">
              <svg className="w-14 h-14 text-red-500/30 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 01-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 011-.96 19.97 19.97 0 007-.04 20.14 20.14 0 007 .04 1 1 0 011 .96v7z"/>
              </svg>
              <h3 className="font-bold text-white mb-2">Código não encontrado</h3>
              <p className="text-xs text-slate-500 max-w-xs mx-auto">
                Nenhum pacote encontrado com este código. Tente com{' '}
                <code className="text-brand-400 font-mono bg-brand-500/10 px-1 rounded">TRK00000001BR</code>{' '}
                ou{' '}
                <code className="text-brand-400 font-mono bg-brand-500/10 px-1 rounded">LX987654321CN</code>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
