import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SmartTrack Admin',
    template: '%s | SmartTrack Admin',
  },
  description: 'Painel administrativo de logística e rastreamento de entregas',
  robots: { index: false, follow: false }, // painel interno — não indexar
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <head>
        {/* A fonte é o primeiro recurso que o texto espera: pré-carregar o
            subconjunto latin evita o salto de tipo de letra no primeiro ecrã.
            O latin-ext fica por conta do navegador — só desce se a página tiver
            caracteres desse intervalo. */}
        <link
          rel="preload"
          href="/fonts/inter-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
