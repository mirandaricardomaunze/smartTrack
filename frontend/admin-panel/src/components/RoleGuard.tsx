'use client';

/**
 * @file RoleGuard.tsx
 * @description Guarda de papel para rotas do painel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — RBAC)
 *
 * A autorização a sério é do backend: cada router exige o papel certo e recusa
 * com 403. Isto é a camada de cima — evita mostrar a quem não tem acesso um
 * ecrã cheio de erros e diz porquê.
 *
 * USAR NUM `layout.tsx` DA ROTA, nunca dentro da página: a decisão só é
 * conhecida depois de o `useAdminUser` ler o token no primeiro efeito, e um
 * `return` antecipado dentro da página saltaria os hooks seguintes ("rendered
 * fewer hooks than expected"). Numa fronteira de componente própria, o problema
 * não existe.
 *
 * Sem emojis — apenas texto.
 */

import React from 'react';
import { useAdminUser, type AdminUserRole } from '@/hooks/useAdminUser';
import { Card, PageHeader } from '@/components/ui';

const ROLE_LABEL: Record<AdminUserRole, string> = {
  SUPERADMIN: 'administrador da plataforma',
  ADMIN: 'administrador da empresa',
  EMPLOYEE: 'colaborador',
  SYSTEM: 'sistema',
  SUPPORT: 'suporte',
  DRIVER: 'motorista',
  CLIENT: 'cliente',
};

export interface RoleGuardProps {
  allow: AdminUserRole[];
  title: string;
  children: React.ReactNode;
}

export default function RoleGuard({ allow, title, children }: RoleGuardProps) {
  const { role, isAuthenticated } = useAdminUser();

  // Enquanto o token não foi lido não se bloqueia nada, senão via-se "sem
  // acesso" a piscar em cada navegação.
  if (!isAuthenticated || allow.includes(role)) return <>{children}</>;

  const permitted = allow.map((r) => ROLE_LABEL[r] ?? r).join(' ou ');
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description="Área restrita." />
      <Card className="p-10 text-center text-sm text-slate-400">
        Esta área é do <strong className="text-slate-200">{permitted}</strong>.
        <span className="block mt-1 text-xs text-slate-500">
          A sua sessão é de {ROLE_LABEL[role] ?? role}.
        </span>
      </Card>
    </div>
  );
}
