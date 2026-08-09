'use client';

/**
 * @file FiliaisDoUtilizador.tsx
 * @description Atribuição de filiais a uma conta.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * O ECRÃ TEM DE DIZER O QUE A LISTA VAZIA SIGNIFICA. Nenhuma filial marcada
 * quer dizer "vê a empresa inteira" — o contrário do que a intuição sugere ao
 * olhar para um conjunto de caixas por marcar. Quem desmarcar todas a pensar que
 * está a fechar o acesso está, na verdade, a abri-lo.
 *
 * E tem de dizer que isto não é uma barreira de segurança: quem usar a
 * atribuição de filiais para esconder dados de um colega vai ser desmentido pelo
 * primeiro relatório que ele abrir. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi, type Branch } from '@/services/api';
import { Button } from '@/components/ui';

interface Props {
  userId: string;
  userName: string;
  onClose: () => void;
}

export default function FiliaisDoUtilizador({ userId, userName, onClose }: Props) {
  const [filiais, setFiliais] = useState<Branch[]>([]);
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);
  const [aGuardar, setAGuardar] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      const [todas, atual] = await Promise.all([
        adminApi.getFiliais(),
        adminApi.getFiliaisDoUtilizador(userId),
      ]);
      setFiliais(todas.branches);
      setEscolhidas(atual.branches);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar as filiais.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void carregar(); }, [carregar]);

  const alternar = (id: string) => {
    setEscolhidas((atual) => atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]);
  };

  const guardar = async () => {
    setAGuardar(true);
    setErro('');
    try {
      await adminApi.setFiliaisDoUtilizador(userId, escolhidas);
      onClose();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível guardar.');
    } finally {
      setAGuardar(false);
    }
  };

  const semRestricao = escolhidas.length === 0;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-surface p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-100">Filiais de {userName}</h3>
            <p className="text-xs text-slate-500">
              As filiais são os armazéns da empresa.
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>Fechar</Button>
        </div>

        {erro && <p role="alert" className="mb-3 text-xs text-red-400">{erro}</p>}
        {loading && <p className="py-6 text-center text-xs text-slate-500">A carregar...</p>}

        {!loading && filiais.length === 0 && (
          <p className="py-6 text-center text-xs text-slate-500">
            Ainda não há armazéns registados — crie-os em Armazéns para poder repartir a operação.
          </p>
        )}

        {!loading && filiais.length > 0 && (
          <div className="flex flex-col gap-2">
            {filiais.map((f) => (
              <label key={f.id}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 p-3 hover:border-white/20">
                <input
                  type="checkbox"
                  checked={escolhidas.includes(f.id)}
                  onChange={() => alternar(f.id)}
                  className="h-4 w-4 accent-brand-600"
                />
                <span>
                  <span className="block text-sm text-slate-200">{f.name}</span>
                  <span className="block text-[11px] text-slate-500">{f.code}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {/* Sem isto, quem desmarcar todas a pensar que está a fechar o acesso
            está na verdade a abri-lo. */}
        {!loading && (
          <p className={`mt-4 rounded-xl border p-3 text-[11px] ${semRestricao
            ? 'border-amber-500/20 bg-amber-500/[0.04] text-amber-200/90'
            : 'border-white/10 text-slate-400'}`}>
            {semRestricao
              ? 'Sem nenhuma filial marcada, esta conta vê a operação de toda a empresa.'
              : `Esta conta passa a ver apenas ${escolhidas.length} filial(is) — e as encomendas a caminho delas.`}
          </p>
        )}

        <p className="mt-2 text-[11px] text-slate-600">
          A filial reparte a vista da operação; não é uma barreira de segurança. Para retirar
          acesso a alguém, suspenda a conta.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={aGuardar} disabled={loading} onClick={guardar}>
            Guardar filiais
          </Button>
        </div>
      </div>
    </div>
  );
}
