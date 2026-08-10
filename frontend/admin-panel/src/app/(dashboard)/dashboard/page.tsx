'use client';

/**
 * @file page.tsx
 * @description Painel Geral — visão consolidada da operação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *
 * Fontes de dados (todas via api-gateway):
 *   GET /v1/orders         — lista de pedidos (adminApi.getOrders)
 *   GET /v1/drivers        — frota (adminApi.getDrivers)
 *
 * Os agregados (KPIs, distribuição por status, receita) são derivados no cliente
 * a partir dessas duas listas — não há endpoint de agregação dedicado ainda.
 * Quando `orders-service` expuser /v1/reports/summary, trocar por ele.
 *
 * Graceful degradation: se o gateway estiver fora, exibe banner de erro e
 * mantém a tela vazia em vez de números falsos.
 */

import React, { useState, useEffect, useRef } from 'react';
import { adminApi, Pedido, BackendDriver, type OperationsSummary } from '@/services/api';
import { usePreferences, densityClass } from '@/hooks/usePreferences';
import { StatCard } from '@/components/ui';
import FilaExcecoes from '@/components/FilaExcecoes';
import RiscoOperacional from '@/components/RiscoOperacional';

// ────────────────────────────────────────────────────────────────────────────
// Vocabulário de status — espelha OrderStatus (backend/shared/types)
// ────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, { label: string; badgeClass: string; barClass: string }> = {
  created:              { label: 'Criado',             badgeClass: 'badge-brand',   barClass: 'bg-brand-500'   },
  collected:            { label: 'Coletado',           badgeClass: 'badge-info',    barClass: 'bg-blue-500'    },
  in_transit:           { label: 'Em Trânsito',        badgeClass: 'badge-info',    barClass: 'bg-sky-500'     },
  at_warehouse:         { label: 'No Armazém',         badgeClass: 'badge-warning', barClass: 'bg-amber-500'   },
  awaiting_destination: { label: 'Aguardando Destino', badgeClass: 'badge-warning', barClass: 'bg-orange-500'  },
  out_for_delivery:     { label: 'Saiu para Entrega',  badgeClass: 'badge-warning', barClass: 'bg-yellow-500'  },
  delivered:            { label: 'Entregue',           badgeClass: 'badge-success', barClass: 'bg-emerald-500' },
  failed:               { label: 'Insucesso',          badgeClass: 'badge-error',   barClass: 'bg-red-500'     },
  cancelled:            { label: 'Cancelado',          badgeClass: 'badge-neutral', barClass: 'bg-slate-600'   },
};

const FLEET_LABELS: Record<BackendDriver['current_status'], { label: string; badgeClass: string }> = {
  available: { label: 'Disponível', badgeClass: 'badge-success' },
  on_route:  { label: 'Em Rota',    badgeClass: 'badge-info'    },
  offline:   { label: 'Offline',    badgeClass: 'badge-neutral' },
};

// ────────────────────────────────────────────────────────────────────────────
// Agregações derivadas
// ────────────────────────────────────────────────────────────────────────────

// `computeKpis` foi removida: contava sobre a página carregada e apresentava o
// resultado como o retrato da operação. Os indicadores vêm agora de
// `/v1/operations/summary`, contados em SQL sobre a empresa inteira (§ 3.39).
// As agregações que ficam abaixo servem ilustrações de uma amostra e dizem-no.

function computeStatusDistribution(pedidos: Pedido[]): { status: string; count: number; pct: number }[] {
  const counts = new Map<string, number>();
  for (const p of pedidos) {
    counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  }

  const total = pedidos.length || 1; // evita divisão por zero

  return Object.keys(STATUS_LABELS)
    .map((status) => ({
      status,
      count: counts.get(status) ?? 0,
      pct:   ((counts.get(status) ?? 0) / total) * 100,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

function computeFleet(motoristas: BackendDriver[]) {
  return {
    available: motoristas.filter((d) => d.current_status === 'available').length,
    onRoute:   motoristas.filter((d) => d.current_status === 'on_route').length,
    offline:   motoristas.filter((d) => d.current_status === 'offline').length,
    total:     motoristas.length,
  };
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(cents / 100);
}

// ────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ────────────────────────────────────────────────────────────────────────────

function StatSkeleton() {
  return (
    <div className="stat-card">
      <div className="skeleton h-3 w-24" />
      <div className="skeleton h-8 w-20" />
      <div className="skeleton h-3 w-32" />
    </div>
  );
}

export default function DashboardPage() {
  const [pedidos, setPedidos]       = useState<Pedido[]>([]);
  const [motoristas, setMotoristas] = useState<BackendDriver[]>([]);
  const [resumo, setResumo] = useState<OperationsSummary | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [lastSync, setLastSync]     = useState('');

  const { prefs } = usePreferences();

  const loadData = async () => {
    try {
      setError('');

      // Independentes — não bloquear um pelo outro (mesmo padrão de useSidebarStats)
      const [pedidosResult, motoristasResult, resumoResult] = await Promise.allSettled([
        adminApi.getOrders(),
        adminApi.getDrivers(),
        // Os indicadores vêm contados da base, sobre a empresa inteira (§ 3.39).
        // As listas abaixo continuam a ser uma página — servem para MOSTRAR
        // linhas recentes, não para contar.
        adminApi.getOperationsSummary(),
      ]);

      if (pedidosResult.status === 'fulfilled') {
        setPedidos(pedidosResult.value);
      }
      if (motoristasResult.status === 'fulfilled') {
        setMotoristas(motoristasResult.value);
      }
      if (resumoResult.status === 'fulfilled') {
        setResumo(resumoResult.value);
      }

      if (pedidosResult.status === 'rejected' && motoristasResult.status === 'rejected') {
        setError('Não foi possível contactar o api-gateway. Verifique se o serviço está no ar (porta 4000).');
      } else if (pedidosResult.status === 'rejected') {
        setError('Falha ao carregar pedidos — os indicadores de entrega estão indisponíveis.');
      } else if (motoristasResult.status === 'rejected') {
        setError('Falha ao carregar a frota — o estado dos motoristas está indisponível.');
      }

      setLastSync(new Date().toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } finally {
      setLoading(false);
    }
  };

  // Ref para o intervalo não recriar o fetch a cada render — só o período muda.
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;

  useEffect(() => {
    void loadDataRef.current();

    const interval = setInterval(() => {
      void loadDataRef.current();
    }, prefs.refreshIntervalSec * 1000);

    return () => clearInterval(interval);
  }, [prefs.refreshIntervalSec]);

  const distribution = computeStatusDistribution(pedidos);
  const fleet        = computeFleet(motoristas);

  // Pedidos mais recentes primeiro — updatedAt já vem formatado dd/mm/aaaa hh:mm.
  // É uma AMOSTRA para mostrar linhas, não uma base para contar: os números
  // vivem em `resumo`, contados na base (§ 3.39).
  const recentes = [...pedidos].slice(0, 8);

  return (
    <div className="flex flex-col gap-6">
      {/* ── Cabeçalho ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Painel Geral</h2>
          <p className="text-xs text-slate-500 mt-1">
            Visão consolidada da operação
            {lastSync && ` — atualizado às ${lastSync}`}
          </p>
        </div>
        <button onClick={() => void loadData()} className="btn btn-secondary btn-sm self-start sm:self-auto">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Atualizar
        </button>
      </div>

      {error && (
        <div className="card border-amber-500/20 bg-amber-500/[0.04] flex items-start gap-3 py-4">
          <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-sm text-amber-300">{error}</p>
        </div>
      )}

      {/* ── KPIs ── */}
      <div className="stats-grid">
        {loading ? (
          <>
            <StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton />
          </>
        ) : (
          <>
            <StatCard
              label="Pedidos em Curso"
              value={String(resumo?.orders.open ?? 0)}
              helper={<span className="text-xs text-slate-500">{resumo?.orders.total ?? 0} pedidos no total</span>}
            />
            <StatCard
              label="Entregues"
              value={String(resumo?.orders.delivered ?? 0)}
              helper={
                // `null` quando nada terminou ainda — mostrar 0% daria a
                // impressão de que tudo falhou.
                resumo?.orders.success_rate_pct == null
                  ? <span className="text-xs text-slate-500">Ainda sem entregas concluídas</span>
                  : <span className={resumo.orders.success_rate_pct >= 90 ? 'stat-delta-up' : 'stat-delta-down'}>
                      Taxa de sucesso {resumo.orders.success_rate_pct.toFixed(1)}%
                    </span>
              }
            />
            <StatCard
              label="Insucessos"
              value={String((resumo?.orders.failed ?? 0) + (resumo?.orders.returned ?? 0))}
              helper={<span className="text-xs text-slate-500">
                {resumo?.orders.failed ?? 0} por resolver · {resumo?.orders.returned ?? 0} devolvida(s)
              </span>}
            />
            <StatCard
              label="Receita Reconhecida"
              value={formatCurrency(resumo?.orders.revenue_cents ?? 0)}
              helper={<span className="text-xs text-slate-500">Apenas pedidos entregues</span>}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Distribuição por status ── */}
        <div className="card lg:col-span-2 flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Distribuição por Status</h3>
            {/* Diz explicitamente que é uma amostra: a repartição desenhada é a
                da página carregada, e o total real vem do servidor. Apresentá-la
                como o retrato completo foi o defeito que a § 3.39 corrigiu. */}
            <p className="text-xs text-slate-500 mt-1">
              Repartição dos {pedidos.length} pedidos mais recentes
              {resumo && resumo.orders.total > pedidos.length && ` (de ${resumo.orders.total} no total)`}
            </p>
          </div>

          {loading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-8 w-full" />)}
            </div>
          ) : distribution.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">Nenhum pedido registado ainda.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {distribution.map(({ status, count, pct }) => {
                const meta = STATUS_LABELS[status] ?? { label: status, badgeClass: 'badge-neutral', barClass: 'bg-slate-600' };
                return (
                  <div key={status} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300 font-medium">{meta.label}</span>
                      <span className="text-slate-500 tabular-nums">
                        {count} <span className="text-slate-600">({pct.toFixed(0)}%)</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-elevated overflow-hidden">
                      <div
                        className={`h-full rounded-full ${meta.barClass} transition-all duration-500`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Estado da frota ── */}
        <div className="card flex flex-col gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Frota</h3>
            <p className="text-xs text-slate-500 mt-1">{fleet.total} motoristas registados</p>
          </div>

          {loading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 w-full" />)}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {([
                ['available', fleet.available],
                ['on_route',  fleet.onRoute],
                ['offline',   fleet.offline],
              ] as [BackendDriver['current_status'], number][]).map(([status, count]) => (
                <div
                  key={status}
                  className="flex items-center justify-between rounded-xl bg-surface-elevated px-4 py-3"
                >
                  <span className={`badge ${FLEET_LABELS[status].badgeClass}`}>
                    {FLEET_LABELS[status].label}
                  </span>
                  <span className="text-xl font-bold text-slate-100 tabular-nums">{count}</span>
                </div>
              ))}
            </div>
          )}

          {!loading && fleet.total > 0 && (
            <p className="text-2xs text-slate-500 pt-1 border-t border-white/[0.06]">
              {((fleet.onRoute / fleet.total) * 100).toFixed(0)}% da frota está em rota neste momento.
            </p>
          )}
        </div>
      </div>

      {/* ── À espera de uma decisão (§ 3.39) ──
          Substitui a lista antiga, que só via a primeira página de encomendas e
          só conhecia dois estados. A ordem e o conteúdo vêm do servidor. */}
      {/* O que ainda dá para salvar vem ANTES do que já falhou (§ 3.47): uma
          lista de trabalho por fazer no fim da página é uma lista que não se lê. */}
      <RiscoOperacional />

      <FilaExcecoes refreshMs={prefs.refreshIntervalSec * 1000} />

      {/* ── Movimentação recente ── */}
      <div className="flex flex-col gap-4">
        <h3 className="text-base font-semibold text-slate-100">Movimentação Recente</h3>

        {loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 w-full" />)}
          </div>
        ) : recentes.length === 0 ? (
          <div className="card text-center py-10">
            <p className="text-sm text-slate-500">Nenhum pedido para exibir.</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className={`data-table ${densityClass(prefs.density)}`}>
              <thead>
                <tr>
                  <th>Rastreio</th>
                  <th>Cliente</th>
                  <th>Destino</th>
                  <th>Motorista</th>
                  <th>Status</th>
                  {prefs.showCurrency && <th className="text-right">Valor</th>}
                  <th>Atualizado</th>
                </tr>
              </thead>
              <tbody>
                {recentes.map((p) => {
                  const meta = STATUS_LABELS[p.status] ?? { label: p.status, badgeClass: 'badge-neutral' };
                  const destacar = prefs.alertOnFailure && p.status === 'failed';
                  return (
                    <tr key={p.id} className={destacar ? 'bg-red-500/[0.06]' : ''}>
                      <td className="font-mono text-xs text-slate-200">{p.trackingCode}</td>
                      <td className="text-slate-300">{p.client}</td>
                      <td>{p.destination}</td>
                      <td>{p.driver ?? <span className="text-slate-600">Não atribuído</span>}</td>
                      <td><span className={`badge ${meta.badgeClass}`}>{meta.label}</span></td>
                      {prefs.showCurrency && (
                        <td className="text-right tabular-nums text-slate-300">{formatCurrency(p.value)}</td>
                      )}
                      <td className="text-xs">{p.updatedAt}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
