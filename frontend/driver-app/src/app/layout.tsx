import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SmartTrack - Motorista',
  description: 'Aplicativo de Entregas e Rotas para Motoristas',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'SmartTrack Motorista',
  },
};

export const viewport: Viewport = {
  themeColor: '#0f1117',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="bg-surface-base text-slate-100 min-h-screen flex flex-col justify-between">
        <header className="h-14 border-b border-white/[0.06] bg-surface flex items-center justify-between px-4 sticky top-0 z-50">
          <div className="flex items-center gap-2">
            <span className="text-brand-400 font-extrabold text-sm">SmartTrack</span>
            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full px-2 py-px font-bold uppercase">Motorista</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Online
          </div>
        </header>

        <main className="flex-grow flex flex-col p-4 w-full">
          {children}
        </main>

        <nav className="h-16 border-t border-white/[0.06] bg-surface flex items-center justify-around text-xs text-slate-400 sticky bottom-0 z-50">
          <a href="/rota" className="flex flex-col items-center gap-1 hover:text-slate-100">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            <span>Minha Rota</span>
          </a>
          <a href="/historico" className="flex flex-col items-center gap-1 hover:text-slate-100">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Histórico</span>
          </a>
        </nav>
      </body>
    </html>
  );
}
