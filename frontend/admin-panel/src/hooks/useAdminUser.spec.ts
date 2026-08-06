/**
 * @file useAdminUser.spec.ts
 * @description Testes unitários do hook useAdminUser.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — JWT/RBAC)
 *
 * Harness:
 *   - MockJwtPayloads.ADMIN — payload de referência canônico
 *   - MockJwtPayloads.MOTORISTA — valida que roles diferentes são extraídos corretamente
 */
import { renderHook, waitFor } from '@testing-library/react';
import { MockJwtPayloads }     from 'tests/harness/mocks/jwt-payloads.mock';
import { useAdminUser }        from '@/hooks/useAdminUser';
import { describe, beforeEach, it, expect, afterEach } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Gera um JWT de teste com o payload fornecido.
 * Apenas codifica em base64url — NÃO assina. Só para testes.
 */
function makeTestJwt(payload: Record<string, unknown>): string {
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body    = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const sig     = 'test-signature-not-valid';
  return `${header}.${body}.${sig}`;
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('useAdminUser', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  describe('sem token', () => {
    it('should return unauthenticated user when no token exists', async () => {
      const { result } = renderHook(() => useAdminUser());
      await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
      expect(result.current.email).toBe('');
      expect(result.current.sub).toBe('');
    });
  });

  describe('com token válido — MockJwtPayloads.ADMIN', () => {
    it('should extract email and role from ADMIN JWT payload', async () => {
      // Usa MockJwtPayloads.ADMIN do harness — nunca criar payload inline
      const adminPayload = MockJwtPayloads['ADMIN'];
      localStorage.setItem('token', makeTestJwt({
        sub:   adminPayload.sub,
        email: adminPayload.email,
        role:  adminPayload.role,
        iat:   adminPayload.iat,
        exp:   adminPayload.exp,
      }));

      const { result } = renderHook(() => useAdminUser());
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

      expect(result.current.email).toBe(adminPayload.email);
      expect(result.current.sub).toBe(adminPayload.sub);
      // Role canônico — alinhado com UserRole enum
      expect(result.current.role).toBe(adminPayload.role);
    });

    it('should return unauthenticated when token is expired', async () => {
      const expiredPayload = {
        ...MockJwtPayloads['ADMIN'],
        exp: Math.floor(Date.now() / 1000) - 3600, // expirado há 1h
      };
      localStorage.setItem('token', makeTestJwt(expiredPayload));

      const { result } = renderHook(() => useAdminUser());
      await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    });
  });

  describe('com token de MOTORISTA', () => {
    it('should correctly extract MOTORISTA role', async () => {
      const motoristaPayload = MockJwtPayloads['DRIVER'];
      localStorage.setItem('token', makeTestJwt({
        sub:   motoristaPayload.sub,
        email: motoristaPayload.email,
        role:  motoristaPayload.role,
        iat:   motoristaPayload.iat,
        exp:   motoristaPayload.exp,
      }));

      const { result } = renderHook(() => useAdminUser());
      await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

      expect(result.current.role).toBe('DRIVER');
    });
  });

  describe('com token malformado', () => {
    it('should return unauthenticated for invalid JWT structure', async () => {
      localStorage.setItem('token', 'not-a-valid-jwt');
      const { result } = renderHook(() => useAdminUser());
      await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    });

    it('should return unauthenticated for token with only 2 parts', async () => {
      localStorage.setItem('token', 'header.payload'); // falta assinatura
      const { result } = renderHook(() => useAdminUser());
      await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    });
  });
});
