/**
 * @file layout.tsx
 * @description Guarda de papel da rota — ver components/RoleGuard.tsx.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — RBAC)
 */
import RoleGuard from '@/components/RoleGuard';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RoleGuard allow={['ADMIN']} title="Recrutamento">{children}</RoleGuard>;
}
