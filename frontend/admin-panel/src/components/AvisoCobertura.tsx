'use client';

/**
 * @file AvisoCobertura.tsx
 * @description Diz quando um relatório mediu só parte do universo.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.51
 *
 * O backend já sabe quando truncou — e um dado honesto que ninguém vê não vale
 * mais do que o teto silencioso que veio substituir. Este é o outro metade da
 * correção.
 *
 * NÃO APARECE QUANDO NÃO HÁ TRUNCAGEM. Um aviso permanente a dizer "medido
 * sobre 340 de um teto de 2000" seria ruído que se aprende a ignorar — e no dia
 * em que passasse a importar já ninguém o lia.
 *
 * A frase vem do backend e não daqui: três ecrãs a redigirem o mesmo aviso
 * acabam com três avisos diferentes, e o que disser menos é o que alguém vai
 * acreditar. Sem emojis.
 */

import React from 'react';
import type { ReportCoverage } from '@/services/api';

export default function AvisoCobertura({ coverage }: { coverage?: ReportCoverage | null }) {
  if (!coverage?.truncated) return null;

  return (
    <p role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-2.5 text-[11px] text-amber-200/90">
      {coverage.note ?? `Medido sobre ${coverage.counted} registos. Há mais, e ficaram de fora.`}
    </p>
  );
}
