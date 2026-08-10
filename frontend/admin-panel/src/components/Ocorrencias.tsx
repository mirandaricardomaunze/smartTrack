'use client';

/**
 * @file Ocorrencias.tsx
 * @description Fila de ocorrências com dono, prazo e histórico.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 * As vencidas aparecem primeiro — são as que ninguém pegou. Fechar pede sempre
 * um motivo, porque uma ocorrência que fecha sem explicação torna o histórico
 * inútil, e o histórico é a razão de tudo isto existir. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  OCCURRENCE_KIND_LABELS,
  OCCURRENCE_STATUS_LABELS,
  type Occurrence,
  type OccurrenceEvent,
  type OccurrenceInput,
  type OccurrenceKind,
  type OccurrencePriority,
  type OccurrenceStatus,
  type OccurrenceStats,
} from '@/services/api';
import { Button, Card, Input, Select } from '@/components/ui';

const STATUS_CLASS: Record<OccurrenceStatus, string> = {
  aberta:    'bg-amber-500/15 text-amber-300',
  em_curso:  'bg-blue-500/15 text-blue-300',
  resolvida: 'bg-emerald-500/15 text-emerald-300',
  cancelada: 'bg-slate-500/15 text-slate-300',
};

const PRIORIDADES: OccurrencePriority[] = ['low', 'normal', 'high', 'critical'];
const PRIORIDADE_LABEL: Record<OccurrencePriority, string> = {
  low: 'Baixa (7 dias)', normal: 'Normal (72 h)', high: 'Alta (24 h)', critical: 'Crítica (4 h)',
};

function vazio(): OccurrenceInput {
  return { kind: 'damage', priority: 'normal', title: '', description: '', tracking_code: '' };
}

export default function Ocorrencias() {
  const [lista, setLista] = useState<Occurrence[]>([]);
  const [stats, setStats] = useState<OccurrenceStats | null>(null);
  const [form, setForm] = useState<OccurrenceInput | null>(null);
  const [detalhe, setDetalhe] = useState<{ oc: Occurrence; historico: OccurrenceEvent[] } | null>(null);
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      const [l, s] = await Promise.all([adminApi.getOcorrencias(), adminApi.getOcorrenciasStats()]);
      setLista(l);
      setStats(s);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar as ocorrências.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const executar = async (fn: () => Promise<unknown>) => {
    setErro('');
    try {
      await fn();
      await carregar();
    } catch (e) {
      // A mensagem do servidor é a útil: diz que falta o motivo, ou que a
      // transição não é permitida.
      setErro(e instanceof Error ? e.message : 'A operação falhou.');
    }
  };

  const abrirDetalhe = async (oc: Occurrence) => {
    try {
      setDetalhe({ oc, historico: await adminApi.getOcorrenciaHistorico(oc.id) });
      setMotivo('');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar o histórico.');
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Ocorrências</h3>
          <p className="text-xs text-slate-500">
            O que tem dono, prazo e percurso registado — ao contrário da fila de exceções, que se renova sozinha.
          </p>
        </div>
        {!form && <Button size="sm" variant="secondary" onClick={() => setForm(vazio())}>Abrir ocorrência</Button>}
      </div>

      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {([
            ['Abertas', stats.abertas, 'text-amber-400'],
            ['Em curso', stats.em_curso, 'text-blue-400'],
            ['Resolvidas', stats.resolvidas, 'text-emerald-400'],
            ['Fora do prazo', stats.vencidas, stats.vencidas > 0 ? 'text-red-400' : 'text-slate-100'],
          ] as const).map(([rotulo, valor, cor]) => (
            <div key={rotulo} className="rounded-xl bg-surface-elevated p-2.5 text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">{rotulo}</p>
              <p className={`text-lg font-bold ${cor}`}>{valor}</p>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Card className="border-brand-500/20">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void executar(async () => { await adminApi.abrirOcorrencia(form); setForm(null); });
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select label="Espécie" value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as OccurrenceKind })}
                options={(Object.keys(OCCURRENCE_KIND_LABELS) as OccurrenceKind[])
                  .map((k) => ({ value: k, label: OCCURRENCE_KIND_LABELS[k] }))} />
              <Select label="Prioridade (define o prazo interno)" value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value as OccurrencePriority })}
                options={PRIORIDADES.map((p) => ({ value: p, label: PRIORIDADE_LABEL[p] }))} />
            </div>
            <Input label="Título" required value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Input label="Código de rastreio (opcional)" value={form.tracking_code ?? ''}
              onChange={(e) => setForm({ ...form, tracking_code: e.target.value })} />
            <Input label="Descrição" value={form.description ?? ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <p className="text-[11px] text-slate-500">
              O prazo é gravado na abertura e não muda se a prioridade for alterada depois.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>Cancelar</Button>
              <Button type="submit" size="sm">Abrir</Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-xs text-slate-500 py-3 text-center">A carregar...</p>
      ) : lista.length === 0 ? (
        <p className="text-xs text-slate-500 py-3 text-center">Sem ocorrências registadas.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>Código</th><th>Espécie</th><th>Título</th><th>Estado</th><th>Prazo</th><th></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((oc) => (
                <tr key={oc.id}>
                  <td className="font-mono text-xs">{oc.code}</td>
                  <td className="text-xs">{OCCURRENCE_KIND_LABELS[oc.kind]}</td>
                  <td className="text-slate-200">
                    {oc.title}
                    {oc.tracking_code && <span className="block text-[11px] font-mono text-slate-500">{oc.tracking_code}</span>}
                  </td>
                  <td>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_CLASS[oc.status]}`}>
                      {OCCURRENCE_STATUS_LABELS[oc.status]}
                    </span>
                  </td>
                  <td className="text-xs">
                    {oc.overdue
                      ? <span className="text-red-400">fora do prazo</span>
                      : <span className="text-slate-500">{oc.due_at ? new Date(oc.due_at).toLocaleDateString('pt-MZ') : '—'}</span>}
                  </td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => abrirDetalhe(oc)}>Abrir</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detalhe && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetalhe(null)}>
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-base font-bold text-slate-100">{detalhe.oc.title}</h4>
                  <p className="text-xs text-slate-400">
                    {detalhe.oc.code} · {OCCURRENCE_KIND_LABELS[detalhe.oc.kind]} · {OCCURRENCE_STATUS_LABELS[detalhe.oc.status]}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setDetalhe(null)}>Fechar</Button>
              </div>

              {detalhe.oc.description && <p className="text-xs text-slate-400">{detalhe.oc.description}</p>}

              {/* Histórico imutável: é o que responde a "esta encomenda esteve
                  três semanas parada — porquê?". */}
              <div>
                <p className="text-xs font-bold text-slate-200 mb-1">Histórico</p>
                <ul className="flex flex-col gap-1">
                  {detalhe.historico.map((h) => (
                    <li key={h.id} className="text-[11px] text-slate-400">
                      <span className="text-slate-500">{new Date(h.created_at).toLocaleString('pt-MZ')}</span>
                      {' — '}
                      {h.type === 'opened' && 'aberta'}
                      {h.type === 'transition' && `${h.from_status ?? ''} → ${h.to_status}`}
                      {h.type === 'comment' && 'comentário'}
                      {h.note && `: ${h.note}`}
                    </li>
                  ))}
                </ul>
              </div>

              {detalhe.oc.status !== 'resolvida' && detalhe.oc.status !== 'cancelada' && (
                <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
                  <Input label="Motivo (obrigatório para fechar)" value={motivo}
                    onChange={(e) => setMotivo(e.target.value)} />
                  <div className="flex justify-end gap-2">
                    {detalhe.oc.status === 'aberta' && (
                      <Button size="sm" variant="secondary"
                        onClick={() => executar(async () => {
                          await adminApi.moverOcorrencia(detalhe.oc.id, 'em_curso', motivo || undefined);
                          setDetalhe(null);
                        })}>
                        Pegar
                      </Button>
                    )}
                    <Button size="sm" disabled={!motivo.trim()}
                      onClick={() => executar(async () => {
                        await adminApi.moverOcorrencia(detalhe.oc.id, 'resolvida', motivo);
                        setDetalhe(null);
                      })}>
                      Resolver
                    </Button>
                  </div>
                </div>
              )}

              {detalhe.oc.resolution && (
                <p className="text-[11px] text-emerald-300">Resolução: {detalhe.oc.resolution}</p>
              )}
            </div>
          </Card>
        </div>
      )}
    </Card>
  );
}
