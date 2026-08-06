/**
 * @file useAdminUser.ts
 * @description Hook que extrai dados do usuário admin do JWT armazenado no localStorage.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — OAuth2/JWT, RBAC)
 *
 * Contrato alinhado com:
 *   - MockJwtPayloads.ADMIN (tests/harness/mocks/jwt-payloads.mock.ts)
 *   - UserRole enum (backend/shared/types/src/roles.enum.ts)
 *
 * IMPORTANTE:
 *   - Decodifica o payload JWT localmente (base64) — NÃO verifica assinatura.
 *   - Verificação de assinatura é responsabilidade do api-gateway (server-side).
 *   - Nunca logar dados PII crus — campos mascarados ao expor ao console.
 *
 * Storage: localStorage.getItem('token') — conforme api.ts linha 138.
 */
'use client';

import { useState, useEffect } from 'react';

/** Roles canônicos — espelha UserRole enum do backend + SUPERADMIN (plataforma). */
export type AdminUserRole = 'SUPERADMIN' | 'ADMIN' | 'SYSTEM' | 'SUPPORT' | 'DRIVER' | 'CLIENT' | 'EMPLOYEE';

export interface AdminUser {
  /** Subject — ID do usuário (não expor em UI, apenas internamente) */
  sub: string;
  /** Email do usuário — exibido no footer do sidebar */
  email: string;
  /** Role canônico do JWT — alinhado com UserRole enum */
  role: AdminUserRole;
  /** Empresa do utilizador (multi-tenant); null para SUPERADMIN da plataforma */
  companyId: string | null;
  /** true se o token estiver presente e não expirado */
  isAuthenticated: boolean;
}

/** Fallback enquanto carrega ou quando sem token */
const UNAUTHENTICATED: AdminUser = {
  sub:             '',
  email:           '',
  role:            'ADMIN',
  companyId:       null,
  isAuthenticated: false,
};

/**
 * Decodifica o payload de um JWT sem verificar assinatura.
 * Retorna null se o token for inválido ou expirado.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Normaliza base64url → base64 padrão
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json   = atob(base64);
    const payload = JSON.parse(json) as Record<string, unknown>;

    // Rejeita token expirado
    const exp = typeof payload['exp'] === 'number' ? payload['exp'] : null;
    if (exp !== null && exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

export function useAdminUser(): AdminUser {
  const [user, setUser] = useState<AdminUser>(UNAUTHENTICATED);

  useEffect(() => {
    // localStorage só acessível no cliente — api.ts usa o mesmo padrão (linha 138)
    const token = localStorage.getItem('token');
    if (!token) {
      setUser(UNAUTHENTICATED);
      return;
    }

    const payload = decodeJwtPayload(token);
    if (!payload) {
      setUser(UNAUTHENTICATED);
      return;
    }

    setUser({
      sub:             typeof payload['sub']   === 'string' ? payload['sub']             : '',
      email:           typeof payload['email'] === 'string' ? payload['email']           : '',
      role:            typeof payload['role']  === 'string' ? (payload['role'] as AdminUserRole) : 'ADMIN',
      companyId:       typeof payload['company_id'] === 'string' ? payload['company_id'] : null,
      isAuthenticated: true,
    });
  }, []);

  return user;
}
