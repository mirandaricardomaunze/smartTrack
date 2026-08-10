import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SmartTrack - Portal do Cliente',
  description: 'Rastreamento de encomendas e suporte de entregas',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <head>
        {/* Ver a nota do preload no admin-panel: evita o salto de tipo de letra. */}
        <link
          rel="preload"
          href="/fonts/inter-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="bg-surface-base text-slate-100 min-h-screen flex flex-col">
        {/* Simple Navigation */}
        <header className="h-16 border-b border-white/[0.06] bg-surface flex items-center justify-between px-6 sticky top-0 z-50">
          <a href="/" className="flex items-center gap-2">
            <span className="text-brand-400 font-extrabold text-lg">SmartTrack</span>
            <span className="text-2xs bg-brand-500/10 text-brand-400 rounded-full px-2 py-px font-bold uppercase">Cliente</span>
          </a>
          <nav className="flex gap-4 text-sm text-slate-400">
            <a href="/rastrear" className="hover:text-slate-100 transition-colors">Rastrear</a>
            <a href="/suporte" className="hover:text-slate-100 transition-colors">Suporte</a>
          </nav>
        </header>

        <main className="flex-grow flex flex-col p-6 max-w-4xl mx-auto w-full">
          {children}
        </main>

        <footer className="h-12 border-t border-white/[0.06] bg-surface flex items-center justify-center text-xs text-slate-600">
          &copy; {new Date().getFullYear()} SmartTrack. Todos os direitos reservados.
        </footer>
      </body>
    </html>
  );
}
