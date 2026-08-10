'use client';

/**
 * @file ContasAReceber.tsx
 * @description Carteira de dívida por cliente, com antiguidade.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.41
 *
 * Ordenada pelo que está mais vencido — é por essa linha que se começa a
 * telefonar, e uma tabela por ordem alfabética faz a dívida antiga desaparecer
 * no meio. Um cliente com saldo a favor aparece marcado, para ninguém lhe ligar
 * a cobrar. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  AGING_LABELS,
  type AgingBucket,
  type ReceivablesPortfolio,
  type ClientReceivables,
} from '@/services/api';
import { Button, Card } from '@/components/ui';
import BotaoExcel from '@/components/BotaoExcel';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

/** Quanto mais vencido, mais quente a cor. */
const BUCKET_CLASS: Record<AgingBucket, string> = {
  corrente:  'text-slate-300',
  d1_30:     'text-amber-300',
  d31_60:    'text-amber-400',
  d61_90:    'text-red-300',
  d90_mais:  'text-red-400',
  sem_prazo: 'text-indigo-300',
};

const ORDEM: AgingBucket[] = ['corrente', 'd1_30', 'd31_60', 'd61_90', 'd90_mais', 'sem_prazo'];

export default function ContasAReceber() {
  const [carteira, setCarteira] = useState<ReceivablesPortfolio | null>(null);
  const [detalhe, setDetalhe] = useState<ClientReceivables | null>(null);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      setCarteira(await adminApi.getContasAReceber());
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar as contas a receber.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const abrirDetalhe = async (clientRefId: string | null) => {
    if (!clientRefId) return;
    try {
      setDetalhe(await adminApi.getContasAReceberCliente(clientRefId));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar as faturas do cliente.');
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Contas a receber</h3>
          <p className="text-xs text-slate-500">
            Faturas emitidas e por pagar, com a antiguidade contada a partir do vencimento.
          </p>
        </div>
        {/* A carteira é o mapa que vai para a reunião de cobrança — com cada
            escalão na sua coluna, para poder ser ordenado e filtrado (§ 3.44). */}
        <BotaoExcel report="contas-a-receber" />
      </div>

      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}
      {loading && <p className="text-xs text-slate-500 py-3 text-center">A carregar...</p>}

      {!loading && carteira && (
        <>
          {/* Escalões primeiro: dão o formato da dívida antes de se ler cliente
              a cliente. Mostrados sempre, mesmo a zero — um escalão que
              desaparece esconde que a pergunta foi feita. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {ORDEM.map((b) => (
              <div key={b} className="rounded-xl bg-surface-elevated p-2.5 text-center">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">{AGING_LABELS[b]}</p>
                <p className={`text-sm font-bold font-mono mt-0.5 ${BUCKET_CLASS[b]}`}>
                  {mzn(carteira.totals.buckets[b] ?? 0)}
                </p>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-slate-400">
              {carteira.totals.clients} cliente(s) com saldo em aberto
            </p>
            <p className="text-sm font-bold text-slate-100 font-mono">
              Total: {mzn(carteira.totals.balance_cents)}
            </p>
          </div>

          <div className="table-wrapper">
            <table className="data-table data-table-compact">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="text-right">Faturas</th>
                  <th className="text-right">Mais vencida</th>
                  <th className="text-right">Saldo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {carteira.clients.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-xs text-slate-500 py-4">Nada por receber.</td></tr>
                )}
                {carteira.clients.map((c) => (
                  <tr key={c.client_ref_id ?? c.client_name}>
                    <td className="text-slate-200">
                      {c.client_name}
                      {c.in_credit && (
                        <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
                          saldo a favor
                        </span>
                      )}
                    </td>
                    <td className="text-right">{c.open_invoices}</td>
                    <td className="text-right text-xs">
                      {c.oldest_days_overdue > 0
                        ? <span className="text-red-400">{c.oldest_days_overdue} dia(s)</span>
                        : <span className="text-slate-500">—</span>}
                    </td>
                    <td className="text-right font-mono text-xs">{mzn(c.balance_cents)}</td>
                    <td className="text-right">
                      {c.client_ref_id && (
                        <Button size="sm" variant="ghost" onClick={() => abrirDetalhe(c.client_ref_id)}>Faturas</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {detalhe && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetalhe(null)}>
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-base font-bold text-slate-100">{detalhe.client_name}</h4>
                  <p className="text-xs text-slate-400">Saldo em aberto: {mzn(detalhe.balance_cents)}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setDetalhe(null)}>Fechar</Button>
              </div>

              <div className="table-wrapper">
                <table className="data-table data-table-compact">
                  <thead>
                    <tr><th>Fatura</th><th>Vencimento</th><th className="text-right">Atraso</th><th className="text-right">Valor</th></tr>
                  </thead>
                  <tbody>
                    {detalhe.invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="font-mono text-xs">{i.number}</td>
                        <td className="text-xs">{i.due_date ?? <span className="text-slate-500">sem prazo</span>}</td>
                        <td className={`text-right text-xs ${BUCKET_CLASS[i.bucket]}`}>
                          {i.days_overdue > 0 ? `${i.days_overdue} dia(s)` : '—'}
                        </td>
                        <td className="text-right font-mono text-xs">{mzn(i.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detalhe.credit_notes.length > 0 && (
                <p className="text-[11px] text-slate-500">
                  Abatido por nota(s) de crédito: {mzn(detalhe.credited_cents)}
                  {' '}({detalhe.credit_notes.map((n) => n.number).join(', ')}).
                </p>
              )}
            </div>
          </Card>
        </div>
      )}
    </Card>
  );
}
