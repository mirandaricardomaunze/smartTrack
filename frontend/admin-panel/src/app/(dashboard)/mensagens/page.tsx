'use client';

/**
 * @file page.tsx
 * @description Mensagens ao cliente (SMS/email) — log de envios e estado do provedor.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * Sem emojis — apenas SVG.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type OutboundMessage,
  type MessagingStats,
  type MessagingProvider,
} from '@/services/api';
import { Button, PageHeader, StatCard } from '@/components/ui';

function trackingDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('pt-MZ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const STATUS_META: Record<string, { label: string; badge: string }> = {
  sent:      { label: 'Enviado',   badge: 'badge-success' },
  simulated: { label: 'Simulado',  badge: 'badge-warning' },
  failed:    { label: 'Falhou',    badge: 'badge-error' },
};

export default function MensagensPage() {
  const [messages, setMessages] = useState<OutboundMessage[]>([]);
  const [stats, setStats] = useState<MessagingStats | null>(null);
  const [provider, setProvider] = useState<MessagingProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [msgs, statsData, prov] = await Promise.all([
        adminApi.getOutboundMessages(200),
        adminApi.getMessagingStats().catch(() => null),
        adminApi.getMessagingProvider().catch(() => null),
      ]);
      setMessages(msgs);
      setStats(statsData);
      setProvider(prov);
    } catch {
      setError('Não foi possível carregar as mensagens. Confirme que o backend está a correr.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const anySimulated = provider ? (provider.sms.simulated || provider.email.simulated) : false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Mensagens ao Cliente"
        description="SMS e email enviados (ex.: aviso de entrada no armazém)."
        actions={<Button variant="secondary" onClick={loadData}>Atualizar</Button>}
      />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={loadData}>Tentar Novamente</Button>
        </div>
      )}

      {anySimulated && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 p-4 rounded-2xl text-xs flex items-start gap-2">
          <svg className="w-4 h-4 shrink-0 mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span>
            Provedor <strong>não configurado</strong> para {provider?.sms.simulated && provider?.email.simulated ? 'SMS e email' : provider?.sms.simulated ? 'SMS' : 'email'}:
            a usar simulador (os envios ficam registados como <span className="font-mono">simulado</span>, sem sair para o cliente). Defina{' '}
            <span className="font-mono text-amber-200">SMS_API_URL/SMS_API_KEY</span> e{' '}
            <span className="font-mono text-amber-200">EMAIL_API_URL/EMAIL_API_KEY</span> para envio real.
          </span>
        </div>
      )}

      <div className="stats-grid">
        <StatCard label="SMS" value={stats ? stats.sms : messages.filter((m) => m.channel === 'sms').length} helper="Registados" />
        <StatCard label="Email" value={stats ? stats.email : messages.filter((m) => m.channel === 'email').length} helper="Registados" />
        <StatCard label="Enviados (real)" value={stats ? stats.sent : messages.filter((m) => m.status === 'sent').length} helper="Provedor real" />
        <StatCard label="Falhados" value={stats ? stats.failed : messages.filter((m) => m.status === 'failed').length} helper="Recusados/erro" />
      </div>

      <div className="table-wrapper">
        <table className="data-table min-w-[820px]">
          <thead>
            <tr>
              <th className="w-[80px]">Canal</th>
              <th className="min-w-[180px]">Destinatário</th>
              <th className="min-w-[240px]">Mensagem</th>
              <th className="w-[110px]">Estado</th>
              <th className="w-[140px]">Código</th>
              <th className="w-[130px]">Quando</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-8 text-slate-500">A carregar...</td></tr>
            ) : messages.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-slate-500">Nenhuma mensagem enviada ainda.</td></tr>
            ) : (
              messages.map((m) => {
                const meta = STATUS_META[m.status] ?? { label: m.status, badge: 'badge-neutral' };
                return (
                  <tr key={m.id}>
                    <td><span className={`badge ${m.channel === 'sms' ? 'badge-info' : 'badge-brand'}`}>{m.channel === 'sms' ? 'SMS' : 'Email'}</span></td>
                    <td className="font-mono text-xs">{m.recipient}</td>
                    <td className="text-xs text-slate-300">
                      {m.subject && <span className="block font-semibold text-slate-200">{m.subject}</span>}
                      <span className="line-clamp-2">{m.body}</span>
                      {m.error && <span className="block text-[10px] text-red-400 mt-0.5">{m.error}</span>}
                    </td>
                    <td><span className={`badge ${meta.badge}`}>{meta.label}</span></td>
                    <td className="font-mono text-xs text-brand-400">{m.tracking_code ?? '—'}</td>
                    <td className="text-xs whitespace-nowrap text-slate-400">{trackingDate(m.created_at)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
