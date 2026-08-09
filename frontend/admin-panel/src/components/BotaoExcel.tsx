'use client';

/**
 * @file BotaoExcel.tsx
 * @description Botão de exportação para Excel, partilhado pelos relatórios.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * O download acontece fora do ciclo do React — o browser guarda o ficheiro e a
 * página não muda. Sem um estado visível, quem carrega num relatório grande não
 * tem sinal nenhum de que algo está a acontecer e volta a carregar. Daí o
 * "A gerar..." e o botão desativado enquanto corre.
 *
 * Uma falha aqui é silenciosa por natureza (nada aparece na pasta de
 * transferências), por isso o erro é mostrado em texto e não só na consola.
 * Sem emojis.
 */

import React, { useState } from 'react';
import { adminApi, type ExcelReport } from '@/services/api';
import { Button } from '@/components/ui';

interface Props {
  report: ExcelReport;
  /** Janela do relatório, quando este a aceita. */
  params?: Record<string, string>;
  label?: string;
  disabled?: boolean;
}

export default function BotaoExcel({ report, params, label = 'Excel', disabled }: Props) {
  const [aGerar, setAGerar] = useState(false);
  const [erro, setErro] = useState('');

  const exportar = async () => {
    setAGerar(true);
    setErro('');
    try {
      await adminApi.downloadExcel(report, params);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível gerar o ficheiro.');
    } finally {
      setAGerar(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {erro && <span role="alert" className="text-[11px] text-red-400">{erro}</span>}
      <Button size="sm" variant="secondary" onClick={exportar} disabled={disabled || aGerar}>
        {aGerar ? 'A gerar...' : label}
      </Button>
    </div>
  );
}
