'use client';

/**
 * @file DesempenhoMotoristas.tsx
 * @description Indicadores dos motoristas, medidos das encomendas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.43
 *
 * Substitui os números fixos do cadastro, que davam 100% de sucesso a toda a
 * gente para sempre. Onde não há amostra aparece `—` e não um número: este é o
 * ecrã onde se decide quem fica com as melhores rotas, e um zero sem base é uma
 * acusação. Não há avaliação do cliente porque nunca existiu recolha. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi, type DriverPerformance } from '@/services/api';
import { Card } from '@/components/ui';
import BotaoExcel from '@/components/BotaoExcel';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

/** Percentagem com cor, ou um travessão quando não há amostra. */
function Taxa({ pct, bom = 90 }: { pct: number | null; bom?: number }) {
  if (pct === null) return <span className="text-slate-500" title="Sem amostra">—</span>;
  const cor = pct >= bom ? 'text-emerald-400' : pct >= bom - 20 ? 'text-amber-400' : 'text-red-400';
  return <span className={`font-mono ${cor}`}>{pct.toFixed(1)}%</span>;
}

export default function DesempenhoMotoristas() {
  const [linhas, setLinhas] = useState<DriverPerformance[]>([]);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      setLinhas((await adminApi.getDesempenhoMotoristas()).drivers);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar o desempenho.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const semPontualidade = linhas.length > 0 && linhas.every((d) => d.punctuality_pct === null);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Desempenho</h3>
          <p className="text-xs text-slate-500">
            Calculado das encomendas atribuídas a cada motorista, não de valores guardados no cadastro.
          </p>
        </div>
        <BotaoExcel report="desempenho" />
      </div>

      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}
      {loading && <p className="text-xs text-slate-500 py-3 text-center">A calcular...</p>}

      {/* Sem prazos acordados a pontualidade não existe. Dizê-lo evita que
          alguém leia a coluna de travessões como "ninguém é pontual". */}
      {!loading && semPontualidade && (
        <p className="text-[11px] text-amber-300">
          A pontualidade fica por medir enquanto nenhuma zona tiver prazo acordado — defina-o em Tarifas (§ 3.42).
        </p>
      )}

      {!loading && (
        <div className="table-wrapper">
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>Motorista</th>
                <th className="text-right">Entregas</th>
                <th className="text-right">Sucesso</th>
                <th className="text-right">À primeira</th>
                <th className="text-right">Pontualidade</th>
                <th className="text-right">COD por acertar</th>
              </tr>
            </thead>
            <tbody>
              {linhas.length === 0 && (
                <tr><td colSpan={6} className="text-center text-xs text-slate-500 py-4">Sem motoristas registados.</td></tr>
              )}
              {linhas.map((d) => (
                <tr key={d.driver_id}>
                  <td className="text-slate-200">
                    {d.driver_name}
                    {d.sample_size === 0 && (
                      <span className="block text-[11px] text-slate-500">sem entregas concluídas</span>
                    )}
                  </td>
                  <td className="text-right">{d.deliveries}</td>
                  <td className="text-right"><Taxa pct={d.success_rate_pct} /></td>
                  <td className="text-right"><Taxa pct={d.first_attempt_rate_pct} bom={80} /></td>
                  <td className="text-right"><Taxa pct={d.punctuality_pct} /></td>
                  <td className="text-right font-mono text-xs">
                    {d.unsettled_cod_cents > 0
                      ? <span className="text-amber-400">{mzn(d.unsettled_cod_cents)}</span>
                      : <span className="text-slate-500">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        Um travessão significa que não há amostra suficiente para a medição, não que o resultado seja zero.
      </p>
    </Card>
  );
}
