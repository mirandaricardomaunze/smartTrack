import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Middleware nativo do Next.js para interceptação e proteção de rotas no servidor.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança & Controle de Acesso)
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('token')?.value;

  // Define as rotas operacionais que exigem autenticação ativa
  const isProtectedRoute = 
    pathname.startsWith('/pedidos') ||
    pathname.startsWith('/motoristas') ||
    pathname.startsWith('/rotas') ||
    pathname.startsWith('/relatorios') ||
    pathname.startsWith('/portal-colaborador') ||
    pathname.startsWith('/rh-contas');
    

  const isLoginPage = pathname.startsWith('/login');

  // Caso 1: Acessando rota protegida sem estar autenticado -> Redireciona para login
  if (isProtectedRoute && !token) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Caso 2: Acessando tela de login já estando autenticado -> Redireciona direto para o painel
  if (isLoginPage && token) {
    let target = '/pedidos';
    try {
      const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(encoded)) as { role?:string };
      if (payload.role === 'EMPLOYEE') target = '/portal-colaborador';
    } catch { /* token inválido será rejeitado pela API */ }
    const dashboardUrl = new URL(target, request.url);
    return NextResponse.redirect(dashboardUrl);
  }

  return NextResponse.next();
}

// Configura quais caminhos devem acionar o middleware (evita interceptar imagens/assets estáticos)
export const config = {
  matcher: [
    '/pedidos/:path*',
    '/motoristas/:path*',
    '/rotas/:path*',
    '/relatorios/:path*',
    '/portal-colaborador/:path*',
    '/rh-contas/:path*',
    '/login',
  ],
};
