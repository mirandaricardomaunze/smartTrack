'use client';

/**
 * @file page.tsx
 * @description Ocorrências e cumprimento de SLA.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 * Página própria e não uma secção dos relatórios: as ocorrências são trabalho a
 * fazer, e trabalho a fazer não se procura dentro de um relatório. Sem emojis.
 */

import React, { useState, useEffect } from 'react';
import { adminApi, type SlaSummary } from '@/services/api';
import { PageHeader, StatCard } from '@/components/ui';
import Ocorrencias from '@/components/Ocorrencias';
import BotaoExcel from '@/components/BotaoExcel';

export default function OcorrenciasPage() {
  const [sla, setSla] = useState<SlaSummary | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    adminApi.getSlaSummary()
      .then(setSla)
      .catch((e) => setErro(e instanceof Error ? e.message : 'Falha ao carregar o SLA.'));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ocorrências e SLA"
        description="Cumprimento do prazo prometido e o que está à espera de resolução."
        actions={<BotaoExcel report="ocorrencias" />}
      />

      {erro && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
          <p className="text-sm text-amber-300">{erro}</p>
        </div>
      )}

      {sla && (
        <>
          <div className="stats-grid">
            <StatCard
              label="Cumprimento do SLA"
              value={sla.compliance_pct === null ? '—' : `${sla.compliance_pct.toFixed(1)}%`}
              helper={
                sla.compliance_pct === null
                  ? <span className="text-xs text-slate-500">Ainda sem entregas com prazo acordado</span>
                  : <span className="text-xs text-slate-500">Sobre {sla.measured} entrega(s) já decididas</span>
              }
            />
            <StatCard label="No prazo" value={String(sla.cumprido)} />
            <StatCard label="Fora do prazo" value={String(sla.incumprido)}
              helper={<span className={sla.incumprido > 0 ? 'stat-delta-down' : 'stat-delta-up'}>
                {sla.incumprido > 0 ? 'Inclui as que ainda estão a caminho' : 'Nenhum incumprimento'}
              </span>} />
            <StatCard label="Ainda dentro do prazo" value={String(sla.em_curso)} />
          </div>

          {/* Sem prazos acordados, o indicador não existe — e dizê-lo é mais
              útil do que mostrar zero. */}
          {sla.zones_with_target.with_target < sla.zones_with_target.total && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
              <p className="text-xs text-amber-200/90">
                {sla.zones_with_target.with_target} de {sla.zones_with_target.total} zonas têm prazo acordado.
                {sla.sem_prazo_acordado > 0 && ` ${sla.sem_prazo_acordado} entrega(s) ficaram fora da taxa por falta de prazo.`}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                Defina o prazo por zona em Tarifas. O prazo é uma promessa comercial — o sistema não o
                deduz do desempenho passado, porque um alvo que persegue o resultado nunca acusa falha.
              </p>
            </div>
          )}
        </>
      )}

      <Ocorrencias />
    </div>
  );
}
