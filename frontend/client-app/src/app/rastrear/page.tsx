'use client';

import { useState } from 'react';
import { fetchTrackingStatus, requestShipment } from '@/services/api';
import { Button, Input } from '@/components/ui';

interface Evento {
  status: string;
  descricao: string;
  localizacao: string;
  timestamp: string;
}

interface Pod {
  recebidoPor: string;
  assinatura?: string;
  foto?: string;
  registadoEm: string;
}

interface Pedido {
  codigoRastreio: string;
  statusAtual: string;
  statusCode: string;
  origem: string;
  destino: string;
  historico: Evento[];
  pod?: Pod;
}

/** Estados em que o cliente pode solicitar o envio para um destino (spec § 8.2). */
const WAREHOUSE_CODES = ['at_warehouse', 'awaiting_destination'];

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
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
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
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
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
  'Entregue': {
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/20 border-emerald-500/40',
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
};

const DEFAULT_CONFIG = {
  color: 'text-slate-400',
  bg: 'bg-slate-800/60 border-slate-700/40',
  icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

function getStatusConfig(status: string) {
  const normalized = Object.keys(STATUS_CONFIG).find(
    (k) => k.toLowerCase() === status.toLowerCase()
  );
  return normalized ? STATUS_CONFIG[normalized] : DEFAULT_CONFIG;
}

const PROGRESS_STEPS = [
  { key: 'criado',           label: 'Registrado'  },
  { key: 'coletado',         label: 'Coletado'    },
  { key: 'em_transito',      label: 'Em Trânsito' },
  { key: 'no_armazem',       label: 'No Armazém'  },
  { key: 'saiu_para_entrega',label: 'Saiu p/ Entrega' },
  { key: 'entregue',         label: 'Entregue'    },
];

function getProgressIndex(historico: Evento[]): number {
  if (!historico || historico.length === 0) return 0;
  const currentStatus = (historico[0].status || '').toLowerCase();
  
  const map: Record<string, number> = {
    'criado': 0,
    'coletado': 1,
    'em_transito': 2,
    'no_armazem': 3,
    'saiu_para_entrega': 4,
    'entregue': 5,
  };
  return map[currentStatus] ?? 1;
}

function formatTs(isoString: string) {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return { date: isoString, time: '' };
    const date = d.toLocaleDateString('pt-MZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit' });
    return { date, time };
  } catch {
    return { date: isoString, time: '' };
  }
}

const FALLBACK_DB: Record<string, Pedido> = {
  'TRK00000001BR': {
    codigoRastreio: 'TRK00000001BR',
    statusAtual:    'Em Trânsito',
    statusCode:     'in_transit',
    origem:         'Centro de Triagem Nacional',
    destino:        'Maputo - Moçambique',
    historico: [
      { status: 'Em Trânsito', descricao: 'Encomenda em transferência para a distribuição local', localizacao: 'São Paulo - SP', timestamp: new Date(Date.now() - 3600000).toISOString() },
      { status: 'Coletado',    descricao: 'Encomenda coletada na origem',                        localizacao: 'São Paulo - SP', timestamp: new Date(Date.now() - 86400000).toISOString() },
      { status: 'Criado',      descricao: 'Pedido registrado no sistema',                        localizacao: 'São Paulo - SP', timestamp: new Date(Date.now() - 172800000).toISOString() },
    ],
  },
  'LX987654321CN': {
    codigoRastreio: 'LX987654321CN',
    statusAtual:    'No Armazém',
    statusCode:     'at_warehouse',
    origem:         'Shenzhen - China',
    destino:        'Maputo - Moçambique',
    historico: [
      { status: 'No Armazém', descricao: 'Encomenda recebida no hub internacional de triagem', localizacao: 'Curitiba - PR', timestamp: new Date(Date.now() - 7200000).toISOString() },
      { status: 'Em Trânsito', descricao: 'Liberado pela alfândega',                          localizacao: 'Guarulhos - SP', timestamp: new Date(Date.now() - 172800000).toISOString() },
      { status: 'Criado',      descricao: 'Pedido despachado do remetente',                   localizacao: 'Shenzhen - China', timestamp: new Date(Date.now() - 604800000).toISOString() },
    ],
  },
};

export default function RastrearPage() {
  const [code, setCode] = useState('');
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  // Solicitar envio (spec § 8.2 — cliente confirma o destino no armazém)
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
    if (!reqDestino.trim()) { setReqError('Informe o destino de entrega.'); return; }

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
    if (!code.trim()) return;

    setSearched(true);
    setLoading(true);
    setIsOffline(false);

    const cleanCode = code.toUpperCase().trim();
    try {
      const data = await fetchTrackingStatus(cleanCode);
      setPedido(data);
      resetRequestForm(data);
    } catch {
      setIsOffline(true);
      const found = FALLBACK_DB[cleanCode];
      setPedido(found ?? null);
      resetRequestForm(found ?? null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 py-6 max-w-2xl mx-auto w-full">
      <div className="text-center flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Rastrear Encomenda</h1>
        <p className="text-slate-400 text-sm">Insira o código do pedido para acompanhar a entrega em tempo real.</p>
      </div>

      <form onSubmit={handleSearch} className="w-full flex gap-3">
        <Input
          type="text"
          placeholder="Ex: TRK00000001BR ou LX987654321CN"
          className="font-mono uppercase"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        <Button type="submit" variant="primary" className="shrink-0 px-6" loading={loading}>Buscar</Button>
      </form>

      {isOffline && searched && (
        <div className="w-full bg-amber-500/10 border border-amber-500/20 text-amber-400 p-3.5 rounded-xl text-xs flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          Servidor de teste offline — exibindo dados locais de demonstração.
        </div>
      )}

      {searched && !loading && (
        <div className="w-full animate-fade-in">
          {pedido ? (
            <div className="flex flex-col gap-5">
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

                <div className="mt-2">
                  <div className="flex items-center">
                    {PROGRESS_STEPS.map((step, idx) => {
                      const done = idx <= progressIndex;
                      const current = idx === progressIndex;
                      const isLast = idx === PROGRESS_STEPS.length - 1;

                      return (
                        <div key={step.key} className="flex items-center flex-1 last:flex-none">
                          <div className="flex flex-col items-center gap-1.5">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${
                              current ? 'border-brand-400 bg-brand-500/20 ring-4 ring-brand-500/20' :
                              done ? 'border-brand-500 bg-brand-500' :
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

              {pedido.statusCode === 'delivered' && pedido.pod && (
                <div className="card p-5 flex flex-col gap-3 border-emerald-500/20 bg-emerald-500/[0.04]">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h3 className="text-sm font-bold text-emerald-300">Comprovativo de entrega</h3>
                  </div>
                  <p className="text-xs text-slate-300">
                    Recebido por <strong className="text-slate-100">{pedido.pod.recebidoPor}</strong>
                    {pedido.pod.registadoEm && <> em {formatTs(pedido.pod.registadoEm).date} {formatTs(pedido.pod.registadoEm).time}</>}.
                  </p>
                  {(pedido.pod.assinatura || pedido.pod.foto) && (
                    <div className="flex gap-4">
                      {pedido.pod.assinatura && (
                        <div>
                          <span className="block text-[10px] text-slate-500 mb-1">Assinatura</span>
                          <img src={pedido.pod.assinatura} alt="Assinatura do destinatário" className="h-16 rounded-lg bg-surface border border-white/10" />
                        </div>
                      )}
                      {pedido.pod.foto && (
                        <div>
                          <span className="block text-[10px] text-slate-500 mb-1">Foto</span>
                          <img src={pedido.pod.foto} alt="Foto da entrega" className="h-16 w-16 rounded-lg object-cover border border-white/10" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="card p-5 flex flex-col gap-1">
                <h3 className="text-sm font-bold text-slate-200 mb-4">Histórico de Movimentações</h3>
                <div className="flex flex-col gap-3">
                  {pedido.historico.map((evt, idx) => {
                    const cfg = getStatusConfig(evt.status);
                    const isMostRecent = idx === 0;
                    const { date, time } = formatTs(evt.timestamp);

                    return (
                      <div
                        key={idx}
                        className={`relative flex gap-4 items-start p-4 rounded-2xl border ${
                          isMostRecent ? `${cfg.bg}` : 'bg-transparent border-transparent'
                        }`}
                      >
                        <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center border ${
                          isMostRecent ? `border-current ${cfg.color}` : 'border-slate-700 text-slate-500'
                        }`}>
                          {cfg.icon}
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <div className="flex items-start justify-between gap-2">
                            <h4 className={`text-sm font-bold ${isMostRecent ? cfg.color : 'text-slate-300'}`}>
                              {evt.status}
                            </h4>
                            <span className="text-[10px] font-mono text-slate-400">{date} {time}</span>
                          </div>
                          <p className="text-xs text-slate-400 mt-1">{evt.descricao}</p>
                          <div className="flex items-center gap-1 text-[11px] text-slate-500 mt-1 font-medium">
                            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            {evt.localizacao}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="card text-center py-12 border-red-500/10">
              <h3 className="font-bold text-white mb-2">Código não localizado</h3>
              <p className="text-xs text-slate-500 max-w-xs mx-auto">
                Experimente buscar por <code className="text-brand-400 font-mono">TRK00000001BR</code> ou <code className="text-brand-400 font-mono">LX987654321CN</code>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
