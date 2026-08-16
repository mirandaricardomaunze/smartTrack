'use client';

/**
 * @file Rentabilidade.tsx
 * @description Margem por cliente, rota e viatura — com a cobertura declarada.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.40
 *
 * A COBERTURA VEM PRIMEIRO, antes de qualquer número. Uma margem de 40% com o
 * combustível desconhecido não é uma margem de 40% — é uma margem por cima, e
 * quem lê tem de o ver sem ter de perguntar. Um relatório de margem orienta
 * decisões de preço: se um custo em falta passar despercebido, a decisão fica
 * pior do que a que se tomava a olho, porque agora tem a autoridade de um
 * relatório. Sem emojis.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type ClientProfit,
  type RouteProfit,
  type VehicleProfit,
  type CostCoverage,
  type ReportCoverage,
} from '@/services/api';
import { Button, Card } from '@/components/ui';
import BotaoExcel from '@/components/BotaoExcel';
import AvisoCobertura from '@/components/AvisoCobertura';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

/** Margem com o sinal à vista: o prejuízo é a informação mais valiosa aqui. */
function Margem({ pct, known }: { pct: number | null; known: boolean }) {
  if (pct === null) return <span className="text-slate-500">—</span>;
  const cor = pct < 0 ? 'text-red-400' : pct < 15 ? 'text-amber-400' : 'text-emerald-400';
  return (
    <span className={`font-mono ${cor}`}>
      {pct.toFixed(1)}%
      {/* O asterisco marca a linha cujo custo está incompleto. Sem ele, uma
          margem alta por falta de dados é indistinguível de uma margem alta real. */}
      {!known && <span className="text-slate-500" title="Custo incompleto"> *</span>}
    </span>
  );
}

type Aba = 'clientes' | 'rotas' | 'viaturas';

export default function Rentabilidade() {
  const [aba, setAba] = useState<Aba>('clientes');
  const [clientes, setClientes] = useState<ClientProfit[]>([]);
  const [rotas, setRotas] = useState<RouteProfit[]>([]);
  const [viaturas, setViaturas] = useState<VehicleProfit[]>([]);
  const [cobertura, setCobertura] = useState<CostCoverage | null>(null);
  // Quanto do universo foi medido (§ 3.51) — distinto de `cobertura`, que diz
  // que PARCELAS DE CUSTO entraram na margem (§ 3.40). Duas perguntas.
  const [amostra, setAmostra] = useState<ReportCoverage | null>(null);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      if (aba === 'clientes') {
        const r = await adminApi.getRentabilidadeClientes();
        setClientes(r.clients);
        setCobertura(r.cost_coverage);
        setAmostra(r.coverage ?? null);
      } else if (aba === 'rotas') {
        const r = await adminApi.getRentabilidadeRotas();
        setRotas(r.routes);
        setCobertura(r.cost_coverage);
        setAmostra(r.coverage ?? null);
      } else {
        const r = await adminApi.getVehicleProfitability();
        setViaturas(r.vehicles);
        setCobertura(r.cost_coverage);
        setAmostra(r.coverage ?? null);
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar a rentabilidade.');
    } finally {
      setLoading(false);
    }
  }, [aba]);

  useEffect(() => { void carregar(); }, [carregar]);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-slate-100">Rentabilidade</h3>
          <p className="text-xs text-slate-500">Receita menos os custos que o sistema consegue medir.</p>
        </div>
        <div className="flex gap-1 items-center">
          {(['clientes', 'rotas', 'viaturas'] as Aba[]).map((a) => (
            <Button key={a} size="sm" variant={aba === a ? 'primary' : 'ghost'} onClick={() => setAba(a)}>
              {a[0].toUpperCase() + a.slice(1)}
            </Button>
          ))}
          {/* O ficheiro leva as três dimensões e a cobertura de custos, não só a
              aba aberta: quem exporta quer o relatório, não o ecrã (§ 3.44). */}
          <BotaoExcel report="rentabilidade" />
        </div>
      </div>

      <AvisoCobertura coverage={amostra} />

      {/* A cobertura antes dos números, sempre. */}
      {cobertura && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
          <p className="text-xs text-amber-200/90">{cobertura.caveat}</p>
          <p className="text-[11px] text-slate-500 mt-1">
            Combustível medido em {cobertura.fuel.vehicles_with_data} de {cobertura.fuel.vehicles_total} viatura(s).
            {cobertura.upkeep_cents_per_km.source === 'not_configured'
              && ' Manutenção por km não configurada (FLEET_UPKEEP_CENTS_PER_KM).'}
            {cobertura.driver_cost_per_route_cents.source === 'not_configured'
              && ' Custo de motorista por rota não configurado (FLEET_DRIVER_COST_PER_ROUTE_CENTS).'}
          </p>
        </div>
      )}

      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}
      {loading && <p className="text-xs text-slate-500 py-3 text-center">A calcular...</p>}

      {!loading && aba === 'clientes' && (
        <div className="table-wrapper">
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>Cliente</th>
                <th className="text-right">Entregas</th>
                <th className="text-right">Receita</th>
                <th className="text-right">Custo</th>
                <th className="text-right">Lucro</th>
                <th className="text-right">Margem</th>
              </tr>
            </thead>
            <tbody>
              {clientes.length === 0 && (
                <tr><td colSpan={6} className="text-center text-xs text-slate-500 py-4">Sem entregas no período.</td></tr>
              )}
              {clientes.map((c) => (
                <tr key={c.client_ref_id ?? c.client}>
                  <td className="text-slate-200">{c.client}</td>
                  <td className="text-right">{c.orders}</td>
                  <td className="text-right font-mono text-xs">{mzn(c.revenue_cents)}</td>
                  <td className="text-right font-mono text-xs">{mzn(c.cost_cents)}</td>
                  <td className="text-right font-mono text-xs">{mzn(c.profit_cents)}</td>
                  <td className="text-right"><Margem pct={c.margin_pct} known={c.cost_known} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && aba === 'rotas' && (
        <div className="table-wrapper">
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>Rota</th>
                <th>Motorista</th>
                <th className="text-right">km</th>
                <th className="text-right">Combustível</th>
                <th className="text-right">Receita</th>
                <th className="text-right">Margem</th>
              </tr>
            </thead>
            <tbody>
              {rotas.length === 0 && (
                <tr><td colSpan={6} className="text-center text-xs text-slate-500 py-4">Sem rotas no período.</td></tr>
              )}
              {rotas.map((r) => (
                <tr key={r.route_id}>
                  <td className="font-mono text-xs">{r.route_id.slice(-8)}</td>
                  <td className="text-slate-300">{r.driver_name ?? '—'}</td>
                  <td className="text-right">{r.distance_km.toFixed(1)}</td>
                  <td className="text-right font-mono text-xs">
                    {r.cost_breakdown.fuel_known
                      ? mzn(r.cost_breakdown.fuel_cents)
                      : <span className="text-slate-500">sem dados</span>}
                  </td>
                  <td className="text-right font-mono text-xs">{mzn(r.revenue_cents)}</td>
                  <td className="text-right"><Margem pct={r.margin_pct} known={r.cost_known} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && aba === 'viaturas' && (
        <div className="table-wrapper">
          <table className="data-table data-table-compact">
            <thead>
              <tr>
                <th>Matrícula</th>
                <th className="text-right">Rotas</th>
                <th className="text-right">km</th>
                <th className="text-right">Receita</th>
                <th className="text-right">Custo</th>
                <th className="text-right">Margem</th>
              </tr>
            </thead>
            <tbody>
              {viaturas.length === 0 && (
                <tr><td colSpan={6} className="text-center text-xs text-slate-500 py-4">Sem rotas no período.</td></tr>
              )}
              {viaturas.map((v) => (
                <tr key={v.plate}>
                  <td className="font-mono text-xs text-slate-200">{v.plate}</td>
                  <td className="text-right">{v.routes}</td>
                  <td className="text-right">{v.distance_km.toFixed(1)}</td>
                  <td className="text-right font-mono text-xs">{mzn(v.revenue_cents)}</td>
                  <td className="text-right font-mono text-xs">{mzn(v.cost_cents)}</td>
                  <td className="text-right"><Margem pct={v.margin_pct} known={v.cost_known} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-slate-600">
        O asterisco marca as linhas cujo custo está incompleto — a margem real é menor.
      </p>
    </Card>
  );
}
