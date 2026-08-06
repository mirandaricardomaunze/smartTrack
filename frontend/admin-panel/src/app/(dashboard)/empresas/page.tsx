'use client';

/**
 * @file page.tsx
 * @description Consola da plataforma (SUPERADMIN) — empresas, planos e receita.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4 (Multiempresa)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.5 (Planos e subscrições)
 *
 * Só acessível a SUPERADMIN. Lista as empresas com utilizadores, pedidos e o
 * plano em vigor, permite suspender/reativar e atribuir plano (incluindo os
 * negociados), e mostra a receita: MRR, cobrado e por cobrar — com confirmação
 * manual das faturas pagas por transferência. Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type CompanySummary,
  type Plan,
  type PlatformBillingStats,
  type SubscriptionInvoice,
  type SubscriptionStatus,
} from '@/services/api';
import { useAdminUser } from '@/hooks/useAdminUser';
import { Button, Card, Input, Select, PageHeader, StatCard, DataTable } from '@/components/ui';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
}

const SUB_STATUS_META: Record<SubscriptionStatus, { label: string; className: string }> = {
  trialing: { label: 'Avaliação', className: 'bg-brand-500/15 text-brand-400' },
  active:   { label: 'Ativa',     className: 'bg-emerald-500/15 text-emerald-400' },
  past_due: { label: 'Em atraso', className: 'bg-amber-500/15 text-amber-400' },
  canceled: { label: 'Cancelada', className: 'bg-red-500/15 text-red-400' },
};

export default function EmpresasPage() {
  const { role, isAuthenticated } = useAdminUser();
  const [items, setItems] = useState<CompanySummary[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [stats, setStats] = useState<PlatformBillingStats | null>(null);
  const [invoices, setInvoices] = useState<SubscriptionInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Atribuição de plano
  const [planTarget, setPlanTarget] = useState<CompanySummary | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [planError, setPlanError] = useState('');

  // Confirmação manual de pagamento
  const [payTarget, setPayTarget] = useState<SubscriptionInvoice | null>(null);
  const [reference, setReference] = useState('');
  const [payError, setPayError] = useState('');

  const isSuper = role === 'SUPERADMIN';

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [companies, catalogue, billing, outstanding] = await Promise.all([
        adminApi.getCompanies(),
        adminApi.getPlans(),
        adminApi.getPlatformBillingStats(),
        adminApi.getSubscriptionInvoices('issued'),
      ]);
      setItems(companies);
      setPlans(catalogue);
      setStats(billing);
      setInvoices(outstanding);
    } catch {
      setError('Não foi possível carregar a consola. (Acesso restrito ao SUPERADMIN da plataforma.)');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isSuper) void load(); else setLoading(false); }, [isSuper, load]);

  const toggle = async (c: CompanySummary) => {
    setBusy(c.id);
    try {
      await adminApi.setCompanyStatus(c.id, c.status === 'active' ? 'suspended' : 'active');
      await load();
    } catch {
      setError('Falha ao atualizar o estado da empresa.');
    } finally {
      setBusy(null);
    }
  };

  const openPlan = (c: CompanySummary) => {
    setPlanTarget(c);
    setPlanCode(c.plan_code ?? plans[0]?.code ?? '');
    setPlanError('');
  };

  const assignPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!planTarget) return;
    setBusy(planTarget.id);
    setPlanError('');
    try {
      await adminApi.assignCompanyPlan(planTarget.id, planCode);
      setPlanTarget(null);
      await load();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : 'Falha ao atribuir o plano.');
    } finally {
      setBusy(null);
    }
  };

  const confirmPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    setBusy(payTarget.id);
    setPayError('');
    try {
      await adminApi.paySubscriptionInvoice(payTarget.id, reference);
      setPayTarget(null);
      setReference('');
      await load();
    } catch (err) {
      setPayError(err instanceof Error ? err.message : 'Falha ao confirmar o pagamento.');
    } finally {
      setBusy(null);
    }
  };

  if (isAuthenticated && !isSuper) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Empresas" description="Consola da plataforma." />
        <Card className="p-10 text-center text-sm text-slate-400">
          Esta área é exclusiva do <strong className="text-slate-200">SUPERADMIN</strong> da plataforma.
        </Card>
      </div>
    );
  }

  const totalUsers = items.reduce((s, c) => s + c.users, 0);
  const totalOrders = items.reduce((s, c) => s + c.orders, 0);
  const active = items.filter((c) => c.status === 'active').length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Empresas" description="Gestão das empresas, planos e receita da plataforma (SUPERADMIN)." />

      <div className="stats-grid">
        <StatCard label="Empresas" value={items.length} helper={`${active} ativas`} />
        <StatCard label="Receita mensal (MRR)" value={mzn(stats?.mrr_cents ?? 0)} helper={`${stats?.active ?? 0} ativas · ${stats?.trialing ?? 0} em avaliação`} />
        <StatCard label="Por cobrar" value={mzn(stats?.outstanding_cents ?? 0)} helper={`${invoices.length} fatura(s) em aberto`} />
        <StatCard label="Cobrado" value={mzn(stats?.collected_cents ?? 0)} helper="Total pago pelas empresas" />
        <StatCard label="Utilizadores" value={totalUsers} helper="Total na plataforma" />
        <StatCard label="Pedidos" value={totalOrders} helper="Total na plataforma" />
      </div>

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}

      <DataTable<CompanySummary>
        data={items}
        loading={loading}
        getRowKey={(c) => c.id}
        emptyTitle="Nenhuma empresa"
        emptyDescription="As empresas registadas aparecerão aqui."
        columns={[
          { key: 'name', header: 'Empresa', cell: (c) => (
            <div className="flex flex-col">
              <span className="font-semibold text-slate-200">{c.name}</span>
              <span className="font-mono text-[11px] text-slate-500">{c.id}</span>
            </div>
          ) },
          { key: 'plan', header: 'Plano', cell: (c) => (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-300">{c.plan_name ?? 'Sem plano'}</span>
              {c.subscription_status && (
                <span className={`self-start text-[10px] font-bold px-2 py-0.5 rounded-full ${SUB_STATUS_META[c.subscription_status].className}`}>
                  {SUB_STATUS_META[c.subscription_status].label}
                </span>
              )}
            </div>
          ) },
          { key: 'mrr', header: 'Mensalidade', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (c) => c.price_cents ? mzn(c.price_cents) : '—' },
          { key: 'users', header: 'Utilizadores', headerClassName: 'text-center', cellClassName: 'text-center', cell: (c) => c.users },
          { key: 'orders', header: 'Pedidos', headerClassName: 'text-center', cellClassName: 'text-center', cell: (c) => c.orders },
          { key: 'status', header: 'Estado', cell: (c) => c.status === 'active'
            ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Ativa</span>
            : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">Suspensa</span> },
          { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right', cell: (c) => (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => openPlan(c)}>Plano</Button>
              <Button size="sm" variant="ghost" loading={busy === c.id} onClick={() => toggle(c)}
                className={c.status === 'active' ? 'text-red-400' : 'text-emerald-400'}>
                {c.status === 'active' ? 'Suspender' : 'Reativar'}
              </Button>
            </div>
          ) },
        ]}
      />

      {/* ── Faturas de subscrição por cobrar ── */}
      <div>
        <h2 className="text-sm font-bold text-slate-100 mb-3">Faturas por cobrar</h2>
        <DataTable<SubscriptionInvoice>
          data={invoices}
          loading={loading}
          getRowKey={(i) => i.id}
          emptyTitle="Nada por cobrar"
          emptyDescription="Todas as faturas de subscrição estão pagas."
          columns={[
            { key: 'number', header: 'Número', cell: (i) => (
              <div className="flex flex-col">
                <span className="font-mono text-xs font-semibold text-slate-200">{i.number}</span>
                <span className="text-[11px] text-slate-500">{i.company_name}</span>
              </div>
            ) },
            { key: 'plan', header: 'Plano', cellClassName: 'text-xs text-slate-400', cell: (i) => i.plan_name },
            { key: 'period', header: 'Período', cellClassName: 'text-xs text-slate-400', cell: (i) => `${fmtDate(i.period_start)} — ${fmtDate(i.period_end)}` },
            { key: 'total', header: 'Total', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (i) => mzn(i.total_cents) },
            { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right', cell: (i) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="primary" onClick={() => { setPayTarget(i); setPayError(''); }}>Confirmar pagamento</Button>
                <Button size="sm" variant="ghost" className="text-red-400" loading={busy === i.id}
                  onClick={async () => { setBusy(i.id); try { await adminApi.voidSubscriptionInvoice(i.id); await load(); } finally { setBusy(null); } }}>
                  Anular
                </Button>
              </div>
            ) },
          ]}
        />
      </div>

      {/* ── Modal: atribuir plano ── */}
      {planTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPlanTarget(null)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={assignPlan} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">Plano de {planTarget.name}</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPlanTarget(null)}>Fechar</Button>
              </div>

              <Select
                label="Plano" value={planCode} className="text-xs"
                onChange={(e) => setPlanCode(e.target.value)}
                options={plans.map((p) => ({
                  value: p.code,
                  label: `${p.name} — ${p.price_cents > 0 ? `${mzn(p.price_cents)}/mês` : 'sem custo'}${p.self_serve ? '' : ' (negociado)'}`,
                }))}
              />

              <p className="text-[11px] text-slate-500">
                A mudança abre um período novo ao preço do plano escolhido e anula a fatura em aberto do
                ciclo atual (sem proração). Durante a avaliação, mudar de plano não cobra nada.
              </p>

              {planError && <p className="text-xs text-red-400">{planError}</p>}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setPlanTarget(null)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={busy === planTarget.id}>Atribuir</Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* ── Modal: confirmação manual de pagamento ── */}
      {payTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPayTarget(null)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={confirmPayment} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">Confirmar {payTarget.number}</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPayTarget(null)}>Fechar</Button>
              </div>

              <div className="rounded-xl bg-surface-elevated p-3 flex flex-col gap-1.5 text-xs">
                <div className="flex justify-between"><span className="text-slate-400">Empresa</span><span>{payTarget.company_name}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Plano</span><span>{payTarget.plan_name}</span></div>
                <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1 font-bold text-slate-100"><span>Total</span><span className="font-mono">{mzn(payTarget.total_cents)}</span></div>
              </div>

              <Input
                label="Referência do comprovativo" value={reference} className="text-xs"
                placeholder="Ex.: transferência BCI 20260801-0042"
                onChange={(e) => setReference(e.target.value)}
              />
              <p className="text-[11px] text-slate-500">
                Use esta via quando a empresa pagou por transferência ou depósito. A subscrição volta a
                ficar ativa assim que não houver faturas por pagar.
              </p>

              {payError && <p className="text-xs text-red-400">{payError}</p>}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setPayTarget(null)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={busy === payTarget.id}>Marcar como paga</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
