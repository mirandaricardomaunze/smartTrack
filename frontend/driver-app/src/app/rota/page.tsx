'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, PageHeader } from '@/components/ui';
import { cacheOrders, countPendingEvents, getCachedOrders, type CachedOrder } from '@/lib/offline/db';
import { processSyncQueue } from '@/lib/offline/sync';
import { authenticatedDriverId, driverApi, formatAddress, type DriverOrder, type DriverRoute } from '@/services/api';

type GpsStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable';

function localStatus(status: string): CachedOrder['status'] {
  const values: Record<string, CachedOrder['status']> = {
    collected: 'coletado', in_transit: 'em_transito', out_for_delivery: 'saiu_para_entrega', delivered: 'entregue', failed: 'insucesso',
  };
  return values[status] ?? 'em_transito';
}

function toCached(order: DriverOrder): CachedOrder {
  return {
    id: order.id,
    codigoRastreio: order.tracking_code,
    cliente: order.client,
    endereco: formatAddress(order.destination),
    status: localStatus(order.current_status),
    updated_at: order.updated_at,
    cod_amount: order.cod_amount,
  };
}

export default function RotaPage() {
  const router = useRouter();
  const [route, setRoute] = useState<DriverRoute | null>(null);
  const [orders, setOrders] = useState<Record<string, CachedOrder>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isOnline, setIsOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle');
  const watchId = useRef<number | null>(null);

  const load = useCallback(async () => {
    const driverId = authenticatedDriverId();
    if (!driverId) { router.replace('/login'); return; }
    setLoading(true); setError('');
    try {
      const pending = await countPendingEvents(); setQueueCount(pending);
      if (!navigator.onLine) {
        const cached = await getCachedOrders();
        setOrders(Object.fromEntries(cached.map((order) => [order.id, order])));
        setRoute(null);
        return;
      }
      const active = await driverApi.myRoute(); setRoute(active);
      if (!active) { setOrders({}); return; }
      const details = await Promise.all(active.stops.map((stop) => driverApi.order(stop.order_id)));
      const cached = details.map(toCached); await cacheOrders(cached);
      setOrders(Object.fromEntries(cached.map((order) => [order.id, order])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar a rota.');
      const cached = await getCachedOrders().catch(() => []);
      setOrders(Object.fromEntries(cached.map((order) => [order.id, order])));
    } finally { setLoading(false); }
  }, [router]);

  useEffect(() => {
    setIsOnline(navigator.onLine); void load();
    const online = () => {
      setIsOnline(true);
      const driverId = authenticatedDriverId();
      if (driverId) void processSyncQueue(driverId).then((result) => { setQueueCount(result.remainingCount); return load(); });
      else void load();
    };
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current); };
  }, [load]);

  function enableGps() {
    const driverId = authenticatedDriverId();
    if (!driverId || !navigator.geolocation) { setGpsStatus('unavailable'); return; }
    setGpsStatus('requesting');
    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        setGpsStatus('active');
        if (navigator.onLine) void driverApi.updateGps(driverId, {
          lat: position.coords.latitude, lng: position.coords.longitude,
          heading: position.coords.heading ?? 0, speed: position.coords.speed ?? 0,
        }).catch(() => setGpsStatus('unavailable'));
      },
      (failure) => setGpsStatus(failure.code === GeolocationPositionError.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
  }

  async function sync() {
    const driverId = authenticatedDriverId(); if (!driverId) return;
    setSyncing(true); const result = await processSyncQueue(driverId); setQueueCount(result.remainingCount); setSyncing(false);
    if (!result.success) setError(result.error ?? 'Falha ao sincronizar.'); else await load();
  }

  const stops = route?.stops ?? Object.values(orders).map((order, index) => ({ order_id: order.id, address: order.endereco, sequence: index + 1, status: order.status === 'entregue' ? 'delivered' as const : order.status === 'insucesso' ? 'failed' as const : 'pending' as const, lat: null, lng: null }));

  return <div className="flex flex-col gap-5 py-2">
    <PageHeader title="Minha rota" description={isOnline ? 'Dados atualizados pelo servidor' : 'Modo offline — dados guardados no dispositivo'} />
    <div className="grid grid-cols-2 gap-3">
      <div className={`flex min-h-10 items-center gap-2 rounded-xl border p-3 text-xs font-semibold ${isOnline ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/20 bg-amber-500/10 text-amber-400'}`}>{isOnline ? 'Online' : 'Offline'}</div>
      <Button size="sm" variant={gpsStatus === 'active' ? 'success' : 'secondary'} onClick={enableGps} disabled={gpsStatus === 'requesting' || gpsStatus === 'active'}>{gpsStatus === 'active' ? 'GPS ativo' : gpsStatus === 'requesting' ? 'A autorizar...' : 'Ativar GPS'}</Button>
    </div>
    {error && <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{error}</div>}
    {queueCount > 0 && <Card className="flex flex-col gap-3 border-brand-500/20 bg-brand-500/10"><p className="text-xs text-slate-300">{queueCount} evento(s) aguardam confirmação do servidor.</p><Button size="sm" variant="primary" fullWidth onClick={sync} loading={syncing} disabled={!isOnline}>Sincronizar agora</Button></Card>}
    {loading ? <Card className="py-10 text-center text-sm text-slate-500">A carregar rota...</Card> : stops.length === 0 ? <Card className="py-10 text-center text-sm text-slate-500">Nenhuma rota ativa atribuída.</Card> : <div className="flex flex-col gap-3">{stops.sort((a, b) => a.sequence - b.sequence).map((stop) => {
      const order = orders[stop.order_id];
      return <Card key={stop.order_id} className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3"><div><span className="font-mono text-xs font-bold text-brand-400">{order?.codigoRastreio ?? stop.order_id}</span><h2 className="mt-1 text-sm font-bold text-slate-200">{order?.cliente ?? 'Entrega atribuída'}</h2></div><span className={`badge ${stop.status === 'delivered' ? 'badge-success' : stop.status === 'failed' ? 'badge-error' : 'badge-info'}`}>{stop.status === 'delivered' ? 'Entregue' : stop.status === 'failed' ? 'Insucesso' : `Parada ${stop.sequence}`}</span></div>
        <p className="text-xs leading-relaxed text-slate-400">{order?.endereco ?? stop.address}</p>
        {stop.status === 'pending' && <a href={`/entrega/${encodeURIComponent(stop.order_id)}`} className="btn btn-primary btn-sm min-h-10 text-center">Abrir entrega</a>}
      </Card>;
    })}</div>}
  </div>;
}
