'use client';

/**
 * @file page.tsx
 * @description Configurações — perfil, preferências do painel e parâmetros operacionais.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — OAuth2/JWT, RBAC)
 *
 * PERSISTÊNCIA:
 * Toda a lógica de leitura/escrita vive em @/hooks/usePreferences — esta tela é
 * apenas a UI de edição. As mesmas preferências são consumidas pelas telas de
 * Pedidos, Rotas e Painel Geral.
 *
 * O perfil é lido do JWT via useAdminUser (não editável aqui — a alteração de
 * dados de utilizador é responsabilidade do serviço de identidade).
 */

import React from 'react';
import { useAdminUser } from '@/hooks/useAdminUser';
import { usePreferences, STORAGE_KEY } from '@/hooks/usePreferences';

const API_URL     = process.env.NEXT_PUBLIC_API_URL     || 'http://localhost:4000';
const API_VERSION = process.env.NEXT_PUBLIC_API_VERSION || 'v1';

const ROLE_LABELS: Record<string, { label: string; badgeClass: string }> = {
  ADMIN:   { label: 'Administrador',   badgeClass: 'badge-brand'   },
  SYSTEM:  { label: 'Sistema',         badgeClass: 'badge-info'    },
  SUPPORT: { label: 'Suporte',         badgeClass: 'badge-info'    },
  DRIVER:  { label: 'Motorista',       badgeClass: 'badge-warning' },
  CLIENT:  { label: 'Cliente',         badgeClass: 'badge-neutral' },
};

// ────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ────────────────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label, hint }: {
  checked:  boolean;
  onChange: (v: boolean) => void;
  label:    string;
  hint:     string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-200">{label}</p>
        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full shrink-0 transition-colors duration-150
                    outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                    ${checked ? 'bg-brand-600' : 'bg-surface-overlay'}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-150
                      ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-white/[0.04] last:border-b-0">
      <span className="text-xs text-slate-500 uppercase tracking-wide shrink-0">{label}</span>
      <span className={`text-sm text-slate-300 truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

export default function ConfiguracoesPage() {
  const user = useAdminUser();

  // `set` persiste de imediato e propaga às outras telas — não há botão "Guardar".
  const { prefs, loaded, set: update, reset } = usePreferences();

  const handleLogout = () => {
    localStorage.removeItem('token');
    window.location.href = '/login';
  };

  const roleMeta = ROLE_LABELS[user.role] ?? ROLE_LABELS.ADMIN;

  const formatCurrency = (cents: number) =>
    new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(cents / 100);

  return (
    <div className="flex flex-col gap-6">
      {/* ── Cabeçalho ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Configurações</h2>
          <p className="text-xs text-slate-500 mt-1">
            Perfil, preferências do painel e parâmetros operacionais — as alterações
            aplicam-se de imediato
          </p>
        </div>
        <button onClick={reset} className="btn btn-secondary btn-sm self-start sm:self-auto">
          Repor padrões
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Perfil ── */}
        <div className="card flex flex-col gap-4">
          <h3 className="text-base font-semibold text-slate-100">Perfil</h3>

          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-lg font-bold text-brand-400 shrink-0">
              {(user.email || '?').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-100 truncate">
                {user.email || 'Sessão não identificada'}
              </p>
              <span className={`badge ${roleMeta.badgeClass} mt-1`}>{roleMeta.label}</span>
            </div>
          </div>

          <div className="flex flex-col">
            <InfoRow
              label="Sessão"
              value={user.isAuthenticated ? 'Ativa' : 'Sem token válido'}
            />
            <InfoRow label="Papel (JWT)" value={user.role} mono />
          </div>

          <p className="text-2xs text-slate-600 leading-relaxed">
            Os dados de perfil vêm do JWT e não são editáveis aqui — a alteração é
            responsabilidade do serviço de identidade.
          </p>

          <button onClick={handleLogout} className="btn btn-danger btn-sm mt-auto">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Terminar sessão
          </button>
        </div>

        {/* ── Preferências do painel ── */}
        <div className="card lg:col-span-2 flex flex-col gap-2">
          <div className="mb-2">
            <h3 className="text-base font-semibold text-slate-100">Preferências do Painel</h3>
            <p className="text-xs text-slate-500 mt-1">
              Guardadas neste browser — não são sincronizadas entre dispositivos.
            </p>
          </div>

          {!loaded ? (
            <div className="flex flex-col gap-3 py-2">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-full" />)}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 py-3 border-b border-white/[0.04]">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200">Intervalo de atualização</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Frequência com que os painéis re-consultam o gateway.
                  </p>
                </div>
                <select
                  value={prefs.refreshIntervalSec}
                  onChange={(e) => update('refreshIntervalSec', Number(e.target.value))}
                  aria-label="Intervalo de atualização"
                  className="input w-auto shrink-0"
                >
                  <option value={10}>10 segundos</option>
                  <option value={30}>30 segundos</option>
                  <option value={60}>1 minuto</option>
                  <option value={300}>5 minutos</option>
                </select>
              </div>

              <div className="border-b border-white/[0.04]">
                <Toggle
                  checked={prefs.alertOnFailure}
                  onChange={(v) => update('alertOnFailure', v)}
                  label="Destacar insucessos"
                  hint="Realça a linha dos pedidos em insucesso nas tabelas de Pedidos e Rotas."
                />
              </div>

              <div className="border-b border-white/[0.04]">
                <Toggle
                  checked={prefs.showCurrency}
                  onChange={(v) => update('showCurrency', v)}
                  label="Mostrar valores monetários"
                  hint="Exibe a coluna de valor nas tabelas de Pedidos, Rotas e Painel Geral."
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200">Densidade das tabelas</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Compacta cabe mais linhas por ecrã.
                  </p>
                </div>
                <div className="flex gap-1 bg-surface-elevated rounded-xl p-1 shrink-0">
                  {(['comfortable', 'compact'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => update('density', d)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors
                                  ${prefs.density === d
                                    ? 'bg-brand-600 text-white'
                                    : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      {d === 'comfortable' ? 'Confortável' : 'Compacta'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Parâmetros operacionais ── */}
      <div className="card flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Parâmetros Operacionais</h3>
          <p className="text-xs text-slate-500 mt-1">
            Valores usados como pré-preenchimento no painel. Ainda não são aplicados
            server-side — não existe endpoint de configuração no api-gateway.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="baseFee" className="text-xs font-medium text-slate-400 uppercase tracking-wide">
              Tarifa base por entrega
            </label>
            <div className="flex items-center gap-3">
              <input
                id="baseFee"
                type="number"
                min={0}
                step={10}
                value={prefs.baseFeeCents}
                onChange={(e) => update('baseFeeCents', Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="input"
              />
              <span className="text-sm text-slate-400 whitespace-nowrap tabular-nums">
                = {formatCurrency(prefs.baseFeeCents)}
              </span>
            </div>
            <p className="text-2xs text-slate-600">
              Em centavos inteiros — nunca float, conforme a regra 5 de backend/README.md.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="sla" className="text-xs font-medium text-slate-400 uppercase tracking-wide">
              SLA alvo de entrega
            </label>
            <div className="flex items-center gap-3">
              <input
                id="sla"
                type="number"
                min={1}
                max={720}
                value={prefs.slaHours}
                onChange={(e) => update('slaHours', Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="input"
              />
              <span className="text-sm text-slate-400 whitespace-nowrap">
                horas ({(prefs.slaHours / 24).toFixed(1)} dias)
              </span>
            </div>
            <p className="text-2xs text-slate-600">
              Prazo alvo entre a criação do pedido e a entrega efetiva.
            </p>
          </div>
        </div>
      </div>

      {/* ── Informação do sistema ── */}
      <div className="card flex flex-col gap-4">
        <h3 className="text-base font-semibold text-slate-100">Sistema</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <div className="flex flex-col">
            <InfoRow label="API Gateway" value={API_URL} mono />
            <InfoRow label="Versão da API" value={API_VERSION} mono />
          </div>
          <div className="flex flex-col">
            <InfoRow label="Ambiente" value={process.env.NODE_ENV ?? 'development'} mono />
            <InfoRow label="Preferências" value={STORAGE_KEY} mono />
          </div>
        </div>
      </div>

      {/* ── Aviso de persistência ── */}
      <div className="card border-amber-500/20 bg-amber-500/[0.04] flex items-start gap-3 py-4">
        <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-xs text-slate-400 leading-relaxed">
          Estas definições vivem apenas no <strong className="text-slate-300">localStorage deste browser</strong>.
          Limpar os dados do navegador repõe os valores padrão, e outro utilizador ou dispositivo
          verá as suas próprias definições. A persistência partilhada exige um endpoint
          <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-overlay text-brand-400 text-2xs">/v1/settings</code>
          no api-gateway, que ainda não existe.
        </p>
      </div>
    </div>
  );
}
