'use client';

/**
 * @file useCompanyProfile.ts
 * @description Perfil/marca da empresa em sessão — cabeçalho dos documentos PDF.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * O perfil traz o logótipo em data URL e é pedido por várias páginas para exportar
 * PDF, por isso fica em **cache no módulo**: uma leitura por sessão, partilhada
 * por todos os componentes. `refresh()` invalida-a depois de gravar o formulário.
 *
 * Nunca falha ruidosamente: sem permissão ou sem empresa (SUPERADMIN), devolve
 * `null` e os documentos saem com o cabeçalho de omissão em vez de rebentar.
 */

import { useState, useEffect, useCallback } from 'react';
import { adminApi, type CompanyProfile } from '@/services/api';

let cache: CompanyProfile | null | undefined;
let inflight: Promise<CompanyProfile | null> | null = null;

/** Leitura partilhada — usada também fora de React (ações de exportação). */
export async function fetchCompanyProfile(force = false): Promise<CompanyProfile | null> {
  if (!force && cache !== undefined) return cache;
  if (!force && inflight) return inflight;

  inflight = adminApi.getCompanyProfile()
    .then((profile) => { cache = profile; return profile; })
    .catch(() => { cache = null; return null; })
    .finally(() => { inflight = null; });

  return inflight;
}

/** Esquece a cache — chamar depois de gravar o perfil. */
export function invalidateCompanyProfile(): void {
  cache = undefined;
  inflight = null;
}

export interface UseCompanyProfile {
  profile: CompanyProfile | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useCompanyProfile(): UseCompanyProfile {
  const [profile, setProfile] = useState<CompanyProfile | null>(cache ?? null);
  const [loading, setLoading] = useState(cache === undefined);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    const result = await fetchCompanyProfile(force);
    setProfile(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchCompanyProfile().then((result) => {
      if (alive) { setProfile(result); setLoading(false); }
    });
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => {
    invalidateCompanyProfile();
    await load(true);
  }, [load]);

  return { profile, loading, refresh };
}
