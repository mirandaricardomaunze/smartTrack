'use client';

import { useEffect, useState } from 'react';
import { Button, Card, PageHeader, Pagination, paginationMeta } from '@/components/ui';
import { countPendingEvents, getCachedOrders, type CachedOrder } from '@/lib/offline/db';
import { processSyncQueue } from '@/lib/offline/sync';
import { authenticatedDriverId } from '@/services/api';

export default function HistoricoPage() {
  const [history, setHistory] = useState<CachedOrder[]>([]);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 10;

  async function load() {
    try {
      const [cached, count] = await Promise.all([getCachedOrders(), countPendingEvents()]);
      setHistory(cached.filter((order) => order.status === 'entregue' || order.status === 'insucesso').sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      setPending(count);
    } catch { setError('Não foi possível ler o histórico guardado neste dispositivo.'); }
  }

  useEffect(() => {
    setOnline(navigator.onLine); void load();
    const onOnline = () => { setOnline(true); void load(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  async function sync() {
    const driverId = authenticatedDriverId();
    if (!driverId) { setError('Sessão do motorista não encontrada.'); return; }
    setSyncing(true); setError('');
    const result = await processSyncQueue(driverId);
    if (!result.success) setError(result.error ?? 'Falha ao sincronizar.');
    await load(); setSyncing(false);
  }

  const delivered = history.filter((order) => order.status === 'entregue').length;
  const failed = history.length - delivered;
  const meta = paginationMeta(history.length, page, pageSize);
  const visible = history.slice((meta.currentPage - 1) * pageSize, meta.currentPage * pageSize);

  return <div className="flex flex-col gap-5 py-2">
    <PageHeader title="Histórico de entregas" description={online ? 'Atividades confirmadas e guardadas no dispositivo' : 'Histórico disponível offline'} />
    <div className="grid grid-cols-3 gap-3">
      {[['Total', history.length, 'text-slate-100'], ['Entregues', delivered, 'text-emerald-400'], ['Insucessos', failed, 'text-red-400']].map(([label, value, color]) => <Card key={String(label)} className="p-3 text-center"><span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</span><strong className={`mt-1 block text-lg ${color}`}>{value}</strong></Card>)}
    </div>
    {pending > 0 && <Card className="flex items-center justify-between gap-3 border-brand-500/20"><p className="text-xs text-slate-300">{pending} evento(s) pendente(s)</p><Button size="sm" variant="primary" onClick={sync} loading={syncing} disabled={!online}>Sincronizar</Button></Card>}
    {error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{error}</p>}
    {visible.length === 0 ? <Card className="py-10 text-center text-sm text-slate-500">Ainda não há entregas finalizadas neste dispositivo.</Card> : <div className="flex flex-col gap-3">{visible.map((order) => <Card key={order.id} className="flex items-start justify-between gap-3"><div><span className="font-mono text-xs font-bold text-brand-400">{order.codigoRastreio}</span><h2 className="mt-1 text-sm font-bold text-slate-200">{order.cliente}</h2><p className="mt-1 text-xs text-slate-500">{new Date(order.updated_at).toLocaleString('pt-MZ')}</p></div><span className={`badge ${order.status === 'entregue' ? 'badge-success' : 'badge-error'}`}>{order.status === 'entregue' ? 'Entregue' : 'Insucesso'}</span></Card>)}</div>}
    <Pagination page={meta.currentPage} pageSize={pageSize} totalItems={history.length} onPageChange={setPage} itemLabel="entregas" />
  </div>;
}
