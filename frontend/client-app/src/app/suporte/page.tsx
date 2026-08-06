'use client';

/**
 * @file page.tsx (cliente)
 * @description Central de Suporte — FAQ + chat em tempo real com o suporte humano.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9
 *
 * O cliente abre uma conversa sem login; o backend devolve um token de acesso que
 * guardamos em localStorage para retomar a conversa e fazer polling das respostas.
 * Sem emojis — apenas SVG/CSS (regra do projeto).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button, Input, Select, Textarea, Card } from '@/components/ui';
import {
  openSupportThread,
  getSupportThread,
  replySupportThread,
  type SupportThread,
} from '@/services/api';

const STORAGE_KEY = 'suporte_conversa';
const POLL_MS = 4000;

interface FaqItem { question: string; answer: string }

const FAQS: FaqItem[] = [
  { question: 'Como rastrear minha encomenda?', answer: 'Basta utilizar a página "Rastrear" no menu superior e inserir o seu código de rastreamento (ex: TRK00000001BR ou LX987654321CN). O sistema exibe todas as movimentações em tempo real.' },
  { question: 'O que significa o status "Aguardando Destino"?', answer: 'Este status indica que a encomenda chegou ao armazém central ou hub de triagem e aguarda a confirmação/definição do endereço final de entrega para calcular a rota do motorista.' },
  { question: 'O que fazer em caso de insucesso na entrega?', answer: 'Caso o motorista não encontre o destinatário ou o local esteja fechado, uma nova tentativa será agendada automaticamente para o dia útil seguinte. Você também pode entrar em contato conosco fornecendo o código.' },
  { question: 'Como alterar o endereço de entrega?', answer: 'Caso o pedido ainda esteja nos status "Criado" ou "No Armazém", inicie uma conversa abaixo com o código do pedido e o novo endereço completo.' },
  { question: 'Quais os prazos para encomendas internacionais?', answer: 'Encomendas vindas da China (Cainiao/17TRACK) passam por desembaraço aduaneiro antes de dar entrada na rede logística nacional. O prazo médio de entrega após liberação é de 3 a 5 dias úteis.' },
];

// ─── Ícones (SVG) ─────────────────────────────────────────────────────────────
function IconPhone() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>;
}
function IconMail() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>;
}
function IconChat() {
  return <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.1A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-MZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function SuportePage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // Chat
  const [session, setSession] = useState<{ id: string; token: string } | null>(null);
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ nome: '', email: '', pedido: '', assunto: 'Dúvida sobre Rastreio', mensagem: '' });
  const [composer, setComposer] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Retomar conversa guardada
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setSession(JSON.parse(raw));
    } catch { /* ignora storage inacessível */ }
  }, []);

  const refresh = useCallback(async (s: { id: string; token: string }) => {
    try {
      setThread(await getSupportThread(s.id, s.token));
    } catch {
      // Token inválido/conversa removida — recomeça.
      window.localStorage.removeItem(STORAGE_KEY);
      setSession(null);
      setThread(null);
    }
  }, []);

  // Polling enquanto há sessão
  useEffect(() => {
    if (!session) return;
    void refresh(session);
    const t = setInterval(() => void refresh(session), POLL_MS);
    return () => clearInterval(t);
  }, [session, refresh]);

  // Auto-scroll ao fundo quando chegam mensagens
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.messages.length]);

  const startConversation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setStarting(true);
    try {
      const { thread: t, access_token } = await openSupportThread({
        client_name: form.nome,
        client_email: form.email || undefined,
        subject: form.assunto,
        message: form.mensagem,
        tracking_code: form.pedido.trim() || undefined,
      });
      const s = { id: t.id, token: access_token };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      setSession(s);
      setThread(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível iniciar a conversa.');
    } finally {
      setStarting(false);
    }
  };

  const sendReply = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    if (!session || !composer.trim()) return;
    setSending(true);
    setError('');
    try {
      const updated = await replySupportThread(session.id, session.token, composer.trim());
      setThread(updated);
      setComposer('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível enviar a mensagem.');
    } finally {
      setSending(false);
    }
  };

  const endConversation = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setThread(null);
    setComposer('');
    setForm({ nome: '', email: '', pedido: '', assunto: 'Dúvida sobre Rastreio', mensagem: '' });
  };

  return (
    <div className="flex flex-col gap-8 py-6 max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="text-center flex flex-col gap-2">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Central de Suporte</h1>
        <p className="text-slate-400 text-sm">Estamos aqui para ajudar com a sua entrega. Tire dúvidas ou fale com a nossa equipa.</p>
      </div>

      {/* Contactos rápidos */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4 flex flex-col items-center text-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 text-brand-400 flex items-center justify-center"><IconPhone /></div>
          <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">Telefone</h3>
          <p className="text-xs text-brand-400 font-mono">+258 21 000 999</p>
          <span className="text-[10px] text-slate-500">Seg - Sex: 08:00 - 17:00</span>
        </Card>
        <Card className="p-4 flex flex-col items-center text-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 text-brand-400 flex items-center justify-center"><IconMail /></div>
          <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">E-mail</h3>
          <p className="text-xs text-brand-400 font-mono">suporte@smarttrack.co.mz</p>
          <span className="text-[10px] text-slate-500">Resposta em até 24h</span>
        </Card>
        <Card className="p-4 flex flex-col items-center text-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center"><IconChat /></div>
          <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">Chat ao Vivo</h3>
          <p className="text-xs text-emerald-400 font-semibold">Suporte Online</p>
          <span className="text-[10px] text-slate-500">Maputo, Moçambique</span>
        </Card>
      </div>

      {/* Chat */}
      <Card className="p-0 overflow-hidden flex flex-col">
        {!session || !thread ? (
          // ── Iniciar conversa ──────────────────────────────────────────────
          <form onSubmit={startConversation} className="p-6 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-100">Iniciar conversa com o suporte</h2>
              <p className="text-xs text-slate-400 mt-1">Preencha os dados e envie a sua mensagem. Responderemos aqui mesmo, em tempo real.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="O seu nome" type="text" required placeholder="Ex: Carlos Silva" className="text-xs"
                value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
              <Input label="O seu e-mail (opcional)" type="email" placeholder="exemplo@email.com" className="text-xs"
                value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="Código do pedido (opcional)" type="text" placeholder="Ex: TRK00000001BR" className="font-mono text-xs uppercase"
                value={form.pedido} onChange={(e) => setForm({ ...form, pedido: e.target.value })} />
              <Select label="Assunto" className="text-xs" value={form.assunto}
                onChange={(e) => setForm({ ...form, assunto: e.target.value })}
                options={[
                  { value: 'Dúvida sobre Rastreio', label: 'Dúvida sobre Rastreio' },
                  { value: 'Alteração de Endereço', label: 'Alteração de Endereço' },
                  { value: 'Atraso na Entrega', label: 'Atraso na Entrega' },
                  { value: 'Reclamação ou Elogio', label: 'Reclamação ou Elogio' },
                  { value: 'Outros', label: 'Outros' },
                ]} />
            </div>
            <Textarea label="Mensagem" required rows={4} placeholder="Descreva a sua solicitação..." className="resize-none text-xs"
              value={form.mensagem} onChange={(e) => setForm({ ...form, mensagem: e.target.value })} />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <Button type="submit" variant="primary" size="lg" fullWidth loading={starting} className="text-xs">
              Iniciar conversa
            </Button>
          </form>
        ) : (
          // ── Conversa a decorrer ───────────────────────────────────────────
          <>
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/[0.06] bg-surface-elevated/40">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-slate-100 truncate">{thread.subject}</h2>
                <p className="text-[11px] text-slate-500 truncate">
                  {thread.tracking_code ? `Pedido ${thread.tracking_code} · ` : ''}
                  {thread.status === 'resolved' ? 'Conversa encerrada pela equipa' : 'Em atendimento'}
                </p>
              </div>
              <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-full ${thread.status === 'resolved' ? 'bg-slate-500/15 text-slate-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
                {thread.status === 'resolved' ? 'Resolvida' : 'Aberta'}
              </span>
            </div>

            <div className="flex flex-col gap-3 p-5 max-h-[420px] overflow-y-auto">
              {thread.messages.map((m) => {
                const isClient = m.sender === 'client';
                return (
                  <div key={m.id} className={`flex flex-col max-w-[80%] ${isClient ? 'self-end items-end' : 'self-start items-start'}`}>
                    <div className={`px-3.5 py-2 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap break-words ${isClient ? 'bg-brand-600 text-white rounded-br-sm' : 'bg-surface-elevated text-slate-200 rounded-bl-sm border border-white/[0.06]'}`}>
                      {m.body}
                    </div>
                    <span className="text-[10px] text-slate-500 mt-1 px-1">
                      {isClient ? 'Você' : m.sender_name} · {formatTime(m.created_at)}
                    </span>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={sendReply} className="flex items-end gap-2 p-3 border-t border-white/[0.06] bg-surface-elevated/30">
              <Textarea rows={1} placeholder="Escreva a sua mensagem..." className="resize-none text-xs flex-1"
                value={composer} onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(); } }} />
              <Button type="submit" variant="primary" loading={sending} disabled={!composer.trim()} className="text-xs">Enviar</Button>
            </form>
            {error && <p className="text-xs text-red-400 px-4 pb-2">{error}</p>}
            <div className="px-4 pb-3">
              <Button variant="ghost" size="sm" onClick={endConversation} className="text-[11px] text-slate-500">
                Terminar e iniciar nova conversa
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* FAQ */}
      <Card className="p-5 flex flex-col gap-4">
        <h2 className="text-lg font-bold text-slate-100 mb-1">Perguntas Frequentes (FAQ)</h2>
        <div className="flex flex-col gap-2">
          {FAQS.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div key={idx} className="border border-white/[0.06] rounded-xl overflow-hidden bg-surface-elevated/40">
                <Button onClick={() => setOpenFaq(isOpen ? null : idx)} variant="ghost"
                  className="h-auto w-full justify-between rounded-none p-4 text-left text-xs font-bold text-slate-200" aria-expanded={isOpen}>
                  <span>{faq.question}</span>
                  <span className="text-slate-400 font-mono text-sm">{isOpen ? '−' : '+'}</span>
                </Button>
                {isOpen && (
                  <div className="px-4 pb-4 text-xs text-slate-400 leading-relaxed border-t border-white/[0.04] pt-3">{faq.answer}</div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
