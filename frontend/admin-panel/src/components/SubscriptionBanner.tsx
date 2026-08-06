'use client';

/**
 * @file SubscriptionBanner.tsx
 * @description Aviso global do estado da subscrição (avaliação, atraso, quota).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Aparece no topo de qualquer página do painel quando há algo a decidir: a
 * avaliação está a terminar, há fatura por pagar, o serviço já está limitado ou
 * o consumo aproxima-se do limite do plano. Silencioso quando está tudo em dia
 * — e silencioso também em erro (um utilizador sem permissão para ler a
 * subscrição não deve ver ruído).
 *
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminApi, type SubscriptionState, type LimitUsage } from '@/services/api';
import { useAdminUser } from '@/hooks/useAdminUser';

type Tone = 'danger' | 'warning' | 'info';

const TONE_CLASS: Record<Tone, string> = {
  danger:  'bg-red-500/10 border-red-500/20 text-red-400',
  warning: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  info:    'bg-brand-500/10 border-brand-500/20 text-brand-400',
};

/** Dias inteiros até uma data (negativo = já passou). */
function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

/** O limite mais apertado que já passou os 80%. */
function tightestLimit(state: SubscriptionState): { label: string; usage: LimitUsage } | null {
  const candidates: Array<{ label: string; usage: LimitUsage }> = [
    { label: 'pedidos deste mês', usage: state.usage.orders },
    { label: 'utilizadores',      usage: state.usage.users },
    { label: 'armazéns',          usage: state.usage.warehouses },
  ];
  const near = candidates
    .filter((c) => c.usage.limit !== null && (c.usage.percent ?? 0) >= 80)
    .sort((a, b) => (b.usage.percent ?? 0) - (a.usage.percent ?? 0));
  return near[0] ?? null;
}

/**
 * Decide a mensagem a mostrar. PURA — a ordem é de severidade decrescente.
 * @returns null quando não há nada a comunicar.
 */
function buildMessage(state: SubscriptionState): { tone: Tone; text: string; cta: string } | null {
  if (state.access.blocked) {
    return { tone: 'danger', text: state.access.reason ?? 'A subscrição não está ativa.', cta: 'Resolver' };
  }

  if (state.subscription.status === 'past_due') {
    const left = daysUntil(state.access.grace_ends_at);
    return {
      tone: 'warning',
      text: `Fatura da subscrição por pagar.${left !== null ? ` O serviço continua por mais ${Math.max(left, 0)} dia(s).` : ''}`,
      cta: 'Pagar agora',
    };
  }

  const near = tightestLimit(state);
  if (near) {
    return {
      tone: near.usage.exceeded ? 'danger' : 'warning',
      text: near.usage.exceeded
        ? `Limite do plano atingido: ${near.usage.used} de ${near.usage.limit} ${near.label}.`
        : `Já usou ${near.usage.percent}% dos ${near.label} do plano (${near.usage.used} de ${near.usage.limit}).`,
      cta: 'Ver planos',
    };
  }

  if (state.subscription.status === 'trialing') {
    const left = daysUntil(state.subscription.trial_ends_at);
    if (left !== null && left <= 5) {
      return { tone: 'info', text: `A avaliação gratuita termina em ${Math.max(left, 0)} dia(s).`, cta: 'Escolher plano' };
    }
  }

  return null;
}

export default function SubscriptionBanner() {
  const pathname = usePathname();
  const { role, isAuthenticated, companyId } = useAdminUser();
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Só utilizadores de empresa têm subscrição (o SUPERADMIN gere-as em /empresas).
  const applies = isAuthenticated && !!companyId && (role === 'ADMIN' || role === 'SUPPORT');

  useEffect(() => {
    if (!applies) return;
    let alive = true;
    adminApi.getMySubscription()
      .then((s) => { if (alive) setState(s); })
      .catch(() => { /* sem permissão ou sem subscrição — o banner cala-se */ });
    return () => { alive = false; };
  }, [applies]);

  if (!applies || !state || dismissed || pathname === '/plano') return null;

  const message = buildMessage(state);
  if (!message) return null;

  return (
    <div className={`flex items-center gap-3 border-b px-6 py-2.5 text-xs ${TONE_CLASS[message.tone]}`} role="status">
      <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span className="flex-1">{message.text}</span>
      <Link href="/plano" className="font-bold underline underline-offset-2 whitespace-nowrap">
        {message.cta}
      </Link>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dispensar aviso"
        className="opacity-60 hover:opacity-100 transition-opacity"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export { buildMessage };
