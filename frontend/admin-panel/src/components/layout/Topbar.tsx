'use client';

/**
 * @file Topbar.tsx
 * @description Professional Topbar for the admin panel (English).
 */

import { usePathname } from 'next/navigation';
import { useState, useEffect, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import Link from 'next/link';

// ─── Page meta ────────────────────────────────────────────────────────────────

interface PageMeta {
  title:    string;
  subtitle: string;
  crumbs?:  { label: string; href: string }[];
}

const PAGE_META: Record<string, PageMeta> = {
  '/pedidos':       { title: 'Pedidos',       subtitle: 'Gestão e monitoramento de entregas' },
  '/movimentos':    { title: 'Movimentos',    subtitle: 'Histórico operacional e auditoria de rastreio' },
  '/notificacoes':  { title: 'Notificações',  subtitle: 'Alertas e histórico de comunicação' },
  '/motoristas':    { title: 'Motoristas',    subtitle: 'Equipe e desempenho em tempo real' },
  '/rotas':         { title: 'Rotas',         subtitle: 'Otimização e monitoramento de rotas' },
  '/relatorios':    { title: 'Relatórios',    subtitle: 'Métricas, exportações e análises' },
  '/dashboard':     { title: 'Painel Geral',  subtitle: 'Visão consolidada da operação' },
  '/configuracoes': { title: 'Configurações', subtitle: 'Parâmetros e preferências do sistema' },
  '/integracoes':   { title: 'Integrações',   subtitle: '17TRACK, Cainiao, Correios e gateways' },
};

// ─── Notifications Mock ───────────────────────────────────────────────────────

interface Notification {
  id:        string;
  type:      'warning' | 'error' | 'info' | 'success';
  title:     string;
  body:      string;
  timestamp: string; // ISO UTC
  read:      boolean;
}

const MOCK_NOTIFICATIONS: Notification[] = [
  {
    id:        'notif-001',
    type:      'warning',
    title:     'Motorista Offline',
    body:      'O motorista #0042 perdeu a conexão há 8 minutos.',
    timestamp: new Date(Date.now() - 8 * 60_000).toISOString(),
    read:      false,
  },
  {
    id:        'notif-002',
    type:      'error',
    title:     'Insucesso na Entrega',
    body:      'Pedido TRK00000031BR — destinatário ausente.',
    timestamp: new Date(Date.now() - 22 * 60_000).toISOString(),
    read:      false,
  },
  {
    id:        'notif-003',
    type:      'info',
    title:     'Sincronização Concluída',
    body:      '14 eventos offline processados com sucesso.',
    timestamp: new Date(Date.now() - 45 * 60_000).toISOString(),
    read:      false,
  },
];

// ─── Icons ───────────────────────────────────────────────────────────────────

const IconSearch = () => (
  <svg className="w-[15px] h-[15px] text-slate-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const IconBell = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
);
const IconX = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const IconChevronRight = () => (
  <svg className="w-3.5 h-3.5 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);
const IconClock = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'agora mesmo';
  if (mins < 60) return `há ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `há ${hrs}h`;
  return `há ${Math.floor(hrs / 24)}d`;
}

const NOTIF_COLORS = {
  warning: { dot: 'bg-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400' },
  error:   { dot: 'bg-red-400',   bg: 'bg-red-500/10 border-red-500/20',     text: 'text-red-400'   },
  info:    { dot: 'bg-blue-400',  bg: 'bg-blue-500/10 border-blue-500/20',   text: 'text-blue-400'  },
  success: { dot: 'bg-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400' },
};

// ─── UTC Clock ────────────────────────────────────────────────────────────────

function CatClock() {
  const [time, setTime] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      try {
        const formatter = new Intl.DateTimeFormat('pt-MZ', {
          timeZone: 'Africa/Maputo',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        setTime(formatter.format(now));
      } catch (e) {
        // Fallback in case of lack of timezone support
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        setTime(`${h}:${m}:${s}`);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hidden lg:flex items-center gap-1.5 text-xs font-mono text-slate-500 bg-surface-elevated border border-white/[0.06] rounded-lg px-2.5 py-1.5 select-none" title="Hora de Maputo (CAT)">
      <IconClock />
      <span className="tabular-nums">{time}</span>
      <span className="text-slate-700 font-sans font-normal">CAT</span>
    </div>
  );
}

// ─── Search Modal ─────────────────────────────────────────────────────────────

const QUICK_LINKS = [
  { label: 'Pedidos',      href: '/pedidos',       hint: 'Ver todos os pedidos' },
  { label: 'Movimentos',   href: '/movimentos',    hint: 'Histórico global de rastreio' },
  { label: 'Notificações', href: '/notificacoes',  hint: 'Alertas e histórico de envios' },
  { label: 'Motoristas',   href: '/motoristas',    hint: 'Equipe e rotas em tempo real' },
  { label: 'Rotas',        href: '/rotas',         hint: 'Otimização de rotas' },
  { label: 'Relatórios',   href: '/relatorios',    hint: 'Métricas e exportações' },
];

interface SearchModalProps {
  open:    boolean;
  onClose: () => void;
}

function SearchModal({ open, onClose }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!open) return null;

  const filtered = QUICK_LINKS.filter((l) =>
    !query || l.label.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-xl bg-surface-elevated border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-slide-in">
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/[0.06]">
          <IconSearch />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar pedido, motorista, rota..."
            className="flex-1 bg-transparent border-none outline-none text-sm text-slate-100 placeholder-slate-500"
          />
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-surface-overlay"
          >
            <IconX />
          </button>
        </div>

        <div className="p-2 max-h-80 overflow-y-auto">
          {!query && (
            <p className="text-[0.7rem] font-bold uppercase tracking-widest text-slate-600 px-3 pt-2 pb-1">
              Navegação Rápida
            </p>
          )}
          {filtered.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-8">
              Nenhum resultado encontrado para &ldquo;{query}&rdquo;
            </p>
          )}
          {filtered.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-overlay transition-colors group/sl"
            >
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-200 group-hover/sl:text-slate-100">{item.label}</p>
                <p className="text-xs text-slate-500">{item.hint}</p>
              </div>
              <IconChevronRight />
            </Link>
          ))}
        </div>

        <div className="px-4 py-2.5 border-t border-white/[0.06] flex items-center gap-3 text-[0.65rem] text-slate-600">
          <span><kbd className="bg-surface-overlay border border-white/10 rounded px-1.5 py-px">↵</kbd> selecionar</span>
          <span><kbd className="bg-surface-overlay border border-white/10 rounded px-1.5 py-px">esc</kbd> fechar</span>
        </div>
      </div>
    </div>
  );
}

// ─── Notifications Panel ──────────────────────────────────────────────────────

function NotificationsPanel() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(MOCK_NOTIFICATIONS);
  const ref = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const markAllRead = () => setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notificações${unreadCount > 0 ? ` — ${unreadCount} não lidas` : ''}`}
        aria-expanded={open}
        className={clsx(
          'relative btn btn-ghost btn-icon transition-colors',
          open && 'bg-surface-elevated text-slate-100',
        )}
      >
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 rounded-full text-[0.575rem] font-bold text-white flex items-center justify-center leading-none shadow-sm">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
        <IconBell />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-surface-overlay border border-white/10 rounded-2xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <div>
              <p className="text-sm font-bold text-slate-100">Notificações</p>
              {unreadCount > 0 && (
                <p className="text-[0.7rem] text-slate-500">{unreadCount} não lidas</p>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-[0.7rem] font-semibold text-brand-400 hover:text-brand-300 transition-colors"
              >
                Marcar todas como lidas
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto p-2 flex flex-col gap-1">
            {notifications.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">Nenhuma notificação</p>
            ) : (
              notifications.map((n) => {
                const colors = NOTIF_COLORS[n.type];
                return (
                  <div
                    key={n.id}
                    className={clsx(
                      'flex gap-3 p-3 rounded-xl border transition-colors',
                      n.read ? 'bg-transparent border-transparent' : clsx(colors.bg),
                    )}
                  >
                    <span className={clsx('w-2 h-2 rounded-full flex-shrink-0 mt-1', colors.dot)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-200 truncate">{n.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{n.body}</p>
                      <p className="text-[0.65rem] text-slate-600 mt-1">{formatRelativeTime(n.timestamp)}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="px-4 py-2.5 border-t border-white/[0.06]">
            <Link
              href="/notificacoes"
              onClick={() => setOpen(false)}
              className="block w-full rounded-lg py-1.5 text-center text-xs font-semibold text-brand-400 transition-colors hover:bg-brand-500/10 hover:text-brand-300"
            >
              Ver todas
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Breadcrumbs ─────────────────────────────────────────────────────────────

function Breadcrumbs({ pathname }: { pathname: string }) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length <= 1) return null;

  return (
    <nav aria-label="breadcrumb" className="flex items-center gap-1 text-xs text-slate-500">
      <span className="text-slate-600">Admin</span>
      {parts.map((part, i) => {
        const href = '/' + parts.slice(0, i + 1).join('/');
        const label = part.charAt(0).toUpperCase() + part.slice(1);
        const isLast = i === parts.length - 1;
        return (
          <span key={href} className="flex items-center gap-1">
            <IconChevronRight />
            {isLast ? (
              <span className="text-slate-300 font-medium">{label}</span>
            ) : (
              <Link href={href} className="hover:text-slate-300 transition-colors">{label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ─── Topbar ───────────────────────────────────────────────────────────────────

export default function Topbar() {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);

  const metaKey = Object.keys(PAGE_META).find((k) => pathname.startsWith(k)) ?? '/pedidos';
  const { title, subtitle } = PAGE_META[metaKey];

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setSearchOpen(true);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      <header className="h-topbar bg-surface/80 border-b border-white/[0.06] flex items-center justify-between px-6 gap-4 sticky top-0 z-10 backdrop-blur-md">

        {/* ── Left: title + breadcrumb ── */}
        <div className="flex flex-col justify-center min-w-0">
          <Breadcrumbs pathname={pathname} />
          <div className="flex items-baseline gap-2 mt-px">
            <h1 className="text-[1.0625rem] font-bold text-slate-100 tracking-tight leading-tight truncate">
              {title}
            </h1>
            <span className="hidden sm:block text-xs text-slate-500 truncate">{subtitle}</span>
          </div>
        </div>

        {/* ── Right: controls ── */}
        <div className="flex items-center gap-2 flex-shrink-0">

          <CatClock />

          <div className="hidden lg:block w-px h-5 bg-white/[0.08]" />

          <button
            id="topbar-search-btn"
            onClick={() => setSearchOpen(true)}
            aria-label="Buscar... (Ctrl+K)"
            className="flex items-center gap-2 bg-surface-elevated border border-white/10 rounded-xl px-3 py-2 w-52 text-left transition-all duration-150 hover:border-white/20 hover:bg-surface-overlay group/search"
          >
            <IconSearch />
            <span className="flex-1 text-[0.8125rem] text-slate-500 group-hover/search:text-slate-400">
              Buscar...
            </span>
            <kbd className="hidden sm:flex items-center gap-0.5 text-[0.6375rem] text-slate-600 bg-surface-overlay border border-white/10 rounded px-1.5 py-px font-sans">
              <span className="text-[0.7rem]">⌘</span>K
            </kbd>
          </button>

          <NotificationsPanel />

          <div className="w-px h-5 bg-white/[0.08]" />

          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1 select-none">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
            <span className="hidden sm:inline">Ao vivo</span>
          </div>

        </div>
      </header>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
