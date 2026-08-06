'use client';

/**
 * @file page.tsx
 * @description Consola de suporte do agente — fila de conversas + atendimento.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9
 *
 * Polling curto (o resto do sistema também usa polling): a fila e a conversa
 * aberta são atualizadas periodicamente. Contexto do pedido pré-carregado.
 * Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { adminApi, type SupportThread, type SupportStats, type SupportThreadStatus } from '@/services/api';
import { Button, Card, PageHeader, StatCard } from '@/components/ui';

const LIST_POLL_MS = 8000;
const THREAD_POLL_MS = 4000;

type Filter = 'open' | 'resolved' | 'all';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-MZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function StatusBadge({ status }: { status: SupportThreadStatus }) {
  return status === 'resolved'
    ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400">Resolvida</span>
    : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Aberta</span>;
}

export default function SuportePage() {
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportThread | null>(null);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      setError('');
      const status = filter === 'all' ? undefined : filter;
      const [list, s] = await Promise.all([
        adminApi.getSupportThreads(status),
        adminApi.getSupportStats().catch(() => null),
      ]);
      setThreads(list);
      setStats(s);
    } catch {
      setError('Não foi possível carregar as conversas. Confirme que o backend está a correr.');
      setThreads([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    void loadList();
    const t = setInterval(() => void loadList(), LIST_POLL_MS);
    return () => clearInterval(t);
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await adminApi.getSupportThread(id));
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    void loadDetail(selectedId);
    const t = setInterval(() => void loadDetail(selectedId), THREAD_POLL_MS);
    return () => clearInterval(t);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages?.length]);

  const reply = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    if (!selectedId || !composer.trim()) return;
    setSending(true);
    try {
      const updated = await adminApi.replySupportThread(selectedId, composer.trim());
      setDetail(updated);
      setComposer('');
      void loadList();
    } catch {
      setError('Falha ao enviar a resposta.');
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: SupportThreadStatus) => {
    if (!selectedId) return;
    try {
      const updated = await adminApi.updateSupportThread(selectedId, { status });
      setDetail(updated);
      void loadList();
    } catch {
      setError('Falha ao atualizar a conversa.');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Suporte" description="Fila de conversas dos clientes e atendimento humano." />

      <div className="stats-grid">
        <StatCard label="Conversas abertas" value={stats?.open ?? '—'} helper="A aguardar atendimento" />
        <StatCard label="Resolvidas" value={stats?.resolved ?? '—'} helper="Encerradas pela equipa" />
        <StatCard label="Total" value={stats?.total ?? '—'} helper="Histórico completo" />
      </div>

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => loadList()}>Tentar Novamente</Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6 items-start">
        {/* ── Fila ── */}
        <Card className="p-0 overflow-hidden">
          <div className="flex rounded-none border-b border-white/[0.06]">
            {(['open', 'resolved', 'all'] as Filter[]).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`flex-1 h-10 text-xs font-semibold transition-colors ${filter === f ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-slate-400 hover:text-slate-200'}`}>
                {f === 'open' ? 'Abertas' : f === 'resolved' ? 'Resolvidas' : 'Todas'}
              </button>
            ))}
          </div>
          <div className="max-h-[560px] overflow-y-auto divide-y divide-white/[0.04]">
            {loading ? (
              <p className="p-6 text-center text-slate-500 text-xs">A carregar...</p>
            ) : threads.length === 0 ? (
              <p className="p-6 text-center text-slate-500 text-xs">Nenhuma conversa nesta lista.</p>
            ) : (
              threads.map((t) => {
                const active = t.id === selectedId;
                return (
                  <button key={t.id} onClick={() => setSelectedId(t.id)}
                    className={`w-full text-left px-4 py-3 flex flex-col gap-1 transition-colors ${active ? 'bg-brand-500/[0.12]' : 'hover:bg-surface-elevated'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-200 truncate">{t.client_name}</span>
                      <StatusBadge status={t.status} />
                    </div>
                    <span className="text-[11px] text-slate-400 truncate">{t.subject}</span>
                    {t.last_message_preview && (
                      <span className="text-[11px] text-slate-500 truncate">{t.last_message_preview}</span>
                    )}
                    <span className="text-[10px] text-slate-600">{formatTime(t.last_message_at)}{t.tracking_code ? ` · ${t.tracking_code}` : ''}</span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* ── Conversa ── */}
        <Card className="p-0 overflow-hidden flex flex-col min-h-[420px]">
          {!detail ? (
            <div className="flex-1 flex items-center justify-center p-12 text-center text-slate-500 text-sm">
              Selecione uma conversa na fila para começar.
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-white/[0.06] bg-surface-elevated/40">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-slate-100 truncate">{detail.subject}</h2>
                  <p className="text-[11px] text-slate-500 truncate">
                    {detail.client_name}{detail.client_email ? ` · ${detail.client_email}` : ''}
                  </p>
                  {detail.order && (
                    <p className="text-[11px] text-slate-500 truncate mt-0.5">
                      Pedido {detail.tracking_code} · estado {detail.order.current_status}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={detail.status} />
                  {detail.status === 'open' ? (
                    <Button size="sm" variant="secondary" onClick={() => setStatus('resolved')}>Resolver</Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setStatus('open')}>Reabrir</Button>
                  )}
                </div>
              </div>

              <div className="flex-1 flex flex-col gap-3 p-5 max-h-[440px] overflow-y-auto">
                {(detail.messages ?? []).map((m) => {
                  const isAgent = m.sender === 'agent';
                  return (
                    <div key={m.id} className={`flex flex-col max-w-[78%] ${isAgent ? 'self-end items-end' : 'self-start items-start'}`}>
                      <div className={`px-3.5 py-2 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap break-words ${isAgent ? 'bg-brand-600 text-white rounded-br-sm' : 'bg-surface-elevated text-slate-200 rounded-bl-sm border border-white/[0.06]'}`}>
                        {m.body}
                      </div>
                      <span className="text-[10px] text-slate-500 mt-1 px-1">
                        {isAgent ? 'Suporte' : m.sender_name} · {formatTime(m.created_at)}
                      </span>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              <form onSubmit={reply} className="flex items-end gap-2 p-3 border-t border-white/[0.06] bg-surface-elevated/30">
                <textarea rows={1} placeholder="Escreva a sua resposta..."
                  className="input flex-1 resize-none text-xs min-h-[40px]"
                  value={composer} onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void reply(); } }} />
                <Button type="submit" variant="primary" loading={sending} disabled={!composer.trim()}>Responder</Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
