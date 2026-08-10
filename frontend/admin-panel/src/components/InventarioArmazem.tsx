'use client';

/**
 * @file InventarioArmazem.tsx
 * @description Inventário, transferências entre filiais e contagens de um armazém.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * Componente próprio: a página de armazéns já passava das 800 linhas, e estas
 * três operações têm estado e leitura de código de barras seus.
 *
 * A LEITURA É POR TECLADO. O leitor de mão age como teclado e termina com
 * Enter — daí o campo auto-focado e o `onKeyDown`, o mesmo padrão do "Modo
 * leitura" que já existia (§ 3.15). Sem emojis.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  adminApi,
  type Transfer,
  type TransferStatus,
  type Reconciliation,
  type WarehouseInventory,
  type InventoryCount,
  type Warehouse,
} from '@/services/api';
import { Button, Card, Select } from '@/components/ui';

const TRANSFER_STATUS_PT: Record<TransferStatus, string> = {
  draft:      'Rascunho',
  in_transit: 'Em trânsito',
  received:   'Recebida',
  cancelled:  'Cancelada',
};

const STATUS_CLASS: Record<TransferStatus, string> = {
  draft:      'bg-slate-500/15 text-slate-300',
  in_transit: 'bg-amber-500/15 text-amber-300',
  received:   'bg-emerald-500/15 text-emerald-300',
  cancelled:  'bg-red-500/15 text-red-300',
};

/** Relatório de divergências — a mesma forma serve conferência e contagem. */
function RelatorioDivergencias({ r }: { r: Reconciliation }) {
  return (
    <div className={`rounded-xl p-3 text-xs border ${r.ok ? 'border-emerald-500/25 bg-emerald-500/[0.06]' : 'border-amber-500/30 bg-amber-500/[0.06]'}`}>
      <p className={`font-semibold ${r.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
        {r.ok
          ? `Bateu certo: ${r.found.length} conferida(s).`
          : `${r.found.length} conferida(s) · ${r.missing.length} em falta · ${r.unexpected.length} a mais`}
      </p>
      {r.missing.length > 0 && (
        <p className="text-[11px] text-slate-400 mt-1">
          Em falta: <span className="font-mono">{r.missing.join(', ')}</span>
        </p>
      )}
      {r.unexpected.length > 0 && (
        <p className="text-[11px] text-slate-400 mt-0.5">
          A mais: <span className="font-mono">{r.unexpected.join(', ')}</span>
        </p>
      )}
    </div>
  );
}

/** Campo de leitura de código de barras com foco automático. */
function CampoLeitura({ onScan, disabled, label }: { onScan: (code: string) => void; disabled?: boolean; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [valor, setValor] = useState('');

  useEffect(() => { if (!disabled) ref.current?.focus(); }, [disabled]);

  const confirmar = () => {
    const code = valor.trim().toUpperCase();
    if (!code) return;
    onScan(code);
    setValor('');
    // Devolver o foco é o que permite ler dez etiquetas seguidas sem tocar no rato.
    ref.current?.focus();
  };

  return (
    <div className="flex gap-2">
      <input
        ref={ref}
        className="input text-xs font-mono flex-1"
        placeholder={label}
        value={valor}
        disabled={disabled}
        onChange={(e) => setValor(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmar(); } }}
      />
      <Button size="sm" variant="secondary" onClick={confirmar} disabled={disabled}>Ler</Button>
    </div>
  );
}

export default function InventarioArmazem({ warehouse, warehouses, onChanged }: {
  warehouse: Warehouse;
  warehouses: Warehouse[];
  /** Chamado depois de qualquer operação que mexe na ocupação. */
  onChanged?: () => void;
}) {
  const [inv, setInv] = useState<WarehouseInventory | null>(null);
  const [transferencias, setTransferencias] = useState<Transfer[]>([]);
  const [contagens, setContagens] = useState<InventoryCount[]>([]);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);

  // Nova transferência
  const [destino, setDestino] = useState('');
  const [manifesto, setManifesto] = useState<string[]>([]);

  // Conferência de chegada
  const [aReceber, setAReceber] = useState<Transfer | null>(null);
  const [lidos, setLidos] = useState<string[]>([]);
  const [recibo, setRecibo] = useState<Reconciliation | null>(null);
  const [excesso, setExcesso] = useState(false);

  // Contagem
  const [contagemAberta, setContagemAberta] = useState<InventoryCount | null>(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      const [i, t, c] = await Promise.all([
        adminApi.getInventario(warehouse.id),
        adminApi.getTransferencias(warehouse.id),
        adminApi.getContagens(warehouse.id),
      ]);
      setInv(i);
      setTransferencias(t);
      setContagens(c);
      setContagemAberta(c.find((x) => x.status === 'open') ?? null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar o inventário.');
    } finally {
      setLoading(false);
    }
  }, [warehouse.id]);

  useEffect(() => { carregar(); }, [carregar]);

  const executar = async (fn: () => Promise<unknown>) => {
    setErro('');
    try {
      await fn();
      await carregar();
      onChanged?.();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'A operação falhou.');
    }
  };

  const criarTransferencia = () => executar(async () => {
    if (!destino || manifesto.length === 0) throw new Error('Escolha o destino e leia pelo menos uma encomenda.');
    await adminApi.criarTransferencia({ origin_id: warehouse.id, destination_id: destino, tracking_codes: manifesto });
    setManifesto([]);
  });

  const conferir = async () => {
    if (!aReceber) return;
    setErro('');
    try {
      const r = await adminApi.receberTransferencia(aReceber.id, lidos);
      setRecibo(r.reconciliation);
      setExcesso(r.over_capacity);
      setAReceber(null);
      setLidos([]);
      await carregar();
      onChanged?.();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'A conferência falhou.');
    }
  };

  const outrosArmazens = warehouses.filter((w) => w.id !== warehouse.id && w.status === 'active');

  return (
    <div className="flex flex-col gap-4">
      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}

      {/* Idade da carga parada: a ocupação diz quantas estão cá, isto diz quais
          é que não deviam estar. */}
      {inv && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-surface-elevated p-3 text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Até 3 dias</p>
            <p className="text-lg font-bold text-slate-100">{inv.buckets.fresh}</p>
          </div>
          <div className="rounded-xl bg-surface-elevated p-3 text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">4 a 7 dias</p>
            <p className="text-lg font-bold text-amber-400">{inv.buckets.aging}</p>
          </div>
          <div className="rounded-xl bg-surface-elevated p-3 text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider">Mais de 7 dias</p>
            <p className={`text-lg font-bold ${inv.buckets.stale > 0 ? 'text-red-400' : 'text-slate-100'}`}>{inv.buckets.stale}</p>
          </div>
        </div>
      )}
      {inv && inv.buckets.stale > 0 && (
        <p className="text-[11px] text-red-300">
          A mais antiga está parada há {inv.oldest_days} dias
          {inv.items[0] ? <> — <span className="font-mono">{inv.items[0].tracking_code}</span></> : null}.
        </p>
      )}

      {/* ── Transferências ── */}
      <div className="border-t border-white/[0.06] pt-3">
        <h4 className="text-sm font-bold text-slate-200 mb-2">Transferências</h4>

        {loading ? (
          <p className="text-xs text-slate-500 py-2 text-center">A carregar...</p>
        ) : transferencias.length === 0 ? (
          <p className="text-xs text-slate-500 py-2">Sem transferências ligadas a este armazém.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-3">
            {transferencias.map((t) => {
              const saida = t.origin_id === warehouse.id;
              const emFalta = t.items.filter((i) => i.status === 'missing').length;
              return (
                <div key={t.id} className="rounded-xl bg-surface-elevated p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-slate-200">{t.code}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_CLASS[t.status]}`}>
                        {TRANSFER_STATUS_PT[t.status]}
                      </span>
                      <span className="text-[10px] text-slate-500">{saida ? 'saída' : 'entrada'}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      {t.items.length} encomenda(s)
                      {emFalta > 0 && <span className="text-red-400"> · {emFalta} em falta</span>}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {t.status === 'draft' && saida && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => executar(() => adminApi.despacharTransferencia(t.id))}>Despachar</Button>
                        <Button size="sm" variant="ghost" className="text-red-400" onClick={() => executar(() => adminApi.cancelarTransferencia(t.id))}>Cancelar</Button>
                      </>
                    )}
                    {t.status === 'in_transit' && !saida && (
                      <Button size="sm" onClick={() => { setAReceber(t); setLidos([]); setRecibo(null); }}>Conferir</Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Conferência de chegada */}
        {aReceber && (
          <Card className="border-brand-500/20 mb-3">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-bold text-slate-200">
                Conferir {aReceber.code} — {aReceber.items.length} no manifesto
              </p>
              <CampoLeitura label="Ler etiqueta do que chegou" onScan={(c) => setLidos((prev) => [...new Set([...prev, c])])} />
              <p className="text-[11px] text-slate-500">{lidos.length} lida(s): <span className="font-mono">{lidos.join(', ') || '—'}</span></p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => { setAReceber(null); setLidos([]); }}>Cancelar</Button>
                <Button size="sm" onClick={conferir}>Receber e conferir</Button>
              </div>
            </div>
          </Card>
        )}

        {recibo && (
          <div className="mb-3 flex flex-col gap-2">
            <RelatorioDivergencias r={recibo} />
            {excesso && (
              <p className="text-[11px] text-amber-300">
                O armazém ficou acima da capacidade. A carga foi recebida na mesma — já cá está.
              </p>
            )}
          </div>
        )}

        {/* Nova transferência de saída */}
        {warehouse.status === 'active' && outrosArmazens.length > 0 && (
          <Card className="flex flex-col gap-2">
            <p className="text-xs font-bold text-slate-200">Nova transferência de saída</p>
            <Select label="Destino" value={destino} onChange={(e) => setDestino(e.target.value)}
              options={[{ value: '', label: 'Escolher armazém...' }, ...outrosArmazens.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))]}
              className="text-xs" />
            <CampoLeitura label="Ler etiqueta a incluir no manifesto" disabled={!destino}
              onScan={(c) => setManifesto((prev) => [...new Set([...prev, c])])} />
            <p className="text-[11px] text-slate-500">
              Manifesto ({manifesto.length}): <span className="font-mono">{manifesto.join(', ') || '—'}</span>
            </p>
            <div className="flex justify-end gap-2">
              {manifesto.length > 0 && <Button size="sm" variant="ghost" onClick={() => setManifesto([])}>Limpar</Button>}
              <Button size="sm" onClick={criarTransferencia} disabled={!destino || manifesto.length === 0}>Abrir transferência</Button>
            </div>
          </Card>
        )}
      </div>

      {/* ── Contagem ── */}
      <div className="border-t border-white/[0.06] pt-3">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h4 className="text-sm font-bold text-slate-200">Contagem de inventário</h4>
          {!contagemAberta && (
            <Button size="sm" variant="secondary" onClick={() => executar(() => adminApi.abrirContagem(warehouse.id))}>
              Abrir contagem
            </Button>
          )}
        </div>

        {contagemAberta ? (
          <Card className="flex flex-col gap-2">
            <p className="text-[11px] text-slate-400">
              Aberta com {contagemAberta.expected.length} encomenda(s) esperada(s) · {contagemAberta.scanned.length} lida(s).
              O que entrar ou sair durante a contagem não conta como divergência.
            </p>
            <CampoLeitura label="Ler etiqueta" onScan={(c) => executar(() => adminApi.lerNaContagem(contagemAberta.id, [c]))} />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => executar(() => adminApi.fecharContagem(contagemAberta.id))}>Fechar e conferir</Button>
            </div>
          </Card>
        ) : (
          <p className="text-xs text-slate-500">Sem contagem aberta.</p>
        )}

        {/* Última contagem fechada — é o relatório que interessa guardar. */}
        {contagens.filter((c) => c.status === 'closed' && c.result)[0] && (
          <div className="mt-2">
            <p className="text-[11px] text-slate-500 mb-1">
              Última contagem: {new Date(contagens.filter((c) => c.status === 'closed')[0].closed_at ?? '').toLocaleDateString('pt-MZ')}
            </p>
            <RelatorioDivergencias r={contagens.filter((c) => c.status === 'closed' && c.result)[0].result!} />
          </div>
        )}
      </div>
    </div>
  );
}
