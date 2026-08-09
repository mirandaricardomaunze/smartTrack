'use client';

/**
 * @file FilaExcecoes.tsx
 * @description O que está à espera de uma decisão, do mais urgente para o menos.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.39
 *
 * Substitui a antiga lista "Requer Atenção", que só via a primeira página de
 * encomendas e só conhecia dois estados (`failed` e `awaiting_destination`).
 *
 * A ordem vem do servidor, calculada por espécie e antiguidade — uma lista por
 * ordem de chegada faz o urgente desaparecer debaixo do trivial. Cada linha leva
 * ao sítio onde se resolve: uma exceção sem destino é só um aviso. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  adminApi,
  EXCEPTION_LABELS,
  EXCEPTION_TARGET,
  type OperationsExceptions,
  type OperationExceptionKind,
} from '@/services/api';

/** Cor por espécie — as que tocam o cliente final ficam em vermelho. */
const KIND_CLASS: Record<OperationExceptionKind, string> = {
  overdue_reschedule:      'bg-red-500/15 text-red-300',
  failed_without_decision: 'bg-red-500/15 text-red-300',
  transfer_missing_items:  'bg-amber-500/15 text-amber-300',
  stale_in_transit:        'bg-amber-500/15 text-amber-300',
  credit_limit_exceeded:   'bg-indigo-500/15 text-indigo-300',
  stale_in_warehouse:      'bg-slate-500/15 text-slate-300',
};

export default function FilaExcecoes({ refreshMs }: { refreshMs?: number }) {
  const [dados, setDados] = useState<OperationsExceptions | null>(null);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    try {
      setDados(await adminApi.getOperationsExceptions());
      setErro('');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar as exceções.');
    }
  }, []);

  useEffect(() => {
    void carregar();
    if (!refreshMs) return undefined;
    const timer = setInterval(() => { void carregar(); }, refreshMs);
    return () => clearInterval(timer);
  }, [carregar, refreshMs]);

  if (erro) {
    return (
      <div className="card border-amber-500/20 bg-amber-500/[0.04] py-4">
        <p className="text-sm text-amber-300">{erro}</p>
      </div>
    );
  }

  // Sem exceções não se mostra uma caixa vazia a dizer "tudo bem": ocupa espaço
  // e treina a vista a ignorar aquele canto do ecrã.
  if (!dados || dados.total === 0) return null;

  return (
    <div className="card border-red-500/20 flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
        <h3 className="text-base font-semibold text-slate-100">À espera de uma decisão</h3>
        <span className="badge badge-error">{dados.total}</span>
      </div>

      {/* Contagem por espécie: dá o formato do problema antes de se ler linha a linha. */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(dados.counts) as OperationExceptionKind[]).map((kind) => (
          <span key={kind} className={`text-[11px] font-semibold px-2 py-1 rounded-full ${KIND_CLASS[kind]}`}>
            {EXCEPTION_LABELS[kind]}: {dados.counts[kind]}
          </span>
        ))}
      </div>

      <div className="table-wrapper">
        <table className="data-table data-table-compact">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Referência</th>
              <th>O que está a acontecer</th>
              <th className="text-right">Parada há</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {dados.exceptions.map((e) => (
              <tr key={`${e.kind}-${e.entity_id}`}>
                <td>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${KIND_CLASS[e.kind]}`}>
                    {EXCEPTION_LABELS[e.kind]}
                  </span>
                </td>
                <td className="font-mono text-xs text-slate-200">{e.label}</td>
                <td className="text-xs text-slate-400">{e.detail}</td>
                <td className="text-right text-xs text-slate-400">
                  {e.age_days > 0 ? `${e.age_days} dia(s)` : 'hoje'}
                </td>
                <td className="text-right">
                  <Link href={EXCEPTION_TARGET[e.kind]} className="text-xs text-brand-400 hover:text-brand-300">
                    Resolver
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
