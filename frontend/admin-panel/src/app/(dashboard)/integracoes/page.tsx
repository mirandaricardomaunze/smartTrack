'use client';

/**
 * @file page.tsx
 * @description Integrações — estado dos serviços internos e conectores externos.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *           backend/README.md (mapa de portas e microsserviços)
 *
 * O que é REAL nesta tela:
 *   - Sonda HTTP ao /health do api-gateway (mede latência de facto).
 *   - Sonda aos endpoints /v1/orders/stats e /v1/drivers/stats (autenticados).
 *   - Sonda a /v1/routes — hoje devolve 404, o que confirma que o routes-service
 *     ainda não está ligado ao gateway.
 *
 * O que é DECLARATIVO (não sondado):
 *   - Serviços cujas pastas em backend/ estão vazias (payments, notifications) e
 *     conectores externos (17TRACK, Cainiao, FCM) — marcados como
 *     "Não implementado". Não exibimos estado verde para o que não existe.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { fetchApi } from '@/services/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// ────────────────────────────────────────────────────────────────────────────
// Modelo de estado
// ────────────────────────────────────────────────────────────────────────────

type ProbeState = 'checking' | 'online' | 'unauthorized' | 'offline' | 'not_implemented';

const STATE_META: Record<ProbeState, { label: string; badgeClass: string; dotClass: string }> = {
  checking:        { label: 'A verificar',      badgeClass: 'badge-neutral', dotClass: 'bg-slate-500 animate-pulse' },
  online:          { label: 'Operacional',      badgeClass: 'badge-success', dotClass: 'bg-emerald-400'             },
  unauthorized:    { label: 'Sem permissão',    badgeClass: 'badge-warning', dotClass: 'bg-amber-400'               },
  offline:         { label: 'Indisponível',     badgeClass: 'badge-error',   dotClass: 'bg-red-400'                 },
  not_implemented: { label: 'Não implementado', badgeClass: 'badge-neutral', dotClass: 'bg-slate-600'               },
};

interface ServiceCard {
  key:          string;
  name:         string;
  description:  string;
  port?:        number;
  /** Caminho sondado — também exibido na UI para efeitos de diagnóstico */
  probePath?:   string;
  /** Serviços sem código ainda — não são sondados */
  declarative?: boolean;
}

/** Serviços internos — ver backend/README.md § Portas */
const INTERNAL_SERVICES: ServiceCard[] = [
  {
    key: 'api-gateway',
    name: 'API Gateway',
    description: 'Ponto único de entrada — auth, RBAC e roteamento.',
    port: 4000,
    probePath: '/health',
  },
  {
    key: 'orders',
    name: 'Orders',
    description: 'Pedidos, timeline de eventos e sync offline do motorista.',
    port: 4001,
    probePath: '/v1/orders/stats',
  },
  {
    key: 'drivers',
    name: 'Drivers / Frota',
    description: 'Cadastro de motoristas e posições GPS ao vivo.',
    port: 4000,
    probePath: '/v1/drivers/stats',
  },
  {
    key: 'routes',
    name: 'Routes',
    description: 'Otimização e reotimização dinâmica de rotas.',
    port: 4002,
    probePath: '/v1/routes',
  },
  {
    key: 'payments',
    name: 'Payments',
    description: 'Cobranças idempotentes, webhooks e conciliação financeira.',
    port: 4003,
    probePath: '/v1/payments/stats',
  },
  {
    key: 'notifications',
    name: 'Notifications',
    description: 'Push via FCM e preferências de notificação por utilizador.',
    port: 4004,
    probePath: '/v1/notifications/stats',
  },
  {
    key: 'tracking-intl',
    name: 'Tracking Internacional',
    description: 'Polling 17TRACK/Cainiao e normalização de status.',
    port: 4005,
    probePath: '/v1/tracking/stats',
  },
];

/** Conectores de terceiros — declarativos, dependem de credenciais no backend */
const EXTERNAL_CONNECTORS = [
  {
    key: '17track',
    name: '17TRACK',
    icon: '🌐',
    description: 'Rastreio internacional multi-transportadora.',
    detail: 'Requer API key e o tracking-intl-service em execução.',
  },
  {
    key: 'cainiao',
    name: 'Cainiao',
    icon: '📦',
    description: 'Rede logística Alibaba — encomendas com origem na China.',
    detail: 'Mapeamento de status via StatusMapper (este já está implementado).',
  },
  {
    key: 'fcm',
    name: 'Firebase Cloud Messaging',
    icon: '🔔',
    description: 'Push notifications para os apps cliente e motorista.',
    detail: 'O notifications-service já existe, mas usa um FCM simulado — sem credenciais Firebase, nenhum push chega a um telemóvel.',
  },
  {
    key: 'kafka',
    name: 'Kafka',
    icon: '🔀',
    description: 'Barramento de eventos entre microsserviços.',
    detail: 'Declarado em infra/docker/docker-compose.yml — sem produtor/consumidor ativo.',
  },
];

interface ProbeResult {
  state:     ProbeState;
  latencyMs: number | null;
  detail:    string;
}

// ────────────────────────────────────────────────────────────────────────────
// Sondas
// ────────────────────────────────────────────────────────────────────────────

/**
 * Sonda o /health do gateway. É a única rota fora do prefixo /v1,
 * por isso não usa fetchApi (que prefixa a versão).
 */
async function probeGatewayHealth(): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${API_URL}/health`, { cache: 'no-store' });
    const latencyMs = Math.round(performance.now() - started);

    if (!res.ok) {
      return { state: 'offline', latencyMs, detail: `Health check devolveu HTTP ${res.status}` };
    }
    return { state: 'online', latencyMs, detail: 'Health check respondeu 200' };
  } catch {
    return {
      state: 'offline',
      latencyMs: null,
      detail: 'Sem resposta — o processo pode estar parado',
    };
  }
}

/**
 * Sonda um endpoint autenticado sob /v1.
 * Distingue "existe mas sem permissão" (401/403) de "não existe" (404).
 */
async function probeAuthenticated(endpoint: string): Promise<ProbeResult> {
  const started = performance.now();
  try {
    await fetchApi<unknown>(endpoint);
    return {
      state: 'online',
      latencyMs: Math.round(performance.now() - started),
      detail: 'Endpoint respondeu com sucesso',
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const message = err instanceof Error ? err.message : '';

    if (message.includes('404')) {
      return { state: 'not_implemented', latencyMs: null, detail: 'Rota não registada no gateway (404)' };
    }
    if (message.includes('401') || message.includes('403')) {
      return { state: 'unauthorized', latencyMs, detail: 'Serviço no ar, mas o token não tem permissão' };
    }
    if (message.includes('500')) {
      return { state: 'offline', latencyMs, detail: 'Erro interno do servidor (500)' };
    }
    return { state: 'offline', latencyMs: null, detail: 'Falha de rede ao contactar o gateway' };
  }
}

// ────────────────────────────────────────────────────────────────────────────

export default function IntegracoesPage() {
  const [results, setResults]     = useState<Record<string, ProbeResult>>({});
  const [checking, setChecking]   = useState(true);
  const [lastCheck, setLastCheck] = useState('');

  const runProbes = useCallback(async () => {
    setChecking(true);

    const [gateway, orders, drivers, routes, payments, notifications, trackingIntl] = await Promise.all([
      probeGatewayHealth(),
      probeAuthenticated('/orders/stats'),
      probeAuthenticated('/drivers/stats'),
      probeAuthenticated('/routes'),
      probeAuthenticated('/payments/stats'),
      probeAuthenticated('/notifications/stats'),
      probeAuthenticated('/tracking/stats'),
    ]);

    setResults({
      'api-gateway': gateway, orders, drivers, routes, payments, notifications,
      'tracking-intl': trackingIntl,
    });

    setLastCheck(new Date().toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    setChecking(false);
  }, []);

  useEffect(() => {
    void runProbes();
  }, [runProbes]);

  const getState = (svc: ServiceCard): ProbeResult => {
    if (svc.declarative) {
      return { state: 'not_implemented', latencyMs: null, detail: 'Pasta do serviço ainda vazia em backend/' };
    }
    return results[svc.key] ?? { state: 'checking', latencyMs: null, detail: 'A sondar…' };
  };

  const operacionais = INTERNAL_SERVICES.filter((s) => getState(s).state === 'online').length;
  const emFalta      = INTERNAL_SERVICES.filter((s) => getState(s).state === 'not_implemented').length;
  const comFalha     = INTERNAL_SERVICES.filter((s) => getState(s).state === 'offline').length;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Cabeçalho ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Integrações</h2>
          <p className="text-xs text-slate-500 mt-1">
            Estado dos microsserviços e conectores externos
            {lastCheck && ` — última verificação às ${lastCheck}`}
          </p>
        </div>
        <button
          onClick={() => void runProbes()}
          disabled={checking}
          className="btn btn-secondary btn-sm self-start sm:self-auto"
        >
          {checking ? (
            <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
          {checking ? 'A verificar…' : 'Verificar agora'}
        </button>
      </div>

      {/* ── Resumo ── */}
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Operacionais</span>
          <span className="stat-value">{operacionais}</span>
          <span className="text-xs text-slate-500">de {INTERNAL_SERVICES.length} serviços</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Não Implementados</span>
          <span className="stat-value">{emFalta}</span>
          <span className="text-xs text-slate-500">Previstos no roadmap</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Com Falha</span>
          <span className="stat-value">{comFalha}</span>
          <span className={comFalha > 0 ? 'stat-delta-down' : 'stat-delta-up'}>
            {comFalha > 0 ? 'Verificar processos' : 'Nenhuma falha'}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Latência do Gateway</span>
          <span className="stat-value">
            {results['api-gateway']?.latencyMs != null ? `${results['api-gateway'].latencyMs}ms` : '—'}
          </span>
          <span className="text-xs text-slate-500 font-mono truncate">{API_URL}</span>
        </div>
      </div>

      {/* ── Serviços internos ── */}
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Serviços Internos</h3>
          <p className="text-xs text-slate-500 mt-1">
            Sondados em tempo real através do api-gateway. Serviços marcados como
            &quot;não implementado&quot; ainda não têm código em <code className="text-brand-400">backend/</code>.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {INTERNAL_SERVICES.map((svc) => {
            const probe = getState(svc);
            const meta  = STATE_META[probe.state];

            return (
              <div key={svc.key} className="card flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dotClass}`} />
                    <h4 className="text-sm font-semibold text-slate-100 truncate">{svc.name}</h4>
                  </div>
                  <span className={`badge ${meta.badgeClass} shrink-0`}>{meta.label}</span>
                </div>

                <p className="text-xs text-slate-500 leading-relaxed">{svc.description}</p>

                <div className="mt-auto pt-3 border-t border-white/[0.06] flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-2xs">
                    <span className="text-slate-600 uppercase tracking-wide">Porta</span>
                    <span className="font-mono text-slate-400">{svc.port ?? '—'}</span>
                  </div>
                  {svc.probePath && (
                    <div className="flex items-center justify-between text-2xs gap-2">
                      <span className="text-slate-600 uppercase tracking-wide shrink-0">Sonda</span>
                      <span className="font-mono text-slate-400 truncate">{svc.probePath}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-2xs">
                    <span className="text-slate-600 uppercase tracking-wide">Latência</span>
                    <span className="font-mono text-slate-400 tabular-nums">
                      {probe.latencyMs != null ? `${probe.latencyMs}ms` : '—'}
                    </span>
                  </div>
                  <p className="text-2xs text-slate-500 pt-1 leading-relaxed">{probe.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Conectores externos ── */}
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Conectores Externos</h3>
          <p className="text-xs text-slate-500 mt-1">
            Credenciais e ativação são geridas no backend — esta vista é apenas informativa.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {EXTERNAL_CONNECTORS.map((conn) => (
            <div key={conn.key} className="card flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-surface-overlay flex items-center justify-center text-xl shrink-0">
                {conn.icon}
              </div>
              <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-slate-100 truncate">{conn.name}</h4>
                  <span className="badge badge-neutral shrink-0">Não configurado</span>
                </div>
                <p className="text-xs text-slate-500">{conn.description}</p>
                <p className="text-2xs text-slate-600 leading-relaxed">{conn.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Nota de rodapé ── */}
      <div className="card border-brand-500/20 bg-brand-500/[0.03] flex items-start gap-3 py-4">
        <svg className="w-5 h-5 text-brand-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-xs text-slate-400 leading-relaxed">
          As sondas partem do <strong className="text-slate-300">browser</strong> e passam sempre pelo
          api-gateway — nunca contactam microsserviços diretamente, conforme a regra 1 de
          <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-overlay text-brand-400 text-2xs">backend/README.md</code>.
          Um serviço pode portanto estar no ar e ainda assim aparecer aqui como não implementado,
          caso não tenha rota registada no gateway.
        </p>
      </div>
    </div>
  );
}
