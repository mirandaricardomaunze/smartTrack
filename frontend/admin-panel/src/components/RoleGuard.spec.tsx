/**
 * @file RoleGuard.spec.tsx
 * @description Testes da guarda de papel das rotas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — RBAC)
 *
 * O que importa provar: quem tem o papel entra; quem não tem vê uma explicação
 * em vez de um ecrã partido; e enquanto o token ainda não foi lido não há
 * bloqueio a piscar. A autorização real continua a ser do backend.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoleGuard from './RoleGuard';
import type { AdminUser } from '@/hooks/useAdminUser';

const state = vi.hoisted(() => ({ user: {} as AdminUser }));

vi.mock('@/hooks/useAdminUser', () => ({
  useAdminUser: () => state.user,
}));

function asUser(role: AdminUser['role'], isAuthenticated = true): AdminUser {
  return { sub: 'u1', email: 'u@example.mz', role, companyId: 'company-1', isAuthenticated };
}

describe('RoleGuard', () => {
  beforeEach(() => { state.user = asUser('ADMIN'); });

  it('should render the page for an allowed role', () => {
    render(<RoleGuard allow={['ADMIN']} title="Recursos Humanos"><p>conteúdo</p></RoleGuard>);
    expect(screen.getByText('conteúdo')).toBeDefined();
  });

  it('should explain the restriction instead of showing the page', () => {
    state.user = asUser('DRIVER');
    render(<RoleGuard allow={['ADMIN']} title="Recursos Humanos"><p>conteúdo</p></RoleGuard>);

    expect(screen.queryByText('conteúdo')).toBeNull();
    expect(screen.getByText('Recursos Humanos')).toBeDefined();
    expect(screen.getByText(/administrador da empresa/)).toBeDefined();
    expect(screen.getByText(/motorista/)).toBeDefined();
  });

  it('should keep the employee portal away from an admin', () => {
    state.user = asUser('ADMIN');
    render(<RoleGuard allow={['EMPLOYEE']} title="Portal do colaborador"><p>recibos</p></RoleGuard>);
    expect(screen.queryByText('recibos')).toBeNull();
  });

  it('should let the employee into their own portal', () => {
    state.user = asUser('EMPLOYEE');
    render(<RoleGuard allow={['EMPLOYEE']} title="Portal do colaborador"><p>recibos</p></RoleGuard>);
    expect(screen.getByText('recibos')).toBeDefined();
  });

  it('should not block before the token has been read', () => {
    // Primeiro render: `useAdminUser` ainda não leu o localStorage.
    state.user = asUser('DRIVER', false);
    render(<RoleGuard allow={['ADMIN']} title="Recursos Humanos"><p>conteúdo</p></RoleGuard>);
    expect(screen.getByText('conteúdo')).toBeDefined();
  });

  it('should accept more than one allowed role', () => {
    state.user = asUser('SUPPORT');
    render(<RoleGuard allow={['ADMIN', 'SUPPORT']} title="Faturas"><p>lista</p></RoleGuard>);
    expect(screen.getByText('lista')).toBeDefined();
  });
});
