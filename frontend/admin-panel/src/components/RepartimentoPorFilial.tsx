'use client';

/**
 * @file RepartimentoPorFilial.tsx
 * @description Operação repartida pela filial de origem.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * A LINHA "SEM FILIAL" NÃO É OMITIDA. Se as encomendas anteriores à migração
 * desaparecessem daqui, a soma das filiais não bateria com o total da empresa e
 * quem lê ficaria a achar que perdeu encomendas — ou, pior, a acreditar que uma
 * base produz menos do que produz.
 *
 * Conta pela ORIGEM e não pela localização: é a origem que responde a "quanto
 * produz cada base", e a localização mudaria a resposta a meio do trânsito.
 *
 * Não se mostra a nada quando há uma só filial: uma tabela de uma linha a
 * repetir o total da empresa é ruído. Sem emojis.
 */

import React, { useState, useEffect } from 'react';
import { adminApi, type BranchBreakdownRow } from '@/services/api';
import { Card } from '@/components/ui';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

export default function RepartimentoPorFilial({ days = 30 }: { days?: number }) {
  const [linhas, setLinhas] = useState<BranchBreakdownRow[]>([]);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    adminApi.getRepartimentoPorFilial(days)
      .then((r) => { if (vivo) setLinhas(r.branches); })
      .catch((e) => { if (vivo) setErro(e instanceof Error ? e.message : 'Falha ao repartir por filial.'); })
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, [days]);

  // Uma filial com nome não justifica a tabela; duas já contam uma história.
  const comNome = linhas.filter((l) => l.branch_id !== null);
  if (loading || erro || comNome.length < 2) return null;

  const total = linhas.reduce((s, l) => s + l.total, 0);

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-semibold text-slate-100">Por filial</h3>
        <p className="text-xs text-slate-500">
          Contado pela filial por onde a encomenda entrou, nos últimos {days} dias.
        </p>
      </div>

      <div className="table-wrapper">
        <table className="data-table data-table-compact">
          <thead>
            <tr>
              <th>Filial</th>
              <th className="text-right">Encomendas</th>
              <th className="text-right">Entregues</th>
              <th className="text-right">Insucessos</th>
              <th className="text-right">Peso</th>
              <th className="text-right">Receita</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.branch_id ?? 'sem-filial'}>
                <td className={l.branch_id ? 'text-slate-200' : 'text-slate-500'}>{l.branch_name}</td>
                <td className="text-right">{l.total}</td>
                <td className="text-right text-emerald-400">{l.delivered}</td>
                <td className="text-right">{l.failed > 0 ? <span className="text-red-400">{l.failed}</span> : '—'}</td>
                <td className="text-right font-mono text-xs text-slate-400">
                  {total > 0 ? `${((l.total / total) * 100).toFixed(0)}%` : '—'}
                </td>
                <td className="text-right font-mono text-xs">{mzn(l.revenue_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {linhas.some((l) => l.branch_id === null) && (
        <p className="text-[11px] text-slate-600">
          As encomendas sem filial são anteriores ao registo da origem. Ficam nesta lista para a soma
          continuar a bater certo com o total da empresa.
        </p>
      )}
    </Card>
  );
}
