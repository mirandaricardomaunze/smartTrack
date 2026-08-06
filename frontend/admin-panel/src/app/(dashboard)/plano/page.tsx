'use client';

/**
 * @file page.tsx
 * @description Plano & Uso — subscrição da empresa, consumo e faturas da plataforma.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Esta é a página onde a EMPRESA gere o que paga à PLATAFORMA: plano atual,
 * consumo contra os limites, mudança de plano e pagamento das faturas de
 * subscrição (M-Pesa/eMola simulados, ou transferência confirmada pela
 * plataforma). Não confundir com /faturas, que são as faturas de frete que a
 * empresa emite aos seus clientes.
 *
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type SubscriptionState,
  type Plan,
  type SubscriptionInvoice,
  type SubscriptionStatus,
  type LimitUsage,
  type BillingMethod,
} from '@/services/api';
import { useAdminUser } from '@/hooks/useAdminUser';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { exportSubscriptionInvoicePdf } from '@/services/documentPdf';
import { Button, Card, Input, Select, PageHeader, DataTable } from '@/components/ui';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysUntil(iso?: string): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}

const STATUS_META: Record<SubscriptionStatus, { label: string; className: string }> = {
  trialing: { label: 'Em avaliação',       className: 'bg-brand-500/15 text-brand-400' },
  active:   { label: 'Ativa',              className: 'bg-emerald-500/15 text-emerald-400' },
  past_due: { label: 'Pagamento pendente', className: 'bg-amber-500/15 text-amber-400' },
  canceled: { label: 'Cancelada',          className: 'bg-red-500/15 text-red-400' },
};

const INVOICE_STATUS_META: Record<string, { label: string; className: string }> = {
  issued: { label: 'Por pagar', className: 'bg-amber-500/15 text-amber-400' },
  paid:   { label: 'Paga',      className: 'bg-emerald-500/15 text-emerald-400' },
  void:   { label: 'Anulada',   className: 'bg-slate-500/15 text-slate-400' },
};

// ─── Medidor de consumo ───────────────────────────────────────────────────────

function UsageMeter({ label, usage, unit }: { label: string; usage: LimitUsage; unit?: string }) {
  const unlimited = usage.limit === null;
  const percent = unlimited ? 0 : (usage.percent ?? 0);
  const barClass =
    usage.exceeded ? 'bg-red-500'
    : percent >= 80 ? 'bg-amber-400'
    : 'bg-brand-400';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="font-mono text-slate-200">
          {usage.used}{unit ? ` ${unit}` : ''}
          <span className="text-slate-500"> / {unlimited ? 'ilimitado' : usage.limit}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${unlimited ? 'bg-slate-600' : barClass}`}
          style={{ width: unlimited ? '100%' : `${Math.max(percent, 2)}%` }}
          role="progressbar"
          aria-label={label}
          aria-valuenow={usage.used}
          aria-valuemax={usage.limit ?? undefined}
        />
      </div>
    </div>
  );
}

// ─── Cartão de plano ──────────────────────────────────────────────────────────

function PlanCard({ plan, current, busy, onChoose }: {
  plan: Plan; current: boolean; busy: boolean; onChoose: (code: string) => void;
}) {
  const limit = (v: number | null, label: string) => (v === null ? `${label} ilimitados` : `${v} ${label}`);

  return (
    <Card className={`flex flex-col gap-4 ${current ? 'ring-1 ring-brand-500/50' : ''}`}>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100">{plan.name}</h3>
          {current && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-brand-500/15 text-brand-400">Plano atual</span>}
        </div>
        <p className="text-xs text-slate-500 mt-1 min-h-[32px]">{plan.description}</p>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-xl font-bold text-slate-100">{plan.price_cents > 0 ? mzn(plan.price_cents) : 'Grátis'}</span>
        {plan.price_cents > 0 && <span className="text-xs text-slate-500">/mês</span>}
      </div>

      <ul className="flex flex-col gap-1.5 text-xs text-slate-400">
        <li>{limit(plan.max_orders_per_month, 'pedidos')} por mês</li>
        <li>{limit(plan.max_users, 'utilizadores')}</li>
        <li>{limit(plan.max_warehouses, 'armazéns')}</li>
        {plan.trial_days > 0 && <li className="text-brand-400">{plan.trial_days} dias de avaliação</li>}
      </ul>

      <Button
        variant={current ? 'secondary' : 'primary'}
        size="sm"
        disabled={current}
        loading={busy}
        onClick={() => onChoose(plan.code)}
        className="mt-auto"
      >
        {current ? 'Em utilização' : 'Mudar para este plano'}
      </Button>
    </Card>
  );
}

// ─── Página ───────────────────────────────────────────────────────────────────

export default function PlanoPage() {
  const { role, isAuthenticated } = useAdminUser();
  const { profile } = useCompanyProfile();
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyPlan, setBusyPlan] = useState<string | null>(null);

  // Checkout
  const [payTarget, setPayTarget] = useState<SubscriptionInvoice | null>(null);
  const [method, setMethod] = useState<BillingMethod>('mpesa');
  const [msisdn, setMsisdn] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');

  const canManage = role === 'ADMIN';

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [s, p] = await Promise.all([adminApi.getMySubscription(), adminApi.getPlans()]);
      setState(s);
      setPlans(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar a subscrição.');
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const choosePlan = async (code: string) => {
    setBusyPlan(code);
    setError('');
    setNotice('');
    try {
      setState(await adminApi.changePlan(code));
      setNotice('Plano alterado. Se o plano novo for pago, foi emitida a fatura do período.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao mudar de plano.');
    } finally {
      setBusyPlan(null);
    }
  };

  const cancel = async () => {
    setBusyPlan('cancel');
    setError('');
    setNotice('');
    try {
      setState(await adminApi.cancelSubscription());
      setNotice('Subscrição cancelada. Escolha um plano para retomar o serviço.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao cancelar a subscrição.');
    } finally {
      setBusyPlan(null);
    }
  };

  const pay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    setPaying(true);
    setPayError('');
    try {
      const result = await adminApi.checkoutSubscriptionInvoice(payTarget.id, method, msisdn);
      setPayTarget(null);
      setMsisdn('');
      setNotice(`${result.message}${result.transaction_id ? ` Referência: ${result.transaction_id}` : ''}`);
      await load();
    } catch (err) {
      setPayError(err instanceof Error ? err.message : 'Falha ao processar o pagamento.');
    } finally {
      setPaying(false);
    }
  };

  // O SUPERADMIN não tem empresa — a gestão dele é a consola /empresas.
  if (isAuthenticated && role === 'SUPERADMIN') {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Plano & Uso" description="Subscrição da empresa." />
        <Card className="p-10 text-center text-sm text-slate-400">
          O SUPERADMIN não pertence a nenhuma empresa. Faça a gestão de planos em <strong className="text-slate-200">Empresas</strong>.
        </Card>
      </div>
    );
  }

  const sub = state?.subscription;
  const plan = state?.plan;
  const statusMeta = sub ? STATUS_META[sub.status] : null;
  const trialLeft = sub?.status === 'trialing' ? daysUntil(sub.trial_ends_at) : null;
  const graceLeft = state?.access.grace_ends_at ? daysUntil(state.access.grace_ends_at) : null;
  const selfServePlans = plans.filter((p) => p.self_serve && p.active);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plano & Uso"
        description="A sua subscrição da plataforma, o consumo do mês e as faturas."
        actions={<Button variant="secondary" size="sm" onClick={() => load()}>Atualizar</Button>}
      />

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}
      {notice && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-4 rounded-2xl text-xs">
          {notice}
        </div>
      )}
      {state?.access.blocked && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl text-xs">
          <strong className="font-bold">Serviço limitado.</strong> {state.access.reason}
        </div>
      )}
      {!state?.access.blocked && sub?.status === 'past_due' && graceLeft !== null && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs">
          Há uma fatura por pagar. O serviço continua durante mais {graceLeft} dia(s) — até {fmtDate(state?.access.grace_ends_at)}.
        </div>
      )}

      {/* ── Estado atual + consumo ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6 items-start">
        <Card className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[0.6rem] font-bold uppercase tracking-[0.1em] text-slate-500">Plano atual</p>
              <h2 className="text-lg font-bold text-slate-100 mt-0.5">
                {loading ? 'A carregar...' : plan?.name ?? 'Sem plano'}
              </h2>
            </div>
            {statusMeta && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusMeta.className}`}>
                {statusMeta.label}
              </span>
            )}
          </div>

          {plan && (
            <p className="text-sm text-slate-300">
              {plan.price_cents > 0 ? `${mzn(plan.price_cents)} por mês, IVA incluído.` : 'Sem custo mensal.'}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-3 text-xs">
            {trialLeft !== null && (
              <div className="col-span-2 rounded-xl bg-brand-500/[0.08] px-3 py-2">
                <dt className="text-brand-400 font-semibold">Avaliação gratuita</dt>
                <dd className="text-slate-300 mt-0.5">
                  Faltam {Math.max(trialLeft, 0)} dia(s) — termina a {fmtDate(sub?.trial_ends_at)}.
                </dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Período atual</dt>
              <dd className="text-slate-200 mt-0.5">{fmtDate(sub?.current_period_start)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Renova a</dt>
              <dd className="text-slate-200 mt-0.5">{fmtDate(sub?.current_period_end)}</dd>
            </div>
          </dl>

          {canManage && sub && sub.status !== 'canceled' && (
            <Button
              variant="ghost" size="sm" className="text-red-400 self-start mt-auto"
              loading={busyPlan === 'cancel'} onClick={cancel}
            >
              Cancelar subscrição
            </Button>
          )}
        </Card>

        <Card className="flex flex-col gap-4">
          <div>
            <p className="text-[0.6rem] font-bold uppercase tracking-[0.1em] text-slate-500">Consumo</p>
            <h2 className="text-lg font-bold text-slate-100 mt-0.5">
              {state?.usage.period ?? '—'}
            </h2>
          </div>
          {state ? (
            <div className="flex flex-col gap-3.5">
              <UsageMeter label="Pedidos criados este mês" usage={state.usage.orders} />
              <UsageMeter label="Utilizadores" usage={state.usage.users} />
              <UsageMeter label="Armazéns" usage={state.usage.warehouses} />
              <UsageMeter label="Motoristas" usage={state.usage.drivers} />
            </div>
          ) : (
            <p className="text-xs text-slate-500">{loading ? 'A carregar...' : 'Sem dados de consumo.'}</p>
          )}
        </Card>
      </div>

      {/* ── Catálogo ── */}
      <div>
        <h2 className="text-sm font-bold text-slate-100 mb-3">Planos disponíveis</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {selfServePlans.map((p) => (
            <PlanCard
              key={p.code}
              plan={p}
              current={p.code === sub?.plan_code}
              busy={busyPlan === p.code}
              onChoose={canManage ? choosePlan : () => setError('Apenas o ADMIN da empresa pode mudar de plano.')}
            />
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Precisa de mais volume ou de limites à medida? O plano Enterprise é negociado com a equipa comercial.
        </p>
      </div>

      {/* ── Faturas da subscrição ── */}
      <div>
        <h2 className="text-sm font-bold text-slate-100 mb-3">Faturas da subscrição</h2>
        <DataTable<SubscriptionInvoice>
          data={state?.invoices ?? []}
          loading={loading}
          getRowKey={(i) => i.id}
          emptyTitle="Sem faturas"
          emptyDescription="As faturas da sua subscrição aparecerão aqui."
          columns={[
            { key: 'number', header: 'Número', cell: (i) => (
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold text-slate-200">{i.number}</span>
                <span className="text-[11px] text-slate-500">{i.plan_name}</span>
              </div>
            ) },
            { key: 'period', header: 'Período', cell: (i) => (
              <span className="text-xs text-slate-400">{fmtDate(i.period_start)} — {fmtDate(i.period_end)}</span>
            ) },
            { key: 'total', header: 'Total', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (i) => mzn(i.total_cents) },
            { key: 'status', header: 'Estado', cell: (i) => {
              const meta = INVOICE_STATUS_META[i.status];
              return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${meta.className}`}>{meta.label}</span>;
            } },
            { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right', cell: (i) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => exportSubscriptionInvoicePdf(i, profile)}>PDF</Button>
                {i.status === 'issued' && canManage && (
                  <Button size="sm" variant="primary" onClick={() => { setPayTarget(i); setPayError(''); }}>Pagar</Button>
                )}
              </div>
            ) },
          ]}
        />
        <p className="text-xs text-slate-500 mt-3">
          Também pode pagar por transferência bancária: a plataforma confirma a fatura assim que receber o comprovativo.
        </p>
      </div>

      {/* ── Modal de pagamento ── */}
      {payTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPayTarget(null)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={pay} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">Pagar {payTarget.number}</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPayTarget(null)}>Fechar</Button>
              </div>

              <div className="rounded-xl bg-surface-elevated p-3 flex flex-col gap-1.5 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Plano</span><span>{payTarget.plan_name}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Base tributável</span><span className="font-mono">{mzn(payTarget.subtotal_cents)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">IVA ({payTarget.tax_rate_pct}%)</span><span className="font-mono">{mzn(payTarget.tax_cents)}</span></div>
                <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1 font-bold text-slate-100"><span>Total</span><span className="font-mono">{mzn(payTarget.total_cents)}</span></div>
              </div>

              <Select
                label="Carteira móvel" value={method} className="text-xs"
                onChange={(e) => setMethod(e.target.value as BillingMethod)}
                options={[{ value: 'mpesa', label: 'M-Pesa' }, { value: 'emola', label: 'eMola' }]}
              />
              <Input
                label="Número de telemóvel" value={msisdn} className="text-xs" placeholder="84xxxxxxx"
                onChange={(e) => setMsisdn(e.target.value)}
              />

              <p className="text-[11px] text-slate-500">
                Pagamento em modo simulado: nenhum valor é debitado. A ligação ao gateway real entra sem alterar este ecrã.
              </p>

              {payError && <p className="text-xs text-red-400">{payError}</p>}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setPayTarget(null)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={paying}>Pagar {mzn(payTarget.total_cents)}</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
