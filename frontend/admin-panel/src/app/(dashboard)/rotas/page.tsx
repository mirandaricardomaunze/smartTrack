'use client';

/**
 * @file page.tsx
 * @description Rotas — mapa GPS ao vivo + rotas por motorista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2 (Otimização de Rotas)
 *           docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *
 * DUAS FONTES, POR ESTA ORDEM:
 *   1. GET /v1/routes — rotas reais persistidas pelo routes-service (porta 4002),
 *      com sequência otimizada e distância calculada. É a fonte preferida.
 *   2. Fallback local — se o routes-service estiver em baixo (503) ou não houver
 *      rotas criadas, agrupamos os pedidos ativos por `driver_id`. Reflete a
 *      atribuição real mas NÃO a sequência otimizada. A UI sinaliza qual está a
 *      ser usada; nunca apresentamos derivação como se fosse otimização.
 *
 * Fontes de dados:
 *   GET /v1/routes    — rotas otimizadas (adminApi.getRotas)
 *   GET /v1/drivers   — frota + posição GPS (adminApi.getMotoristas)
 *   GET /v1/orders    — pedidos, para enriquecer as paradas (adminApi.getPedidos)
 */

import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { adminApi, Pedido, BackendDriver, Route, RouteStatus } from '@/services/api';
import { usePreferences, densityClass } from '@/hooks/usePreferences';
import { Button, Pagination, StatCard, paginationMeta } from '@/components/ui';

// Leaflet não funciona no Node/SSR — carregamento dinâmico com ssr:false
const MapaGPS = dynamic(() => import('@/components/MapaGPS'), { ssr: false, loading: () => (
  <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-3">
    <svg className="animate-spin w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>
    Carregando mapa...
  </div>
)});

// ────────────────────────────────────────────────────────────────────────────
// Vocabulário
// ────────────────────────────────────────────────────────────────────────────

/** Status de pedido que ainda contam como parada pendente. */
const PENDING_STATUSES = [
  'created', 'collected', 'in_transit',
  'at_warehouse', 'awaiting_destination', 'out_for_delivery',
];

/** Abreviatura do veículo (sem emoji): M=Moto, C=Carro, V=Van, CM=Caminhão. */
const VEHICLE_TAG: Record<string, string> = {
  MOTO:     'M',
  CARRO:    'C',
  VAN:      'V',
  CAMINHAO: 'CM',
};

const FLEET_LABELS: Record<BackendDriver['current_status'], { label: string; badgeClass: string }> = {
  available: { label: 'Disponível', badgeClass: 'badge-success' },
  on_route:  { label: 'Em Rota',    badgeClass: 'badge-info'    },
  offline:   { label: 'Offline',    badgeClass: 'badge-neutral' },
};

const ROUTE_STATUS_LABELS: Record<RouteStatus, { label: string; badgeClass: string }> = {
  PLANEJADA:    { label: 'Planeada',     badgeClass: 'badge-brand'   },
  EM_ANDAMENTO: { label: 'Em Andamento', badgeClass: 'badge-info'    },
  CONCLUIDA:    { label: 'Concluída',    badgeClass: 'badge-success' },
  CANCELADA:    { label: 'Cancelada',    badgeClass: 'badge-neutral' },
};

const ORDER_STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  created:              { label: 'Criado',             badgeClass: 'badge-brand'   },
  collected:            { label: 'Coletado',           badgeClass: 'badge-info'    },
  in_transit:           { label: 'Em Trânsito',        badgeClass: 'badge-info'    },
  at_warehouse:         { label: 'No Armazém',         badgeClass: 'badge-warning' },
  awaiting_destination: { label: 'Aguardando Destino', badgeClass: 'badge-warning' },
  out_for_delivery:     { label: 'Saiu para Entrega',  badgeClass: 'badge-warning' },
  delivered:            { label: 'Entregue',           badgeClass: 'badge-success' },
  failed:               { label: 'Insucesso',          badgeClass: 'badge-error'   },
  cancelled:            { label: 'Cancelado',          badgeClass: 'badge-neutral' },
};

const STOP_STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  pending:   { label: 'Pendente',  badgeClass: 'badge-warning' },
  delivered: { label: 'Entregue',  badgeClass: 'badge-success' },
  failed:    { label: 'Insucesso', badgeClass: 'badge-error'   },
};

// ────────────────────────────────────────────────────────────────────────────
// View models — comuns às duas fontes
// ────────────────────────────────────────────────────────────────────────────

interface StopView {
  key:          string;
  trackingCode: string;
  client:       string;
  destination:  string;
  statusLabel:  string;
  badgeClass:   string;
  isFailure:    boolean;
  valueCents:   number;
}

interface RouteView {
  key:          string;
  /** null quando a rota é derivada localmente */
  routeId:      string | null;
  driverName:   string;
  vehicle:      string;
  plate:        string;
  driverStatus: BackendDriver['current_status'];
  routeStatus:  RouteStatus | null;
  distanceKm:   number | null;
  stops:        StopView[];
  delivered:    number;
  failed:       number;
  pending:      number;
  valueCents:   number;
}

/** Motorista desconhecido — a rota existe mas o motorista já não está na frota. */
const UNKNOWN_DRIVER = {
  name:    'Motorista desconhecido',
  vehicle: { type: 'CARRO', plate: '—' },
  status:  'offline' as const,
};

/** Constrói as views a partir das rotas reais do routes-service. */
function buildFromRoutes(
  rotas: Route[],
  motoristas: BackendDriver[],
  pedidos: Pedido[],
): RouteView[] {
  const porId     = new Map(motoristas.map((d) => [d.id, d]));
  const pedidoPor = new Map(pedidos.map((p) => [p.id, p]));

  return rotas.map((rota) => {
    const driver = porId.get(rota.driverId);

    const stops: StopView[] = [...rota.stops]
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => {
        const pedido = pedidoPor.get(s.orderId);
        const meta   = STOP_STATUS_LABELS[s.status] ?? { label: s.status, badgeClass: 'badge-neutral' };

        return {
          key:          s.orderId,
          trackingCode: pedido?.trackingCode ?? s.orderId,
          client:       pedido?.client ?? '—',
          destination:  pedido?.destination ?? s.address,
          statusLabel:  meta.label,
          badgeClass:   meta.badgeClass,
          isFailure:    s.status === 'failed',
          valueCents:   pedido?.value ?? 0,
        };
      });

    return {
      key:          rota.id,
      routeId:      rota.id,
      driverName:   driver?.name ?? UNKNOWN_DRIVER.name,
      vehicle:      driver?.vehicle.type ?? UNKNOWN_DRIVER.vehicle.type,
      plate:        driver?.vehicle.plate ?? UNKNOWN_DRIVER.vehicle.plate,
      driverStatus: driver?.current_status ?? UNKNOWN_DRIVER.status,
      routeStatus:  rota.status,
      distanceKm:   rota.distanceKm,
      stops,
      delivered:    rota.delivered,
      failed:       rota.failed,
      pending:      rota.pending,
      valueCents:   stops.reduce((sum, s) => sum + s.valueCents, 0),
    };
  });
}

/**
 * Fallback: agrupa pedidos por motorista atribuído.
 * `Pedido.driver` vem de BackendOrder.driver_id — é sempre um id, nunca um nome.
 */
function buildFromOrders(pedidos: Pedido[], motoristas: BackendDriver[]): RouteView[] {
  const porMotorista = new Map<string, Pedido[]>();

  for (const p of pedidos) {
    if (!p.driver) continue;
    const lista = porMotorista.get(p.driver) ?? [];
    lista.push(p);
    porMotorista.set(p.driver, lista);
  }

  const views: RouteView[] = [];

  for (const driver of motoristas) {
    const pedidosDoMotorista = porMotorista.get(driver.id) ?? [];
    if (pedidosDoMotorista.length === 0) continue;

    const stops: StopView[] = pedidosDoMotorista.map((p) => {
      const meta = ORDER_STATUS_LABELS[p.status] ?? { label: p.status, badgeClass: 'badge-neutral' };
      return {
        key:          p.id,
        trackingCode: p.trackingCode,
        client:       p.client,
        destination:  p.destination,
        statusLabel:  meta.label,
        badgeClass:   meta.badgeClass,
        isFailure:    p.status === 'failed',
        valueCents:   p.value,
      };
    });

    views.push({
      key:          driver.id,
      routeId:      null,
      driverName:   driver.name,
      vehicle:      driver.vehicle.type,
      plate:        driver.vehicle.plate,
      driverStatus: driver.current_status,
      routeStatus:  null,
      distanceKm:   null,
      stops,
      delivered:    pedidosDoMotorista.filter((p) => p.status === 'delivered').length,
      failed:       pedidosDoMotorista.filter((p) => p.status === 'failed').length,
      pending:      pedidosDoMotorista.filter((p) => PENDING_STATUSES.includes(p.status)).length,
      valueCents:   pedidosDoMotorista.reduce((sum, p) => sum + (p.value || 0), 0),
    });
  }

  return views;
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(cents / 100);
}

// ────────────────────────────────────────────────────────────────────────────

type Fonte = 'service' | 'derived';

export default function RotasPage() {
  const [pedidos, setPedidos]       = useState<Pedido[]>([]);
  const [motoristas, setMotoristas] = useState<BackendDriver[]>([]);
  const [rotas, setRotas]           = useState<Route[]>([]);
  const [fonte, setFonte]           = useState<Fonte>('derived');
  const [avisoServico, setAviso]    = useState('');
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [expandida, setExpandida]   = useState<string | null>(null);
  const [page, setPage]             = useState(1);
  const [pageSize, setPageSize]     = useState(10);

  const { prefs } = usePreferences();

  const loadData = async () => {
    try {
      setError('');

      const [pedidosResult, motoristasResult, rotasResult] = await Promise.allSettled([
        adminApi.getPedidos(),
        adminApi.getMotoristas(),
        adminApi.getRotas(),
      ]);

      const listaPedidos    = pedidosResult.status === 'fulfilled'    ? pedidosResult.value    : [];
      const listaMotoristas = motoristasResult.status === 'fulfilled' ? motoristasResult.value : [];

      setPedidos(listaPedidos);
      setMotoristas(listaMotoristas);

      if (rotasResult.status === 'fulfilled' && rotasResult.value.length > 0) {
        setRotas(rotasResult.value);
        setFonte('service');
        setAviso('');
      } else {
        setRotas([]);
        setFonte('derived');
        setAviso(
          rotasResult.status === 'rejected'
            ? 'O routes-service não respondeu — a mostrar rotas derivadas da atribuição de pedidos.'
            : 'Ainda não há rotas criadas no routes-service — a mostrar rotas derivadas da atribuição de pedidos.',
        );
      }

      if (pedidosResult.status === 'rejected' || motoristasResult.status === 'rejected') {
        setError('Não foi possível carregar pedidos ou frota. O mapa continua a funcionar de forma independente.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const views = fonte === 'service'
    ? buildFromRoutes(rotas, motoristas, pedidos)
    : buildFromOrders(pedidos, motoristas);

  // Rotas com mais paradas pendentes primeiro — é onde a operação precisa olhar.
  const ordenadas = [...views].sort((a, b) => b.pending - a.pending);
  const pageMeta = paginationMeta(ordenadas.length, page, pageSize);
  const rotasVisiveis = ordenadas.slice((pageMeta.currentPage - 1) * pageSize, pageMeta.currentPage * pageSize);

  const naoAtribuidos = pedidos.filter(
    (p) => !p.driver && PENDING_STATUSES.includes(p.status),
  );

  const totalParadas   = views.reduce((sum, r) => sum + r.stops.length, 0);
  const totalPendentes = views.reduce((sum, r) => sum + r.pending, 0);
  const distanciaTotal = views.reduce((sum, r) => sum + (r.distanceKm ?? 0), 0);

  return (
    <div className="flex flex-col gap-6">
      {/* ── Cabeçalho ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-slate-100">Rotas</h2>
            <span className={`badge ${fonte === 'service' ? 'badge-success' : 'badge-warning'}`}>
              {fonte === 'service' ? 'routes-service' : 'derivadas'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Posição da frota ao vivo e paradas por motorista
          </p>
        </div>
        <Button onClick={() => void loadData()} size="sm" className="self-start sm:self-auto" leftIcon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>}>Atualizar</Button>
      </div>

      {error && (
        <div className="card border-amber-500/20 bg-amber-500/[0.04] flex items-start gap-3 py-4">
          <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-sm text-amber-300">{error}</p>
        </div>
      )}

      {/* ── Resumo ── */}
      <div className="stats-grid">
        <StatCard label={fonte === 'service' ? 'Rotas' : 'Rotas Derivadas'} value={views.length} helper={<span className="text-xs text-slate-500">{fonte === 'service' ? 'Persistidas pelo routes-service' : 'Motoristas com pedidos atribuídos'}</span>} />
        <StatCard label="Paradas Totais" value={totalParadas} helper={<span className="text-xs text-slate-500">Em todas as rotas</span>} />
        <StatCard label="Paradas Pendentes" value={totalPendentes} helper={<span className={totalPendentes > 0 ? 'stat-delta-down' : 'stat-delta-up'}>{totalPendentes > 0 ? 'Ainda por concluir' : 'Tudo concluído'}</span>} />
        {fonte === 'service' ? (
          <StatCard label="Distância Planeada" value={`${distanciaTotal.toFixed(1)} km`} helper={<span className="text-xs text-slate-500">Soma das rotas otimizadas</span>} />
        ) : (
          <StatCard label="Sem Atribuição" value={naoAtribuidos.length} helper={<span className={naoAtribuidos.length > 0 ? 'stat-delta-down' : 'stat-delta-up'}>{naoAtribuidos.length > 0 ? 'Requer alocação manual' : 'Nenhum pedido órfão'}</span>} />
        )}
      </div>

      {/* ── Mapa ao vivo ── */}
      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <h3 className="text-base font-semibold text-slate-100">Mapa ao Vivo</h3>
          <span className="text-2xs text-slate-500 ml-auto">Posições GPS atualizadas a cada 10s</span>
        </div>
        <div className="h-[520px] p-4 sm:p-6">
          <MapaGPS />
        </div>
      </div>

      {/* ── Aviso de fonte de dados ── */}
      {avisoServico && (
        <div className="card border-amber-500/20 bg-amber-500/[0.03] flex items-start gap-3 py-4">
          <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-slate-400 leading-relaxed">
            {avisoServico} A ordem das paradas abaixo reflete a atribuição, <strong className="text-slate-300">não
            uma sequência otimizada</strong> — para isso é preciso criar a rota via
            <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-overlay text-brand-400 text-2xs">POST /v1/routes</code>.
          </p>
        </div>
      )}

      {/* ── Rotas ── */}
      <div className="flex flex-col gap-4">
        <h3 className="text-base font-semibold text-slate-100">
          {fonte === 'service' ? 'Rotas Otimizadas' : 'Rotas em Curso'}
        </h3>

        {loading ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-24 w-full" />)}
          </div>
        ) : ordenadas.length === 0 ? (
          <div className="card text-center py-10">
            <p className="text-sm text-slate-500">
              Nenhuma rota — não há pedidos atribuídos a motoristas.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rotasVisiveis.map((rota) => {
              const aberta    = expandida === rota.key;
              const concluido = rota.stops.length - rota.pending;
              const progresso = rota.stops.length > 0 ? (concluido / rota.stops.length) * 100 : 0;

              return (
                <div key={rota.key} className="card p-0 overflow-hidden">
                  {/* Cabeçalho da rota — clicável */}
                  <button
                    onClick={() => setExpandida(aberta ? null : rota.key)}
                    className="w-full flex flex-col md:flex-row md:items-center gap-4 px-6 py-4 text-left hover:bg-surface-elevated transition-colors"
                    aria-expanded={aberta}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-11 h-11 rounded-xl bg-surface-overlay flex items-center justify-center text-sm font-bold text-slate-200 shrink-0">
                        {VEHICLE_TAG[rota.vehicle] ?? 'C'}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-100 truncate">{rota.driverName}</p>
                        <p className="text-2xs text-slate-500 font-mono">
                          {rota.plate}
                          {rota.distanceKm !== null && ` · ${rota.distanceKm.toFixed(1)} km`}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6 shrink-0">
                      <div className="text-center">
                        <p className="text-lg font-bold text-slate-100 tabular-nums">{rota.stops.length}</p>
                        <p className="text-2xs text-slate-500 uppercase tracking-wide">Paradas</p>
                      </div>
                      <div className="text-center">
                        <p className="text-lg font-bold text-emerald-400 tabular-nums">{rota.delivered}</p>
                        <p className="text-2xs text-slate-500 uppercase tracking-wide">Entregues</p>
                      </div>
                      <div className="text-center">
                        <p className={`text-lg font-bold tabular-nums ${rota.failed > 0 ? 'text-red-400' : 'text-slate-600'}`}>
                          {rota.failed}
                        </p>
                        <p className="text-2xs text-slate-500 uppercase tracking-wide">Insucesso</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      {rota.routeStatus ? (
                        <span className={`badge ${ROUTE_STATUS_LABELS[rota.routeStatus].badgeClass}`}>
                          {ROUTE_STATUS_LABELS[rota.routeStatus].label}
                        </span>
                      ) : (
                        <span className={`badge ${FLEET_LABELS[rota.driverStatus].badgeClass}`}>
                          {FLEET_LABELS[rota.driverStatus].label}
                        </span>
                      )}
                      <svg
                        className={`w-4 h-4 text-slate-500 transition-transform ${aberta ? 'rotate-180' : ''}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {/* Barra de progresso */}
                  <div className="h-1 bg-surface-elevated">
                    <div
                      className="h-full bg-brand-500 transition-all duration-500"
                      style={{ width: `${progresso}%` }}
                    />
                  </div>

                  {/* Paradas — expandido */}
                  {aberta && (
                    <div className="border-t border-white/[0.06]">
                      <div className="table-wrapper rounded-none border-0">
                        <table className={`data-table ${densityClass(prefs.density)}`}>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Rastreio</th>
                              <th>Cliente</th>
                              <th>Destino</th>
                              <th>Status</th>
                              {prefs.showCurrency && <th className="text-right">Valor</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {rota.stops.map((stop, i) => {
                              const destacar = prefs.alertOnFailure && stop.isFailure;
                              return (
                                <tr key={stop.key} className={destacar ? 'bg-red-500/[0.06]' : ''}>
                                  <td className="text-slate-600 tabular-nums">{i + 1}</td>
                                  <td className="font-mono text-xs text-slate-200">{stop.trackingCode}</td>
                                  <td className="text-slate-300">{stop.client}</td>
                                  <td>{stop.destination}</td>
                                  <td><span className={`badge ${stop.badgeClass}`}>{stop.statusLabel}</span></td>
                                  {prefs.showCurrency && (
                                    <td className="text-right tabular-nums text-slate-300">
                                      {formatCurrency(stop.valueCents)}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="px-6 py-3 flex justify-between text-xs text-slate-500 border-t border-white/[0.06]">
                        <span>
                          {rota.pending} parada(s) pendente(s)
                          {rota.routeId && <span className="font-mono ml-2 text-slate-600">{rota.routeId}</span>}
                        </span>
                        {prefs.showCurrency && (
                          <span className="tabular-nums">Valor total da rota: {formatCurrency(rota.valueCents)}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!loading && ordenadas.length > 0 && <Pagination page={pageMeta.currentPage} pageSize={pageSize} totalItems={ordenadas.length} itemLabel="rotas" onPageChange={(next) => { setExpandida(null); setPage(next); }} onPageSizeChange={(next) => { setPageSize(next); setPage(1); setExpandida(null); }} />}
      </div>

      {/* ── Pedidos sem motorista ── */}
      {!loading && naoAtribuidos.length > 0 && (
        <div className="card border-amber-500/20 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-100">Pedidos Sem Atribuição</h3>
            <span className="badge badge-warning">{naoAtribuidos.length}</span>
          </div>
          <p className="text-xs text-slate-500 -mt-2">
            Pedidos ativos que ainda não têm motorista designado.
          </p>

          <div className="table-wrapper">
            <table className={`data-table ${densityClass(prefs.density)}`}>
              <thead>
                <tr>
                  <th>Rastreio</th>
                  <th>Cliente</th>
                  <th>Destino</th>
                  <th>Status</th>
                  <th>Atualizado</th>
                </tr>
              </thead>
              <tbody>
                {naoAtribuidos.map((p) => {
                  const meta = ORDER_STATUS_LABELS[p.status] ?? { label: p.status, badgeClass: 'badge-neutral' };
                  return (
                    <tr key={p.id}>
                      <td className="font-mono text-xs text-slate-200">{p.trackingCode}</td>
                      <td className="text-slate-300">{p.client}</td>
                      <td>{p.destination}</td>
                      <td><span className={`badge ${meta.badgeClass}`}>{meta.label}</span></td>
                      <td className="text-xs">{p.updatedAt}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
