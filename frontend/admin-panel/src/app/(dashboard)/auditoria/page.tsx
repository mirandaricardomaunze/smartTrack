'use client';

/**
 * @file page.tsx
 * @description Auditoria — quem fez o quê, quando e de onde.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * É a página que um auditor ou um cliente empresarial pede: pesquisa por ator,
 * ação, entidade e período, com o detalhe de cada evento e a prova de que o
 * registo não foi adulterado. Só leitura — não há forma de editar nem apagar.
 *
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type AuditEvent,
  type AuditStats,
  type AuditIntegrityReport,
  type AuditOutcome,
} from '@/services/api';
import { useCompanyProfile } from '@/hooks/useCompanyProfile';
import { exportReportPdf } from '@/services/documentPdf';
import { Button, Card, Input, Select, PageHeader, StatCard, DataTable, Pagination } from '@/components/ui';

function fdatetime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString('pt-PT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : '—';
}

const OUTCOME_META: Record<AuditOutcome, { label: string; cls: string }> = {
  success: { label: 'Concluído',  cls: 'bg-emerald-500/15 text-emerald-400' },
  denied:  { label: 'Recusado',   cls: 'bg-amber-500/15 text-amber-400' },
  error:   { label: 'Erro',       cls: 'bg-red-500/15 text-red-400' },
};

function OutcomeBadge({ outcome }: { outcome: AuditOutcome }) {
  const meta = OUTCOME_META[outcome] ?? OUTCOME_META.success;
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>;
}

/** 'invoices.void' → 'Faturas · anulação' — nomes legíveis para quem audita. */
const RESOURCE_LABEL: Record<string, string> = {
  orders: 'Pedidos', invoices: 'Faturas', clients: 'Clientes', warehouses: 'Armazéns',
  drivers: 'Motoristas', settlements: 'Acertos', subscriptions: 'Subscrições',
  companies: 'Empresas', hr: 'Recursos Humanos', auth: 'Autenticação', users: 'Utilizadores',
  pricing: 'Tarifação', support: 'Suporte', finance: 'Finanças', fleet: 'Frota', payments: 'Pagamentos',
};
const VERB_LABEL: Record<string, string> = {
  create: 'criação', update: 'alteração', delete: 'remoção', void: 'anulação',
  credit_note: 'nota de crédito', status: 'mudança de estado', pay: 'pagamento',
  decision: 'decisão', checkout: 'pagamento', cancel: 'cancelamento',
  change_plan: 'mudança de plano', manual_payment: 'pagamento manual',
  leave_decision: 'decisão de licença', payroll_status: 'estado da folha',
};

function humanAction(action: string): string {
  const [resource, ...rest] = action.split('.');
  const verb = rest.join('.');
  return `${RESOURCE_LABEL[resource] ?? resource} · ${VERB_LABEL[verb] ?? verb}`;
}

export default function AuditoriaPage() {
  const { profile } = useCompanyProfile();
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [integrity, setIntegrity] = useState<AuditIntegrityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  const [busy, setBusy] = useState(false);

  // Filtros
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<'' | AuditOutcome>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      // O `to` do formulário é um dia inclusivo; a API compara com `<`.
      const toExclusive = to ? new Date(new Date(to).getTime() + 86_400_000).toISOString() : undefined;
      const [list, summary] = await Promise.all([
        adminApi.getAuditEvents({
          search: search || undefined, action: action || undefined, outcome: outcome || undefined,
          from: from ? new Date(from).toISOString() : undefined, to: toExclusive,
          page, pageSize,
        }),
        adminApi.getAuditStats(from ? new Date(from).toISOString() : undefined, toExclusive).catch(() => null),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setStats(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar o registo de auditoria.');
      setItems([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, action, outcome, from, to, page, pageSize]);

  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { void adminApi.getAuditActions().then(setActions).catch(() => setActions([])); }, []);

  const checkIntegrity = async () => {
    setBusy(true);
    setError('');
    try {
      setIntegrity(await adminApi.getAuditIntegrity());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao verificar a integridade.');
    } finally {
      setBusy(false);
    }
  };

  /** O registo do período em PDF timbrado — é o que se entrega a um auditor. */
  const exportPdf = async () => {
    setBusy(true);
    try {
      const full = await adminApi.getAuditEvents({
        search: search || undefined, action: action || undefined, outcome: outcome || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(new Date(to).getTime() + 86_400_000).toISOString() : undefined,
        page: 1, pageSize: 200,
      });

      await exportReportPdf({
        title: 'Registo de auditoria',
        subtitle: from || to ? `Período de ${from || 'início'} a ${to || 'hoje'}` : 'Todos os eventos registados',
        meta: [
          { label: 'Eventos no período', value: String(full.total) },
          { label: 'Exportados', value: String(full.items.length) },
        ],
        tables: [{
          columns: [
            { header: 'Data', width: 2.2 },
            { header: 'Ator', width: 2.4 },
            { header: 'Ação', width: 2.4 },
            { header: 'Descrição', width: 4.5 },
            { header: 'Estado', width: 1.3 },
          ],
          rows: full.items.map((e) => [
            fdatetime(e.occurred_at),
            e.actor_email ?? '—',
            humanAction(e.action),
            e.summary,
            OUTCOME_META[e.outcome]?.label ?? e.outcome,
          ]),
          emptyLabel: 'Sem eventos no período.',
        }],
        notes: [
          full.total > full.items.length
            ? `Exportados os ${full.items.length} eventos mais recentes de ${full.total}. Restrinja o período para exportar o resto.`
            : 'Exportação completa do período.',
          'Cada evento é assinado e encadeado no anterior: alterar ou apagar uma linha parte a cadeia e a verificação de integridade denuncia.',
        ],
        filename: `auditoria-${new Date().toISOString().slice(0, 10)}.pdf`,
      }, profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao exportar o registo.');
    } finally {
      setBusy(false);
    }
  };

  const resetFilters = () => {
    setSearch(''); setAction(''); setOutcome(''); setFrom(''); setTo(''); setPage(1);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Auditoria"
        description="Quem fez o quê, quando e de onde. Registo só de leitura, assinado e encadeado."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" loading={busy} onClick={checkIntegrity}>Verificar integridade</Button>
            <Button variant="primary" size="sm" loading={busy} onClick={exportPdf}>Exportar PDF</Button>
          </div>
        }
      />

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}

      {integrity && (
        <div className={`p-4 rounded-2xl text-xs border ${integrity.ok
          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
          : 'bg-red-500/10 border-red-500/20 text-red-400'}`}
        >
          <strong className="font-bold">
            {integrity.ok ? 'Registo íntegro.' : 'Registo com falhas.'}
          </strong>{' '}
          {integrity.chains.map((c) => `${c.checked} evento(s) verificados`).join(' · ')} — {fdatetime(integrity.checked_at)}.
          {integrity.chains.flatMap((c) => c.broken).map((b) => (
            <span key={b.id} className="block mt-1">Evento {b.seq}: {b.reason}</span>
          ))}
          {integrity.chains.flatMap((c) => c.gaps).map((g, i) => (
            <span key={i} className="block mt-1">Falta o evento {g.expected} (encontrado {g.found}) — houve remoção.</span>
          ))}
        </div>
      )}

      <div className="stats-grid">
        <StatCard label="Eventos" value={stats?.total ?? '—'} helper={stats?.last_at ? `Último: ${fdatetime(stats.last_at)}` : ''} />
        <StatCard label="Recusados" value={stats?.denied ?? '—'} helper="Sem permissão, quota ou subscrição" />
        <StatCard label="Erros" value={stats?.errors ?? '—'} helper="Pedidos que falharam" />
        <StatCard label="Utilizadores ativos" value={stats?.actors ?? '—'} helper="Distintos no período" />
      </div>

      {/* ── Filtros ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
        <Input label="Pesquisar" placeholder="Ator, descrição ou documento" value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="text-xs" containerClassName="lg:col-span-2" />
        <Select label="Ação" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }}
          options={[{ value: '', label: 'Todas' }, ...actions.map((a) => ({ value: a, label: humanAction(a) }))]}
          className="text-xs" />
        <Select label="Estado" value={outcome} onChange={(e) => { setPage(1); setOutcome(e.target.value as '' | AuditOutcome); }}
          options={[
            { value: '', label: 'Todos' },
            { value: 'success', label: 'Concluídos' },
            { value: 'denied', label: 'Recusados' },
            { value: 'error', label: 'Erros' },
          ]} className="text-xs" />
        <div className="flex gap-2">
          <Input label="De" type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} className="text-xs" containerClassName="flex-1" />
          <Input label="Até" type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} className="text-xs" containerClassName="flex-1" />
        </div>
      </div>
      {(search || action || outcome || from || to) && (
        <button type="button" onClick={resetFilters} className="self-start text-xs text-brand-400 hover:underline">
          Limpar filtros
        </button>
      )}

      <DataTable<AuditEvent>
        data={items}
        loading={loading}
        getRowKey={(e) => e.id}
        emptyTitle="Sem eventos"
        emptyDescription="Nada corresponde a estes filtros."
        columns={[
          { key: 'when', header: 'Quando', cell: (e) => (
            <div className="flex flex-col">
              <span className="text-xs text-slate-200">{fdatetime(e.occurred_at)}</span>
              <span className="font-mono text-[10px] text-slate-600">#{e.seq}</span>
            </div>
          ) },
          { key: 'actor', header: 'Quem', cell: (e) => (
            <div className="flex flex-col">
              <span className="text-xs text-slate-200">{e.actor_email ?? 'visitante'}</span>
              {e.actor_role && <span className="text-[10px] text-slate-500">{e.actor_role}</span>}
            </div>
          ) },
          { key: 'action', header: 'O quê', cell: (e) => (
            <div className="flex flex-col">
              <span className="text-xs text-slate-200">{humanAction(e.action)}</span>
              {e.entity_label && <span className="font-mono text-[10px] text-slate-500">{e.entity_label}</span>}
            </div>
          ) },
          { key: 'summary', header: 'Descrição', cellClassName: 'text-xs text-slate-400', cell: (e) => e.summary },
          { key: 'outcome', header: 'Estado', cell: (e) => <OutcomeBadge outcome={e.outcome} /> },
          { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right', cell: (e) => (
            <Button size="sm" variant="ghost" onClick={() => setDetail(e)}>Detalhe</Button>
          ) },
        ]}
        footer={<Pagination page={page} pageSize={pageSize} totalItems={total} itemLabel="eventos"
          onPageChange={setPage} onPageSizeChange={(s) => { setPage(1); setPageSize(s); }} />}
      />

      {/* ── Detalhe ── */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-100">{humanAction(detail.action)}</h2>
                  <p className="text-xs text-slate-500 mt-0.5">{fdatetime(detail.occurred_at)} · evento #{detail.seq}</p>
                </div>
                <OutcomeBadge outcome={detail.outcome} />
              </div>

              <p className="text-sm text-slate-300">{detail.summary}</p>

              <dl className="grid grid-cols-2 gap-2.5 text-xs rounded-xl bg-surface-elevated p-3">
                <div><dt className="text-slate-500">Ator</dt><dd className="text-slate-200">{detail.actor_email ?? 'visitante'}</dd></div>
                <div><dt className="text-slate-500">Papel</dt><dd className="text-slate-200">{detail.actor_role ?? '—'}</dd></div>
                <div><dt className="text-slate-500">Ação</dt><dd className="font-mono text-slate-200">{detail.action}</dd></div>
                <div><dt className="text-slate-500">Resultado</dt><dd className="text-slate-200">{OUTCOME_META[detail.outcome]?.label}{detail.status_code ? ` (${detail.status_code})` : ''}</dd></div>
                {detail.entity_type && <div><dt className="text-slate-500">Entidade</dt><dd className="text-slate-200">{detail.entity_type}</dd></div>}
                {detail.entity_label && <div><dt className="text-slate-500">Documento</dt><dd className="font-mono text-slate-200">{detail.entity_label}</dd></div>}
                {detail.method && <div><dt className="text-slate-500">Pedido</dt><dd className="font-mono text-[11px] text-slate-200">{detail.method} {detail.path}</dd></div>}
                {detail.ip && <div><dt className="text-slate-500">Origem</dt><dd className="font-mono text-slate-200">{detail.ip}</dd></div>}
                {detail.duration_ms !== undefined && <div><dt className="text-slate-500">Duração</dt><dd className="text-slate-200">{detail.duration_ms} ms</dd></div>}
                {detail.request_id && <div className="col-span-2"><dt className="text-slate-500">Correlação</dt><dd className="font-mono text-[10px] text-slate-400">{detail.request_id}</dd></div>}
              </dl>

              {Object.keys(detail.metadata ?? {}).length > 0 && (
                <div>
                  <p className="text-[0.6rem] font-bold uppercase tracking-[0.1em] text-slate-500 mb-1.5">Contexto</p>
                  <pre className="rounded-xl bg-surface-elevated p-3 text-[11px] text-slate-300 overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(detail.metadata, null, 2)}
                  </pre>
                </div>
              )}

              <div className="border-t border-white/[0.06] pt-3">
                <p className="text-[0.6rem] font-bold uppercase tracking-[0.1em] text-slate-500 mb-1.5">Assinatura</p>
                <p className="font-mono text-[10px] text-slate-500 break-all">{detail.hash}</p>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  Encadeado no evento anterior desta empresa. Alterar ou apagar qualquer linha parte a
                  cadeia e a verificação de integridade denuncia.
                </p>
              </div>

              <div className="flex justify-end">
                <Button variant="secondary" size="sm" onClick={() => setDetail(null)}>Fechar</Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
