/**
 * @file layout.tsx
 * @description Guarda de papel da rota — ver components/RoleGuard.tsx.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 */
import RoleGuard from '@/components/RoleGuard';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RoleGuard allow={['ADMIN', 'SUPERADMIN']} title="Utilizadores">{children}</RoleGuard>;
}
