'use client';

/**
 * @file DespachoAutomatico.tsx
 * @description Propõe a distribuição do dia e deixa confirmar depois de revista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.38
 *
 * DOIS PASSOS DE PROPÓSITO. Um botão que cria as rotas de uma vez pareceria
 * mais rápido e seria, na prática, uma forma de ninguém olhar: quando a proposta
 * estiver errada — e vai estar, porque o mundo tem informação que o sistema não
 * tem — a carga já saiu. O plano mostra-se, revê-se, e só então se confirma.
 *
 * O que sobra é tão importante como o que foi distribuído, e por isso aparece
 * com o mesmo destaque e com o motivo à frente. Sem emojis.
 */

import React, { useState } from 'react';
import { adminApi, type DispatchPlan } from '@/services/api';
import { Button, Card } from '@/components/ui';

export default function DespachoAutomatico({ onConfirmed }: { onConfirmed?: () => void }) {
  const [plano, setPlano] = useState<DispatchPlan | null>(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const planear = async () => {
    setOcupado(true);
    setErro('');
    try {
      setPlano(await adminApi.planearDespacho());
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível montar o plano.');
    } finally {
      setOcupado(false);
    }
  };

  const confirmar = async () => {
    if (!plano) return;
    setOcupado(true);
    setErro('');
    try {
      await adminApi.confirmarDespacho(plano);
      setPlano(null);
      onConfirmed?.();
    } catch (e) {
      // A mensagem do servidor é a útil: diz qual o veículo que não aguenta a
      // carga proposta.
      setErro(e instanceof Error ? e.message : 'Não foi possível criar as rotas.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-bold text-slate-100">Despacho automático</h3>
          <p className="text-xs text-slate-500">
            Distribui as encomendas prontas pelos motoristas disponíveis, respeitando a capacidade
            de cada veículo. Propõe — só cria as rotas depois de confirmar.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={planear} disabled={ocupado}>
          {ocupado && !plano ? 'A montar...' : 'Propor plano'}
        </Button>
      </div>

      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}

      {plano && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ['Elegíveis', plano.summary.eligible_orders],
              ['No plano', plano.summary.planned_orders],
              ['Motoristas', plano.summary.drivers_used],
              ['Por atribuir', plano.summary.unassigned],
            ].map(([rotulo, valor]) => (
              <div key={String(rotulo)} className="rounded-xl bg-surface-elevated p-2.5 text-center">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider">{rotulo}</p>
                <p className={`text-lg font-bold ${rotulo === 'Por atribuir' && Number(valor) > 0 ? 'text-amber-400' : 'text-slate-100'}`}>
                  {valor}
                </p>
              </div>
            ))}
          </div>

          {plano.routes.length === 0 ? (
            <p className="text-xs text-slate-500">Nada a distribuir com os motoristas disponíveis.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {plano.routes.map((r) => (
                <div key={r.driver_id} className="rounded-xl bg-surface-elevated p-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-xs font-semibold text-slate-200">
                      {r.driver_name} <span className="text-slate-500">· {r.vehicle_modal}</span>
                    </span>
                    <span className="text-[11px] font-mono text-slate-400">
                      {r.load_kg.toFixed(1)} / {r.capacity_kg} kg · {r.stops.length} parada(s)
                      {r.unknown_weight > 0 && (
                        <span className="text-amber-400"> · {r.unknown_weight} sem peso</span>
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1 font-mono">
                    {r.stops.map((s) => s.tracking_code).join(', ')}
                  </p>
                  {r.stops.some((s) => !s.geolocated) && (
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {r.stops.filter((s) => !s.geolocated).length} parada(s) sem coordenadas — entraram por capacidade,
                      fora do agrupamento geográfico.
                    </p>
                  )}

                  {/* Janelas incumpríveis (§ 3.48). Aparecem ANTES de a rota ser
                      aceite: descobertas depois, o motorista já saiu, e a falha
                      só se revela à porta do cliente. */}
                  {r.window_violations && r.window_violations.length > 0 && (
                    <div className="mt-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] p-2">
                      <p className="text-[11px] font-semibold text-red-300">
                        {r.window_violations.length} janela(s) que esta rota não cumpre
                      </p>
                      <ul className="mt-0.5 text-[11px] text-red-200/80">
                        {r.window_violations.slice(0, 4).map((v) => (
                          <li key={v.order_id ?? v.arrival_at} className="font-mono">
                            {v.order_id ?? 'parada'} · {Math.round(v.late_minutes / 60) >= 1
                              ? `${Math.round(v.late_minutes / 60)} h atrasada`
                              : `${v.late_minutes} min atrasada`}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[10px] text-slate-500">
                        A encomenda continua na rota — tirá-la fá-la-ia desaparecer da operação. Reveja
                        a janela com o cliente ou divida a rota.
                        {r.speed_basis === 'assumed' && ' Hora estimada com velocidade assumida, não medida.'}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* O que sobrou, com o mesmo destaque: um plano que esconde as sobras
              deixa encomendas paradas sem ninguém saber porquê. */}
          {plano.unassigned.length > 0 && (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
              <p className="text-xs font-semibold text-amber-300 mb-1">
                {plano.unassigned.length} encomenda(s) por atribuir
              </p>
              <ul className="flex flex-col gap-0.5">
                {plano.unassigned.map((u) => (
                  <li key={u.order_id} className="text-[11px] text-slate-400">
                    <span className="font-mono">{u.tracking_code}</span> — {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPlano(null)}>Descartar</Button>
            <Button size="sm" onClick={confirmar} disabled={ocupado || plano.routes.length === 0}>
              {ocupado ? 'A criar...' : `Confirmar ${plano.routes.length} rota(s)`}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
