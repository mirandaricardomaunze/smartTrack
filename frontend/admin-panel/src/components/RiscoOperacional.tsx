'use client';

/**
 * @file RiscoOperacional.tsx
 * @description O que ainda vai a tempo de ser salvo.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.47
 *
 * VEM ANTES DAS EXCEÇÕES JÁ CONSUMADAS (§ 3.39): estas ainda dão para agir, e
 * uma lista de trabalho por fazer no fim da página é uma lista que não se lê.
 *
 * CADA LINHA MOSTRA A BASE DO JUÍZO. "Atrasada" sem dizer contra o quê é uma
 * afirmação que ninguém pode contestar — e a primeira que alguém contesta é a
 * que faz a lista inteira perder o crédito.
 *
 * O bloco NÃO APARECE quando não há nada a assinalar. Um cartão a dizer "zero
 * encomendas em risco" ocupa o mesmo espaço que um problema real. Sem emojis.
 */

import React, { useState, useEffect } from 'react';
import { adminApi, type RisksResult, type RiskOrder } from '@/services/api';
import { Card } from '@/components/ui';

const BASE_LABEL: Record<string, string> = {
  sla: 'prazo acordado',
  p90: 'histórico medido',
  historico_do_estado: 'tempo normal neste estado',
  sem_historico: 'sem histórico deste estado',
};

function horas(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return v >= 48 ? `${Math.round(v / 24)} d` : `${v.toFixed(0)} h`;
}

function Linha({ o, campo }: { o: RiskOrder; campo: 'elapsed_hours' | 'hours_in_status' }) {
  return (
    <tr>
      <td className="font-mono text-xs text-slate-300">{o.tracking_code}</td>
      <td className="text-slate-400 text-xs">{o.current_status}</td>
      <td className="text-right font-mono text-xs">{horas(o[campo])}</td>
      <td className="text-right font-mono text-xs text-slate-500">{horas(o.limit_hours)}</td>
      <td className="text-right text-[11px] text-slate-500">{BASE_LABEL[o.basis ?? ''] ?? '—'}</td>
    </tr>
  );
}

function Bloco({ titulo, nota, linhas, campo, cor }: {
  titulo: string; nota: string; linhas: RiskOrder[];
  campo: 'elapsed_hours' | 'hours_in_status'; cor: string;
}) {
  if (linhas.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <h4 className={`text-xs font-semibold ${cor}`}>{titulo} · {linhas.length}</h4>
      <p className="text-[11px] text-slate-500">{nota}</p>
      <div className="table-wrapper">
        <table className="data-table data-table-compact">
          <thead>
            <tr>
              <th>Rastreio</th>
              <th>Estado</th>
              <th className="text-right">Decorrido</th>
              <th className="text-right">Limite</th>
              <th className="text-right">Base</th>
            </tr>
          </thead>
          {/* Dez chegam para agir; a lista completa está na API. */}
          <tbody>{linhas.slice(0, 10).map((o) => <Linha key={o.id} o={o} campo={campo} />)}</tbody>
        </table>
      </div>
    </div>
  );
}

export default function RiscoOperacional() {
  const [dados, setDados] = useState<RisksResult | null>(null);

  useEffect(() => {
    let vivo = true;
    // Falha em silêncio: é um bloco que acrescenta, e o painel não depende dele.
    adminApi.getRiscos().then((r) => { if (vivo) setDados(r); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  if (!dados) return null;

  const nada = dados.late.length === 0 && dados.at_risk.length === 0
    && dados.stalled.length === 0 && dados.route_deviations.length === 0;
  if (nada) return null;

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-slate-100">Em risco agora</h3>
        <p className="text-xs text-slate-500">
          Encomendas em curso que ainda dão para salvar — {dados.in_flight} em trânsito.
        </p>
      </div>

      <Bloco
        titulo="Fora do prazo" cor="text-red-400" campo="elapsed_hours" linhas={dados.late}
        nota="Já passaram o limite. A mais antiga primeiro: é por essa que se começa a telefonar."
      />
      <Bloco
        titulo="A caminho de atrasar" cor="text-amber-400" campo="elapsed_hours" linhas={dados.at_risk}
        nota="Passaram o ponto em que metade das encomendas já tinha chegado. Ainda dá para agir."
      />
      <Bloco
        titulo="Paradas" cor="text-amber-300" campo="hours_in_status" linhas={dados.stalled}
        nota="Sem se mexerem há muito mais do que é normal neste estado — o que é outro problema, não o mesmo."
      />

      {dados.route_deviations.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-slate-300">
            Rotas cumpridas fora da ordem · {dados.route_deviations.length}
          </h4>
          {/* Trânsito cortado, cliente ausente e uma recolha urgente a meio são
              motivos legítimos. Isto diz o que aconteceu; não classifica ninguém. */}
          <p className="text-[11px] text-slate-500">
            A sequência planeada não foi seguida. Pode haver bom motivo — trânsito, cliente ausente,
            recolha urgente.
          </p>
          <ul className="text-xs text-slate-400">
            {dados.route_deviations.slice(0, 5).map((r) => (
              <li key={r.route_id} className="font-mono">
                {r.route_id.slice(-8)} · {r.deviations.length} parada(s) fora da ordem
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        {dados.basis.measured_deliveries > 0
          ? `Medido sobre ${dados.basis.measured_deliveries} entregas concluídas, em ${dados.basis.predicted_segments} destino(s) com amostra suficiente.`
          : 'Ainda não há entregas concluídas suficientes para medir prazos — só se assinalam encomendas paradas.'}
        {' '}O desvio geográfico não é detetado: {dados.geographic_deviation.reason.toLowerCase()}
      </p>
    </Card>
  );
}
