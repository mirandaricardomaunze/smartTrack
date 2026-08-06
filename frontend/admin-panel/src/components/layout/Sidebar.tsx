'use client';

/**
 * @file Sidebar.tsx
 * @description Sidebar profissional do admin panel — com collapse, seções agrupadas,
 * badges reais e footer interativo.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *
 * Dados reais via hooks:
 *   - useSidebarStats — badges de pendingOrders e offlineDrivers
 *   - useAdminUser    — email e role no footer
 *
 * Tipos alinhados com harness:
 *   - SidebarStats (tests/harness/factories/sidebar-stats.factory.ts)
 *   - AdminUser / AdminUserRole (hooks/useAdminUser.ts)
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import { useState, useRef, useEffect } from 'react';
import { useSidebarStats } from '@/hooks/useSidebarStats';
import { useAdminUser }    from '@/hooks/useAdminUser';
import type { AdminUserRole } from '@/hooks/useAdminUser';

// ─── Role label map ──────────────────────────────────────────────────────────

const ROLE_LABEL: Record<AdminUserRole, string> = {
  SUPERADMIN: 'Plataforma',
  ADMIN:   'Administrador',
  EMPLOYEE: 'Colaborador',
  SYSTEM:  'Sistema',
  SUPPORT: 'Suporte',
  DRIVER:  'Motorista',
  CLIENT:  'Cliente',
};

// ─── Icons ───────────────────────────────────────────────────────────────────

const IconPackage = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/>
    <path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/>
    <line x1="12" y1="22" x2="12" y2="12"/>
  </svg>
);
const IconDriver = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/>
    <circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>
  </svg>
);
const IconMap = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
    <line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>
  </svg>
);
const IconActivity = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </svg>
);
const IconChart = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
  </svg>
);
const IconDashboard = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
  </svg>
);
const IconSettings = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
  </svg>
);
const IconIntegration = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
    <path d="M6 9v9"/><path d="M9 6h9"/>
  </svg>
);
const IconChevronLeft = ({ collapsed }: { collapsed: boolean }) => (
  <svg
    className={clsx('w-4 h-4 transition-transform duration-300', collapsed && 'rotate-180')}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
  >
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);
const IconLogout = () => (
  <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);
const IconUserCircle = () => (
  <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
  </svg>
);
const IconGear = () => (
  <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
  </svg>
);

const IconWarehouse = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h6"/>
  </svg>
);
const IconGlobe = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9"/>
    <path d="M3 12h18"/>
    <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21C9.5 18.5 8.2 15.3 8.2 12S9.5 5.5 12 3z"/>
  </svg>
);
const IconCash = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="20" height="12" rx="2"/>
    <circle cx="12" cy="12" r="2.5"/>
    <path d="M6 12h.01M18 12h.01"/>
  </svg>
);
const IconTag = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
    <line x1="7" y1="7" x2="7.01" y2="7"/>
  </svg>
);
const IconInvoice = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="9" y1="9" x2="10" y2="9"/>
  </svg>
);
const IconMessage = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);
const IconBuilding = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/>
    <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>
  </svg>
);
const IconAudit = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    <circle cx="11.5" cy="14.5" r="2.5"/><path d="m13.5 16.5 2 2"/>
  </svg>
);
const IconFiscal = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>
    <path d="M16 3h5v5"/><path d="M21 3l-9 9"/><path d="M7 17h5"/>
  </svg>
);
const IconPlan = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
    <line x1="6" y1="15" x2="10" y2="15"/>
  </svg>
);
const IconClients = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);
const IconPeople = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="7" r="4"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><path d="M16 3.1a4 4 0 0 1 0 7.8M18 15a6 6 0 0 1 3 5.2V21"/>
  </svg>
);
const IconSupport = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
    <path d="M21 19a2 2 0 0 1-2 2h-3"/>
    <rect x="1" y="14" width="4" height="7" rx="1"/><rect x="19" y="14" width="4" height="7" rx="1"/>
  </svg>
);

// ─── Nav config ───────────────────────────────────────────────────────────────
// Badges são injetados dinamicamente via useSidebarStats — sem hard-codes.

interface NavItem {
  href:         string;
  label:        string;
  icon:         React.ReactNode;
  /** null = sem badge; undefined = aguardando; number = contagem real */
  badge?:       number | null;
  badgeVariant?: 'default' | 'warning' | 'danger';
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const HR_NAV_ITEMS: Omit<NavItem, 'badge' | 'badgeVariant'>[] = [
  { href: '/rh', label: 'Visão geral', icon: <IconPeople /> },
  { href: '/folha-salarial', label: 'Folha salarial', icon: <IconCash /> },
  { href: '/recrutamento', label: 'Recrutamento', icon: <IconPeople /> },
  { href: '/desempenho', label: 'Desempenho', icon: <IconChart /> },
  { href: '/rh-operacoes', label: 'Operações de RH', icon: <IconActivity /> },
  { href: '/rh-contas', label: 'Acessos do portal', icon: <IconPeople /> },
];

// Estrutura estática — badges são injetados no componente via hook
const NAV_GROUPS_STATIC: Omit<NavItem, 'badge' | 'badgeVariant'>[][] = [
  // MAIN
  [
    { href: '/dashboard',  label: 'Painel Geral',  icon: <IconDashboard /> },
    { href: '/pedidos',    label: 'Pedidos',       icon: <IconPackage /> },
    { href: '/clientes',   label: 'Clientes',      icon: <IconClients /> },
    { href: '/armazens',   label: 'Armazéns',      icon: <IconWarehouse /> },
    { href: '/movimentos', label: 'Movimentos',    icon: <IconActivity /> },
    { href: '/motoristas', label: 'Motoristas',    icon: <IconDriver /> },
    { href: '/frota',      label: 'Frota',         icon: <IconDriver /> },
    { href: '/rotas',      label: 'Rotas',         icon: <IconMap /> },
  ],
  // ANALYSIS
  [
    { href: '/rastreio-internacional', label: 'Rastreio Intl.', icon: <IconGlobe /> },
    { href: '/tarifas',                label: 'Tarifas',        icon: <IconTag /> },
    { href: '/faturas',                label: 'Faturas',        icon: <IconInvoice /> },
    { href: '/fiscal',                 label: 'Fiscal',         icon: <IconFiscal /> },
    { href: '/financas',               label: 'Finanças',       icon: <IconCash /> },
    { href: '/acertos',                label: 'Acertos',        icon: <IconCash /> },
    { href: '/relatorios',             label: 'Relatórios',     icon: <IconChart /> },
  ],
  // SYSTEM
  [
    { href: '/suporte',       label: 'Suporte',       icon: <IconSupport /> },
    { href: '/mensagens',     label: 'Mensagens',     icon: <IconMessage /> },
    { href: '/plano',         label: 'Plano & Uso',   icon: <IconPlan /> },
    { href: '/empresa',       label: 'Empresa',       icon: <IconBuilding /> },
    { href: '/auditoria',     label: 'Auditoria',     icon: <IconAudit /> },
    { href: '/configuracoes', label: 'Configurações', icon: <IconSettings /> },
    { href: '/integracoes',   label: 'Integrações',   icon: <IconIntegration /> },
  ],
];

const GROUP_LABELS = ['Operações', 'Gestão', 'Sistema'];

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function Tooltip({ label, children, show }: { label: string; children: React.ReactNode; show: boolean }) {
  if (!show) return <>{children}</>;
  return (
    <div className="relative group/tip flex w-full">
      {children}
      <div className="
        pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50
        px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-white/10
        text-xs font-semibold text-slate-100 whitespace-nowrap shadow-xl
        opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150
      ">
        {label}
        <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-surface-overlay" />
      </div>
    </div>
  );
}

// ─── Nav Badge ────────────────────────────────────────────────────────────────

function NavBadge({ count, variant }: { count: number; variant?: NavItem['badgeVariant'] }) {
  const colors = {
    default: 'bg-surface-overlay text-slate-300',
    warning: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    danger:  'bg-red-500/20 text-red-400 border border-red-500/30',
  };
  return (
    <span className={clsx(
      'ml-auto min-w-[20px] h-5 px-1.5 rounded-full text-[0.6rem] font-bold flex items-center justify-center leading-none',
      colors[variant ?? 'default'],
    )}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ─── Footer user menu ─────────────────────────────────────────────────────────

interface FooterMenuProps {
  collapsed: boolean;
  email: string;
  role: AdminUserRole;
}

function FooterMenu({ collapsed, email, role }: FooterMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Iniciais do email para avatar
  const initials = email ? email.charAt(0).toUpperCase() : 'A';
  const roleLabel = ROLE_LABEL[role] ?? role;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    window.location.href = '/login';
  };

  return (
    <div ref={ref} className="relative">
      {/* Dropdown */}
      {open && (
        <div className={clsx(
          'absolute bottom-full mb-2 z-50 bg-surface-overlay border border-white/10 rounded-2xl shadow-2xl overflow-hidden',
          collapsed ? 'left-full ml-2 w-52' : 'left-0 right-0',
        )}>
          <div className="px-3 py-3 border-b border-white/[0.06]">
            {/* Não logar email cru no console — exibir apenas na UI conforme LGPD */}
            <p className="text-sm font-bold text-slate-100 truncate">{email || 'Admin'}</p>
            <p className="text-[0.7rem] text-slate-500 mt-0.5">{roleLabel}</p>
          </div>
          <div className="p-1.5 flex flex-col gap-0.5">
            <button className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm text-slate-300 hover:bg-surface-elevated hover:text-slate-100 transition-colors text-left">
              <IconUserCircle /> Meu Perfil
            </button>
            <Link
              href="/configuracoes"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm text-slate-300 hover:bg-surface-elevated hover:text-slate-100 transition-colors"
            >
              <IconGear /> Preferências
            </Link>
          </div>
          <div className="p-1.5 border-t border-white/[0.06]">
            <button
              onClick={handleLogout}
              className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors text-left"
            >
              <IconLogout /> Sair
            </button>
          </div>
        </div>
      )}

      {/* Trigger */}
      <Tooltip label={email || 'Admin'} show={collapsed}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="User Menu"
          className={clsx(
            'w-full flex items-center gap-3 rounded-xl px-2 py-2',
            'hover:bg-surface-elevated transition-colors duration-150',
            open && 'bg-surface-elevated',
          )}
        >
          {/* Avatar com iniciais */}
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex-shrink-0 ring-2 ring-emerald-500/20 flex items-center justify-center text-xs font-bold text-white">
            {initials}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-semibold text-slate-100 truncate">
                  {email || 'Admin'}
                </p>
                <p className="text-[0.7rem] text-slate-500 truncate">{roleLabel}</p>
              </div>
              <svg
                className={clsx('w-3.5 h-3.5 text-slate-500 flex-shrink-0 transition-transform duration-150', open && 'rotate-180')}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </>
          )}
        </button>
      </Tooltip>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const hrRouteActive = HR_NAV_ITEMS.some((item) => pathname === item.href || pathname.startsWith(item.href + '/'));
  const [hrOpen, setHrOpen] = useState(hrRouteActive);

  useEffect(() => {
    if (hrRouteActive) setHrOpen(true);
  }, [hrRouteActive]);

  // Dados reais — sem hard-codes (spec §3.4, harness sidebar-stats.factory.ts)
  const { pendingOrders, offlineDrivers, warehousesNearCapacity } = useSidebarStats();
  const { email, role, isAuthenticated }  = useAdminUser();

  /**
   * Injeta badges reais nos itens de navegação, associados por href (robusto a
   * reordenações/inserções de itens). null → badge não renderizado.
   * Alinhado com TestDriver.status_atual e OrderStatus do harness.
   */
  const BADGE_BY_HREF: Record<string, { badge: number | null; variant: NavItem['badgeVariant'] }> = {
    '/pedidos':    { badge: pendingOrders,          variant: 'warning' },
    '/motoristas': { badge: offlineDrivers,         variant: 'danger'  },
    '/armazens':   { badge: warehousesNearCapacity, variant: 'warning' },
  };

  const navGroups: NavGroup[] = NAV_GROUPS_STATIC.map((group, i) => ({
    label: GROUP_LABELS[i],
    items: group.map((item) => {
      const meta = BADGE_BY_HREF[item.href];
      return meta ? { ...item, badge: meta.badge, badgeVariant: meta.variant } : { ...item };
    }),
  }));

  if (role === 'EMPLOYEE') {
    navGroups.splice(0, navGroups.length, { label: 'Colaborador', items: [{ href: '/portal-colaborador', label: 'Meu portal', icon: <IconPeople /> }] });
  }

  // Consola da plataforma — só para o SUPERADMIN (multi-tenant, spec § 2.4).
  if (role === 'SUPERADMIN') {
    navGroups.push({ label: 'Plataforma', items: [{ href: '/empresas', label: 'Empresas', icon: <IconBuilding /> }] });
  }

  return (
    <aside
      className={clsx(
        'relative z-40 isolate overflow-visible bg-surface border-r border-white/[0.06] flex flex-col sticky top-0 h-screen',
        'transition-[width] duration-300 ease-in-out',
        collapsed ? 'w-[68px]' : 'w-sidebar',
      )}
    >
      {/* ── Collapse toggle ── */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        aria-label={collapsed ? 'Expandir menu lateral' : 'Minimizar menu lateral'}
        title={collapsed ? 'Expandir menu lateral' : 'Minimizar menu lateral'}
        className={clsx(
          'absolute top-5 right-[-16px] z-50',
          'flex items-center justify-center w-8 h-8 rounded-full',
          'bg-brand-600 border border-brand-400/70 shadow-[0_0_0_3px_rgba(15,17,23,0.9),0_4px_14px_rgba(99,102,241,0.45)]',
          'text-white hover:bg-brand-500 hover:border-brand-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          'transition-all duration-150 cursor-pointer hover:scale-105 active:scale-95',
        )}
      >
        <IconChevronLeft collapsed={collapsed} />
      </button>

      {/* Container interno com controle de overflow para evitar clipping do botão e dos tooltips */}
      <div
        className={clsx(
          'flex-1 flex flex-col h-full',
          collapsed ? 'overflow-visible' : 'overflow-y-auto overflow-x-hidden scrollbar-thin'
        )}
      >
        {/* ── Logo ── */}
        <div className={clsx(
          'flex items-center gap-3 pt-4 pb-5 flex-shrink-0',
          collapsed ? 'px-[14px] justify-center' : 'px-4',
        )}>
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-600 to-brand-400 flex items-center justify-center shadow-[0_4px_14px_rgba(99,102,241,0.4)] flex-shrink-0">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3"/>
              <rect x="9" y="11" width="14" height="10" rx="2"/>
              <circle cx="12" cy="20" r="1"/><circle cx="20" cy="20" r="1"/>
            </svg>
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <span className="block text-[0.9375rem] font-bold text-slate-100 tracking-tight leading-tight whitespace-nowrap">
                SmartTrack
              </span>
              <span className="inline-block mt-0.5 text-[0.6rem] font-bold text-brand-400 bg-brand-500/10 rounded-full px-2 py-px tracking-widest uppercase">
                Admin
              </span>
            </div>
          )}
        </div>

        {/* ── Nav groups ── */}
        <nav
          className={clsx('flex-1 flex flex-col gap-5 pb-2', collapsed ? 'px-[10px]' : 'px-3')}
          aria-label="Navegação principal"
        >
          {navGroups.map((group) => (
            <div key={group.label}>
              {/* Section label */}
              {!collapsed ? (
                <p className="text-[0.6rem] font-bold uppercase tracking-[0.1em] text-slate-600 px-2 pb-1.5 pt-0.5">
                  {group.label}
                </p>
              ) : (
                <div className="w-full h-px bg-white/[0.06] mb-2 mt-1" />
              )}

              {/* Items */}
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ href, label, icon, badge, badgeVariant }) => {
                  const active = pathname === href || pathname.startsWith(href + '/');
                  return (
                    <Tooltip key={href} label={label} show={collapsed}>
                      <Link
                        href={href}
                        className={clsx(
                          'relative flex items-center gap-3 py-2 rounded-xl text-sm font-medium',
                          'transition-all duration-150 group/item w-full',
                          collapsed ? 'justify-center px-0' : 'px-3',
                          active
                            ? 'bg-brand-500/[0.12] text-brand-400 font-semibold'
                            : 'text-slate-400 hover:bg-surface-elevated hover:text-slate-100',
                        )}
                      >
                        {/* Barra ativa lateral */}
                        {active && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-brand-400 shadow-[0_0_8px_rgba(129,140,248,0.6)]" />
                        )}

                        {/* Ícone */}
                        <span className={clsx(
                          'flex-shrink-0 transition-colors',
                          active
                            ? 'text-brand-400'
                            : 'text-slate-500 group-hover/item:text-slate-300',
                        )}>
                          {icon}
                        </span>

                        {/* Label + badge (expandido) */}
                        {!collapsed && (
                          <>
                            <span className="flex-1 truncate">{label}</span>
                            {badge != null && badge > 0 && (
                              <NavBadge count={badge} variant={badgeVariant} />
                            )}
                          </>
                        )}

                        {/* Mini-badge sobre ícone (colapsado) */}
                        {collapsed && badge != null && badge > 0 && (
                          <span className={clsx(
                            'absolute top-0.5 right-0.5 min-w-[14px] h-3.5 px-1 rounded-full',
                            'text-[0.5rem] font-bold flex items-center justify-center leading-none',
                            badgeVariant === 'danger'  ? 'bg-red-500 text-white' :
                            badgeVariant === 'warning' ? 'bg-amber-500 text-white' :
                            'bg-surface-overlay text-slate-300',
                          )}>
                            {badge > 9 ? '9+' : badge}
                          </span>
                        )}
                      </Link>
                    </Tooltip>
                  );
                })}
                {group.label === 'Operações' && role !== 'EMPLOYEE' && (
                  <div className="flex flex-col gap-0.5">
                    <Tooltip label="Recursos Humanos" show={collapsed}>
                      <button
                        type="button"
                        aria-expanded={hrOpen}
                        aria-controls="hr-sidebar-menu"
                        onClick={() => {
                          if (collapsed) setCollapsed(false);
                          setHrOpen((value) => !value);
                        }}
                        className={clsx(
                          'relative flex w-full items-center gap-3 rounded-xl py-2 text-sm font-medium transition-all duration-150 group/item',
                          collapsed ? 'justify-center px-0' : 'px-3',
                          hrRouteActive
                            ? 'bg-brand-500/[0.12] text-brand-400 font-semibold'
                            : 'text-slate-400 hover:bg-surface-elevated hover:text-slate-100',
                        )}
                      >
                        {hrRouteActive && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-400 shadow-[0_0_8px_rgba(129,140,248,0.6)]" />}
                        <span className={clsx('flex-shrink-0', hrRouteActive ? 'text-brand-400' : 'text-slate-500 group-hover/item:text-slate-300')}><IconPeople /></span>
                        {!collapsed && <><span className="flex-1 truncate text-left">Recursos Humanos</span><svg className={clsx('h-4 w-4 transition-transform',hrOpen&&'rotate-180')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg></>}
                      </button>
                    </Tooltip>
                    {!collapsed && hrOpen && (
                      <div id="hr-sidebar-menu" className="ml-4 flex flex-col gap-0.5 border-l border-white/[0.08] pl-2">
                        {HR_NAV_ITEMS.map(({href,label,icon})=>{const active=pathname===href||pathname.startsWith(href+'/');return <Link key={href} href={href} className={clsx('flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',active?'bg-brand-500/[0.1] text-brand-300':'text-slate-500 hover:bg-surface-elevated hover:text-slate-200')}><span className="scale-90">{icon}</span><span className="truncate">{label}</span></Link>})}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </nav>

        {/* ── Footer ── */}
        <div className={clsx(
          'mt-auto border-t border-white/[0.06] flex-shrink-0',
          collapsed ? 'px-[10px] py-3' : 'px-3 py-3',
        )}>
          <FooterMenu
            collapsed={collapsed}
            email={isAuthenticated ? email : 'admin@smarttrack.co.mz'}
            role={role}
          />
        </div>
      </div>
    </aside>
  );
}
