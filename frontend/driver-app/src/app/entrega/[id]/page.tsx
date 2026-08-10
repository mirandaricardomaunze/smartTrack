'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input, Select, Textarea } from '@/components/ui';
import { getCachedOrders, updateCachedOrderStatus } from '@/lib/offline/db';
import { queueFinalDelivery } from '@/lib/offline/sync';
import { compressPodImage } from '@/lib/image';
import { navigationUrl } from '@/lib/navigation';
import { authenticatedDriverId, driverApi, formatAddress, type DriverOrder } from '@/services/api';

const FAILURE_OPTIONS = [
  { value: 'RECIPIENT_ABSENT', label: 'Destinatário ausente' },
  { value: 'WRONG_ADDRESS', label: 'Endereço incorreto ou não localizado' },
  { value: 'REFUSED', label: 'Entrega recusada' },
  { value: 'OTHER', label: 'Outro motivo' },
];

// Nada de rejeitar a foto por ser grande: uma câmara de telemóvel produz 3-5 MB
// e o motorista ficaria sem conseguir fechar a entrega. Reduz-se antes de enviar.

export default function EntregaPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [order, setOrder] = useState<DriverOrder | null>(null);
  const [mode, setMode] = useState<'delivered' | 'failed'>('delivered');
  const [recipient, setRecipient] = useState('');
  const [signature, setSignature] = useState('');
  const [photo, setPhoto] = useState('');
  const [reason, setReason] = useState('RECIPIENT_ABSENT');
  const [notes, setNotes] = useState('');
  const [otp, setOtp] = useState('');
  const [codMethod, setCodMethod] = useState('CASH');
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(0);
  const [error, setError] = useState('');

  async function selectImage(file: File | undefined, apply: (value: string) => void) {
    if (!file) { apply(''); return; }
    setProcessing((n) => n + 1);
    try { apply(await compressPodImage(file)); setError(''); }
    catch (err) { apply(''); setError(err instanceof Error ? err.message : 'Imagem inválida.'); }
    finally { setProcessing((n) => n - 1); }
  }

  useEffect(() => {
    if (!authenticatedDriverId()) { router.replace('/login'); return; }
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true); const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    (async () => {
      try {
        if (navigator.onLine) setOrder(await driverApi.order(params.id));
        else {
          const cached = (await getCachedOrders()).find((item) => item.id === params.id);
          if (cached) setOrder({ id: cached.id, tracking_code: cached.codigoRastreio, client: cached.cliente, client_phone: null, destination: cached.endereco, current_status: cached.status, value: 0, cod_amount: cached.cod_amount ?? 0, updated_at: cached.updated_at });
          else setError('Esta entrega não está disponível no cache offline.');
        }
      } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível carregar a entrega.'); }
      finally { setLoading(false); }
    })();
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [params.id, router]);

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!order) return;
    if (mode === 'delivered' && (!recipient.trim() || !signature)) { setError('Nome de quem recebeu e assinatura são obrigatórios.'); return; }
    setSubmitting(true); setError('');
    try {
      const coords = await new Promise<{ lat: number; lng: number } | undefined>((resolve) => navigator.geolocation?.getCurrentPosition((position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), () => resolve(undefined), { timeout: 5000 }) ?? resolve(undefined));
      if (mode === 'delivered') {
        const command = { status: 'entregue' as const, recipient_name: recipient.trim(), signature, photo: photo || undefined, notes: notes || undefined, otp: otp || undefined, cod_method: order.cod_amount > 0 ? codMethod : undefined, ...coords };
        if (online) await driverApi.deliver(order.id, command);
        else await queueFinalDelivery(order.id, command);
        await updateCachedOrderStatus(order.id, 'entregue', notes);
      } else {
        const command = { status: 'insucesso' as const, reason, notes: notes || undefined, ...coords };
        if (online) await driverApi.failDelivery(order.id, command);
        else await queueFinalDelivery(order.id, command);
        await updateCachedOrderStatus(order.id, 'insucesso', notes, reason);
      }
      router.replace('/rota');
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível finalizar a entrega.'); }
    finally { setSubmitting(false); }
  }

  if (loading) return <Card className="py-10 text-center text-sm text-slate-500">A carregar entrega...</Card>;
  if (!order) return <Card className="py-10 text-center text-sm text-red-400">{error || 'Entrega não encontrada.'}</Card>;

  return <div className="flex flex-col gap-5 py-2">
    <div className="flex items-center justify-between"><Button size="sm" variant="ghost" onClick={() => router.back()}>← Voltar</Button><span className={`badge ${online ? 'badge-success' : 'badge-info'}`}>{online ? 'Online' : 'Offline'}</span></div>
    <Card className="flex flex-col gap-2"><span className="font-mono text-sm font-bold text-brand-400">{order.tracking_code}</span><h1 className="text-base font-bold text-slate-100">{order.client}</h1><p className="text-xs text-slate-400">{formatAddress(order.destination)}</p>{order.client_phone && <a className="text-xs font-semibold text-brand-400" href={`tel:${order.client_phone}`}>{order.client_phone}</a>}
      {navigationUrl(order.destination) && <a href={navigationUrl(order.destination) as string} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm mt-1 min-h-10 text-center">Navegar até à morada</a>}</Card>
    {error && <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">{error}</p>}
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2"><Button variant={mode === 'delivered' ? 'success' : 'secondary'} onClick={() => setMode('delivered')}>Entregue</Button><Button variant={mode === 'failed' ? 'danger' : 'secondary'} onClick={() => setMode('failed')}>Insucesso</Button></div>
      {mode === 'delivered' ? <>
        <Input label="Nome de quem recebeu" value={recipient} onChange={(event) => setRecipient(event.target.value)} required />
        <Input label="Assinatura (imagem)" type="file" accept="image/png,image/jpeg" onChange={(event) => void selectImage(event.target.files?.[0], setSignature)} required />
        <Input label="Foto da entrega (opcional)" type="file" accept="image/png,image/jpeg" onChange={(event) => void selectImage(event.target.files?.[0], setPhoto)} />
        <Input label="Código OTP (quando solicitado)" inputMode="numeric" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value)} />
        {order.cod_amount > 0 && <Select label="Método de cobrança" value={codMethod} onChange={(event) => setCodMethod(event.target.value)} options={[{ value: 'CASH', label: 'Numerário' }, { value: 'MPESA', label: 'M-Pesa' }, { value: 'EMOLA', label: 'e-Mola' }, { value: 'MKESH', label: 'mKesh' }]} />}
      </> : <Select label="Motivo do insucesso" value={reason} onChange={(event) => setReason(event.target.value)} options={FAILURE_OPTIONS} />}
      <Textarea label="Observações" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
      {processing > 0 && <p role="status" className="rounded-xl border border-brand-500/20 bg-brand-500/10 p-3 text-xs text-brand-300">A preparar a imagem para envio...</p>}
      {!online && <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">O comprovativo será guardado neste dispositivo e enviado quando a ligação regressar.</p>}
      <Button type="submit" fullWidth variant={mode === 'delivered' ? 'primary' : 'danger'} loading={submitting} disabled={processing > 0}>{mode === 'delivered' ? 'Confirmar entrega' : 'Registar insucesso'}</Button>
    </form>
  </div>;
}
