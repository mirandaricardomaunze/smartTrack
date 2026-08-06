'use client';

import { useEffect, useMemo, useState } from 'react';
import { adminApi, type BackendNotification, type NotificationStatus } from '@/services/api';
import { Button, Card, Input, PageHeader, Pagination, Select, StatCard, paginationMeta } from '@/components/ui';

const STATUS_META: Record<NotificationStatus, { label: string; className: string; dot: string }> = {
  sent:       { label: 'Enviada',   className: 'badge-success', dot: 'bg-emerald-400' },
  pending:    { label: 'Pendente',  className: 'badge-warning', dot: 'bg-amber-400' },
  failed:     { label: 'Falhou',    className: 'badge-error',   dot: 'bg-red-400' },
  suppressed: { label: 'Suprimida', className: 'badge-neutral', dot: 'bg-slate-500' },
};

const CATEGORY_LABELS: Record<BackendNotification['category'], string> = {
  ORDER_STATUS:        'Estado da encomenda',
  DESTINATION_REQUEST: 'Confirmação de destino',
  PAYMENT:             'Pagamento',
  ROUTE_ASSIGNED:      'Rota atribuída',
  DELIVERY_ISSUE:      'Ocorrência na entrega',
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-MZ', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function IconBell() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export default function NotificacoesPage() {
  const [notifications, setNotifications] = useState<BackendNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | NotificationStatus>('all');
  const [category, setCategory] = useState<'all' | BackendNotification['category']>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const loadNotifications = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await adminApi.getNotifications();
      setNotifications([...data].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
    } catch (err) {
      setError(err instanceof Error && err.message
        ? err.message
        : 'Não foi possível carregar as notificações.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadNotifications(); }, []);

  const filtered = useMemo(() => notifications.filter((notification) => {
    const query = search.trim().toLowerCase();
    const haystack = [
      notification.title,
      notification.body,
      notification.user_id,
      notification.role,
      CATEGORY_LABELS[notification.category],
    ].join(' ').toLowerCase();

    return (!query || haystack.includes(query))
      && (status === 'all' || notification.status === status)
      && (category === 'all' || notification.category === category);
  }), [category, notifications, search, status]);

  const sent = notifications.filter((item) => item.status === 'sent').length;
  const failed = notifications.filter((item) => item.status === 'failed').length;
  const pending = notifications.filter((item) => item.status === 'pending').length;
  const pageMeta = paginationMeta(filtered.length, page, pageSize);
  const visible = filtered.slice((pageMeta.currentPage - 1) * pageSize, pageMeta.currentPage * pageSize);

  const resetPage = () => setPage(1);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Todas as Notificações"
        description="Histórico de alertas e comunicações enviados aos utilizadores."
        actions={<Button onClick={() => void loadNotifications()} loading={loading} leftIcon={
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8 8 0 0 0 4.582 9M4 9h5m11 11v-5h-.581a8 8 0 0 1-15.357-2M20 15h-5" />
          </svg>
        }>Atualizar</Button>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Total', value: notifications.length, tone: 'text-slate-100' },
          { label: 'Enviadas', value: sent, tone: 'text-emerald-400' },
          { label: 'Pendentes', value: pending, tone: 'text-amber-400' },
          { label: 'Com falha', value: failed, tone: 'text-red-400' },
        ].map((item) => (
          <StatCard key={item.label} label={item.label} value={<span className={item.tone}>{item.value}</span>} />
        ))}
      </div>

      <Card className="grid gap-3 md:grid-cols-[minmax(240px,1fr)_220px_220px]">
        <Input
          aria-label="Pesquisar notificações"
          value={search}
          onChange={(event) => { setSearch(event.target.value); resetPage(); }}
          placeholder="Pesquisar por título, destinatário..."
          leftIcon={<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>}
        />
        <Select
          value={status}
          onChange={(event) => { setStatus(event.target.value as 'all' | NotificationStatus); resetPage(); }}
          aria-label="Filtrar por estado"
          options={[{ value: 'all', label: 'Todos os estados' }, ...Object.entries(STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))]}
        />
        <Select
          value={category}
          onChange={(event) => { setCategory(event.target.value as 'all' | BackendNotification['category']); resetPage(); }}
          aria-label="Filtrar por categoria"
          options={[{ value: 'all', label: 'Todas as categorias' }, ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))]}
        />
      </Card>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <p className="font-semibold">Não foi possível carregar o histórico.</p>
          <p className="mt-1 text-xs text-red-300/80">{error}</p>
        </div>
      )}

      {!error && !loading && filtered.length === 0 && (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-surface-elevated p-8 text-center">
          <div className="mb-3 rounded-full bg-surface-overlay p-3 text-slate-500"><IconBell /></div>
          <p className="text-sm font-semibold text-slate-300">
            {notifications.length === 0 ? 'Ainda não existem notificações' : 'Nenhuma notificação encontrada'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {notifications.length === 0
              ? 'Os próximos alertas enviados aparecerão aqui.'
              : 'Ajuste os filtros ou a pesquisa para ver outros resultados.'}
          </p>
        </div>
      )}

      {loading && (
        <div className="flex min-h-48 items-center justify-center rounded-xl border border-white/[0.06] bg-surface-elevated">
          <span className="text-sm text-slate-500">A carregar notificações...</span>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-surface-elevated">
          <div className="border-b border-white/[0.06] px-4 py-3 text-xs text-slate-500">
            {filtered.length} {filtered.length === 1 ? 'notificação' : 'notificações'}
          </div>
          <div className="divide-y divide-white/[0.06]">
            {visible.map((notification) => {
              const meta = STATUS_META[notification.status];
              return (
                <article key={notification.id} className="flex gap-4 p-4 transition-colors hover:bg-white/[0.02] sm:p-5">
                  <span className={`mt-2 h-2.5 w-2.5 flex-none rounded-full ${meta.dot}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-200">{notification.title}</h3>
                        <p className="mt-1 text-sm leading-6 text-slate-400">{notification.body}</p>
                      </div>
                      <span className={`badge ${meta.className} self-start`}>{meta.label}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>{CATEGORY_LABELS[notification.category]}</span>
                      <span>Perfil: {notification.role}</span>
                      <span>Destinatário: {notification.user_id}</span>
                      <time dateTime={notification.created_at}>{formatDate(notification.created_at)}</time>
                      {notification.status === 'sent' && (
                        <span>{notification.delivered_count} {notification.delivered_count === 1 ? 'dispositivo' : 'dispositivos'}</span>
                      )}
                    </div>
                    {notification.failure_reason && (
                      <p className="mt-3 rounded-lg bg-black/10 px-3 py-2 text-xs text-slate-500">
                        Motivo: {notification.failure_reason}
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <Pagination
            page={pageMeta.currentPage}
            pageSize={pageSize}
            totalItems={filtered.length}
            itemLabel="notificações"
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => { setPageSize(nextPageSize); setPage(1); }}
          />
        </div>
      )}
    </div>
  );
}
