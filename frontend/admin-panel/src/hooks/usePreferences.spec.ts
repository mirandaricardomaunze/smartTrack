/**
 * @file usePreferences.spec.ts
 * @description Testes unitários do hook usePreferences.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *
 * Cobre os três comportamentos de que as telas consumidoras dependem:
 *   1. merge com os defaults (tolerar preferências gravadas por versões antigas)
 *   2. persistência em localStorage
 *   3. propagação entre componentes montados na mesma aba (CustomEvent)
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import {
  usePreferences,
  loadPreferences,
  savePreferences,
  densityClass,
  DEFAULT_PREFERENCES,
  STORAGE_KEY,
} from '@/hooks/usePreferences';

describe('usePreferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  describe('sem preferências gravadas', () => {
    it('should return the default preferences', async () => {
      const { result } = renderHook(() => usePreferences());
      await waitFor(() => expect(result.current.loaded).toBe(true));

      expect(result.current.prefs).toEqual(DEFAULT_PREFERENCES);
    });
  });

  describe('com preferências gravadas', () => {
    it('should read persisted values from localStorage', async () => {
      savePreferences({ ...DEFAULT_PREFERENCES, density: 'compact', slaHours: 24 });

      const { result } = renderHook(() => usePreferences());
      await waitFor(() => expect(result.current.loaded).toBe(true));

      expect(result.current.prefs.density).toBe('compact');
      expect(result.current.prefs.slaHours).toBe(24);
    });

    it('should merge missing keys with defaults', async () => {
      // Simula preferências gravadas por uma versão anterior, sem `density`
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ slaHours: 12 }));

      const { result } = renderHook(() => usePreferences());
      await waitFor(() => expect(result.current.loaded).toBe(true));

      expect(result.current.prefs.slaHours).toBe(12);
      expect(result.current.prefs.density).toBe(DEFAULT_PREFERENCES.density);
      expect(result.current.prefs.showCurrency).toBe(DEFAULT_PREFERENCES.showCurrency);
    });

    it('should fall back to defaults when the stored JSON is corrupt', () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json');
      expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    });
  });

  describe('escrita', () => {
    it('should persist a changed preference to localStorage', async () => {
      const { result } = renderHook(() => usePreferences());
      await waitFor(() => expect(result.current.loaded).toBe(true));

      act(() => result.current.set('density', 'compact'));

      expect(result.current.prefs.density).toBe('compact');
      expect(loadPreferences().density).toBe('compact');
    });

    it('should restore defaults on reset', async () => {
      savePreferences({ ...DEFAULT_PREFERENCES, baseFeeCents: 9999 });

      const { result } = renderHook(() => usePreferences());
      await waitFor(() => expect(result.current.prefs.baseFeeCents).toBe(9999));

      act(() => result.current.reset());

      expect(result.current.prefs).toEqual(DEFAULT_PREFERENCES);
      expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    });
  });

  describe('propagação entre componentes', () => {
    it('should update a second hook instance in the same tab', async () => {
      // Duas telas montadas ao mesmo tempo — ex.: Configurações e Pedidos
      const escritor = renderHook(() => usePreferences());
      const leitor   = renderHook(() => usePreferences());

      await waitFor(() => expect(leitor.result.current.loaded).toBe(true));
      expect(leitor.result.current.prefs.showCurrency).toBe(true);

      act(() => escritor.result.current.set('showCurrency', false));

      // O evento nativo `storage` não dispara na própria aba — é o CustomEvent
      // emitido por savePreferences que mantém o leitor em sincronia.
      await waitFor(() => expect(leitor.result.current.prefs.showCurrency).toBe(false));
    });
  });

  describe('densityClass', () => {
    it('should return the compact modifier only for compact density', () => {
      expect(densityClass('compact')).toBe('data-table-compact');
      expect(densityClass('comfortable')).toBe('');
    });
  });
});
