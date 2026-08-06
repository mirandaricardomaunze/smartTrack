'use client';

import { useEffect, useMemo, useState } from 'react';
import { adminApi, type BackendDriver, type HistoricoItem, type Pedido } from '@/services/api';
import { Button, Card, DataTable, Input, PageHeader, Pagination, Select, StatCard, paginationMeta, type DataTableColumn } from '@/components/ui';

const STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  created:              { label: 'Criado',             badgeClass: 'badge-brand' },
  collected:            { label: 'Coletado',           badgeClass: 'badge-info' },
  in_transit:           { label: 'Em Trânsito',        badgeClass: 'badge-info' },
  at_warehouse:         { label: 'No Armazém',         badgeClass: 'badge-warning' },
  awaiting_destination: { label: 'Aguardando Destino', badgeClass: 'badge-warning' },
  out_for_delivery:     { label: 'Saiu para Entrega',  badgeClass: 'badge-warning' },
  delivered:            { label: 'Entregue',           badgeClass: 'badge-success' },
  failed:               { label: 'Insucesso',          badgeClass: 'badge-error' },
  cancelled:            { label: 'Cancelado',          badgeClass: 'badge-neutral' },
};

const ORIGIN_LABELS: Record<string, { label: string; className: string }> = {
  DRIVER:       { label: 'Motorista',      className: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  ADMIN:        { label: 'Administração',  className: 'bg-brand-500/10 text-brand-300 border-brand-500/20' },
  CARRIER_INTL: { label: 'Transportadora', className: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' },
  SYSTEM:       { label: 'Sistema',        className: 'bg-slate-500/10 text-slate-400 border-white/10' },
};

interface Movement {
  event: HistoricoItem;
  order: Pedido;
  origin: string;
  occurredAt: string;
}

function eventLocation(location: HistoricoItem['location']): string {
  if (!location) return 'Localização não informada';
  if (typeof location === 'string') {
    const translations: Record<string, string> = {
      'In transit': 'Em trânsito',
      'International Origin': 'Origem internacional',
      'National Sorting Center': 'Centro de triagem nacional',
    };
    return translations[location] ?? location;
  }
  const accuracy = location.accuracy_meters != null ? ` · ±${Math.round(location.accuracy_meters)} m` : '';
  return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}${accuracy}`;
}

function eventDescription(event: HistoricoItem): string {
  const translations: Record<string, string> = {
    'Order registered in the national system': 'Encomenda registada no sistema nacional.',
    'International order registered — awaiting processing': 'Encomenda internacional registada e aguardando processamento.',
    'Updated via driver app': 'Estado atualizado pelo aplicativo do motorista.',
    'Package collected at sender': 'Encomenda recolhida no remetente.',
    'Transferring between hubs': 'Em transferência entre centros logísticos.',
    'Out for delivery to recipient': 'Saiu para entrega ao destinatário.',
    'Delivered successfully': 'Encomenda entregue com sucesso.',
  };
  if (!event.description) return `Estado atualizado para ${STATUS_LABELS[event.status]?.label ?? event.status}.`;
  return translations[event.description] ?? event.description;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value, time: '' };
  return {
    date: date.toLocaleDateString('pt-MZ', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: date.toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}

export default function MovimentosPage() {
  const [orders, setOrders] = useState<Pedido[]>([]);
  const [drivers, setDrivers] = useState<BackendDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [ordersData, driversData] = await Promise.all([
        adminApi.getPedidos(),
        adminApi.getMotoristas(),
      ]);
      setOrders(ordersData);
      setDrivers(driversData);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Não foi possível carregar os movimentos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  const movements = useMemo<Movement[]>(() => orders.flatMap((order) =>
    (order.history ?? []).map((event) => ({
      event,
      order,
      origin: event.event_origin ?? (event.user_id ? 'DRIVER' : 'SYSTEM'),
      occurredAt: event.device_timestamp ?? event.timestamp,
    })),
  ).sort((a, b) => {
    const aTime = Date.parse(a.occurredAt);
    const bTime = Date.parse(b.occurredAt);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  }), [orders]);

  const driverName = (movement: Movement) => {
    const actorId = movement.event.user_id
      ?? (movement.origin === 'DRIVER' ? movement.order.driver : undefined);
    if (!actorId) return movement.origin === 'ADMIN' ? 'Operador autenticado' : '—';
    return drivers.find((driver) => driver.id === actorId)?.name ?? 'Utilizador não encontrado';
  };

  const filtered = movements.filter((movement) => {
    const query = search.trim().toLowerCase();
    const haystack = [
      movement.order.trackingCode,
      movement.order.client,
      eventDescription(movement.event),
      eventLocation(movement.event.location),
      driverName(movement),
    ].join(' ').toLowerCase();
    return (!query || haystack.includes(query))
      && (status === 'all' || movement.event.status === status)
      && (origin === 'all' || movement.origin === origin);
  });

  const today = new Date().toDateString();
  const todayCount = movements.filter((movement) => new Date(movement.occurredAt).toDateString() === today).length;
  const driverCount = movements.filter((movement) => movement.origin === 'DRIVER').length;
  const warehouseCount = movements.filter((movement) => ['at_warehouse', 'awaiting_destination'].includes(movement.event.status)).length;
  const movementPageMeta = paginationMeta(filtered.length, page, pageSize);
  const visible = filtered.slice((movementPageMeta.currentPage - 1) * pageSize, movementPageMeta.currentPage * pageSize);

  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value);
    setPage(1);
  };

  const columns: DataTableColumn<Movement>[] = [
    { key: 'date', header: 'Data e hora', headerClassName: 'w-[145px]', cell: (movement) => { const date = formatTimestamp(movement.occurredAt); return <><p className="whitespace-nowrap text-xs font-semibold text-slate-300">{date.date}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{date.time}</p></>; } },
    { key: 'order', header: 'Encomenda', headerClassName: 'w-[165px]', cell: (movement) => <><p className="whitespace-nowrap font-mono text-xs font-semibold text-brand-400">{movement.order.trackingCode}</p><p className="mt-1 max-w-[150px] truncate text-[10px] text-slate-500">{movement.order.client}</p></> },
    { key: 'movement', header: 'Movimento', headerClassName: 'min-w-[280px]', cell: (movement) => { const meta=STATUS_LABELS[movement.event.status]??{label:movement.event.status,badgeClass:'badge-neutral'}; return <><span className={`badge ${meta.badgeClass} text-[9px]`}>{meta.label}</span><p className="mt-2 text-xs leading-relaxed text-slate-300">{eventDescription(movement.event)}</p>{movement.event.device_timestamp&&movement.event.device_timestamp!==movement.event.timestamp&&<span className="mt-1 block text-[9px] text-amber-400">Sincronizado posteriormente</span>}</>; } },
    { key: 'location', header: 'Localização', headerClassName: 'min-w-[190px]', cellClassName: 'text-xs text-slate-400', cell: (movement) => eventLocation(movement.event.location) },
    { key: 'origin', header: 'Origem', headerClassName: 'w-[145px]', cell: (movement) => { const meta=ORIGIN_LABELS[movement.origin]??ORIGIN_LABELS.SYSTEM; return <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${meta.className}`}>{meta.label}</span>; } },
    { key: 'actor', header: 'Responsável', headerClassName: 'min-w-[175px]', cell: (movement) => <><p className="text-xs text-slate-300">{driverName(movement)}</p>{movement.event.device_id&&<p className="mt-1 font-mono text-[9px] text-slate-600" title={movement.event.device_id}>Dispositivo {movement.event.device_id.slice(-8)}</p>}</> },
    { key: 'audit', header: 'Auditoria', headerClassName: 'w-[130px]', cell: (movement) => movement.event.hash?<span className="font-mono text-[10px] text-slate-500" title={movement.event.hash}>{movement.event.hash.slice(0,10)}…</span>:<span className="text-[10px] text-slate-600">Legado</span> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Todos os Movimentos" description="Auditoria cronológica de todas as encomendas e origens de evento." actions={<Button onClick={() => void loadData()} loading={loading} variant="secondary" leftIcon={
          <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>}>Atualizar</Button>} />

      <div className="stats-grid">
        <StatCard label="Total de Movimentos" value={movements.length} helper={<span className="text-xs text-slate-500">Histórico consolidado</span>} />
        <StatCard label="Hoje" value={todayCount} helper={<span className="text-xs text-slate-500">Eventos registados hoje</span>} />
        <StatCard label="Via Motorista" value={driverCount} helper={<span className="text-xs text-slate-500">Online e sincronização offline</span>} />
        <StatCard label="Movimentos de Armazém" value={warehouseCount} helper={<span className="text-xs text-slate-500">Receções e espera de destino</span>} />
      </div>

      {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-xs text-red-400">{error}</div>}

      <Card className="grid grid-cols-1 items-end gap-3 md:grid-cols-[minmax(260px,1fr)_200px_190px]">
        <Input label="Pesquisar movimentos" value={search} onChange={(event) => updateFilter(setSearch,event.target.value)} placeholder="Código, cliente, localização ou responsável..." />
        <Select label="Estado" value={status} onChange={(event)=>updateFilter(setStatus,event.target.value)} options={[{value:'all',label:'Todos os estados'},...Object.entries(STATUS_LABELS).map(([value,meta])=>({value,label:meta.label}))]} />
        <Select label="Origem" value={origin} onChange={(event)=>updateFilter(setOrigin,event.target.value)} options={[{value:'all',label:'Todas as origens'},...Object.entries(ORIGIN_LABELS).map(([value,meta])=>({value,label:meta.label}))]} />
      </Card>

      <DataTable
        data={visible}
        columns={columns}
        getRowKey={(movement) => movement.event.id ?? movement.event.hash ?? `${movement.order.id}-${movement.event.timestamp}`}
        loading={loading}
        loadingLabel="A carregar movimentos..."
        emptyTitle="Nenhum movimento encontrado"
        emptyDescription="Ajuste os filtros para consultar outros eventos."
        tableClassName="min-w-[1240px]"
        footer={
          <Pagination
            page={movementPageMeta.currentPage}
            pageSize={pageSize}
            totalItems={filtered.length}
            itemLabel="movimentos"
            onPageChange={setPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            }}
          />
        }
      />
    </div>
  );
}
