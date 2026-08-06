/**
 * @file usePreferences.ts
 * @description Preferências do painel admin, partilhadas entre telas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *
 * PERSISTÊNCIA:
 * Não existe endpoint /v1/settings no api-gateway — as preferências vivem em
 * localStorage sob `sistematrack:preferences`, portanto são locais a este
 * browser. Quando existir endpoint, substituir load/save por fetchApi mantendo
 * esta mesma interface pública.
 *
 * SINCRONIZAÇÃO ENTRE COMPONENTES:
 * localStorage não notifica a própria aba que escreveu (o evento nativo
 * `storage` só dispara noutras abas). Por isso emitimos um CustomEvent próprio
 * ao guardar — assim a tela de Configurações e as tabelas que consomem estas
 * preferências mantêm-se em sincronia sem recarregar a página.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';

export const STORAGE_KEY = 'sistematrack:preferences';

/** Evento interno emitido após cada gravação — ver nota de sincronização acima. */
const CHANGE_EVENT = 'sistematrack:preferences-changed';

export interface Preferences {
  /** Intervalo de refresh dos painéis, em segundos */
  refreshIntervalSec: number;
  /** Realçar pedidos em insucesso nas listagens */
  alertOnFailure: boolean;
  /** Mostrar colunas de valor monetário nas tabelas */
  showCurrency: boolean;
  /** Densidade das tabelas */
  density: 'comfortable' | 'compact';
  /** Tarifa base por entrega, em centavos (regra do projeto: nunca float) */
  baseFeeCents: number;
  /** SLA alvo de entrega, em horas */
  slaHours: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  refreshIntervalSec: 30,
  alertOnFailure:     true,
  showCurrency:       true,
  density:            'comfortable',
  baseFeeCents:       2990,
  slaHours:           48,
};

/**
 * Lê as preferências do localStorage.
 * Faz merge com os defaults — tolera chaves em falta de versões anteriores.
 */
export function loadPreferences(): Preferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;

    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    // JSON corrompido — não vale a pena partir a UI por causa de preferências
    return DEFAULT_PREFERENCES;
  }
}

/** Grava as preferências e notifica os componentes montados nesta aba. */
export function savePreferences(prefs: Preferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: prefs }));
}

export interface UsePreferences {
  /** Preferências correntes — DEFAULT_PREFERENCES até `loaded` ser true */
  prefs: Preferences;
  /** false durante o primeiro render (localStorage só existe no cliente) */
  loaded: boolean;
  /** Grava uma preferência e propaga a todos os consumidores */
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  /** Repõe todos os valores padrão */
  reset: () => void;
}

/**
 * Hook de leitura/escrita das preferências.
 *
 * Telas que apenas consomem (tabelas) podem ignorar `set`/`reset` e usar só
 * `prefs`. A tela de Configurações usa a interface completa.
 */
export function usePreferences(): UsePreferences {
  const [prefs, setPrefs]   = useState<Preferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setPrefs(loadPreferences());
    setLoaded(true);

    // Alterações feitas nesta aba (CustomEvent) e noutras abas (storage nativo)
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<Preferences>).detail;
      setPrefs(detail ?? loadPreferences());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPrefs(loadPreferences());
    };

    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const set = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    // Lê do storage em vez do state para não gravar por cima de uma
    // alteração feita noutro componente entre renders.
    const next = { ...loadPreferences(), [key]: value };
    savePreferences(next);
    setPrefs(next);
  }, []);

  const reset = useCallback(() => {
    savePreferences(DEFAULT_PREFERENCES);
    setPrefs(DEFAULT_PREFERENCES);
  }, []);

  return { prefs, loaded, set, reset };
}

/**
 * Classe CSS de densidade para aplicar a `.data-table`.
 * Ver `.data-table-compact` em src/app/globals.css.
 */
export function densityClass(density: Preferences['density']): string {
  return density === 'compact' ? 'data-table-compact' : '';
}
