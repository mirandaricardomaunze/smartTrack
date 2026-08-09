'use client';

/**
 * @file ContratosCliente.tsx
 * @description Contratos de um cliente — condições acordadas e situação de crédito.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 * Componente próprio e não mais um bloco dentro de `/clientes`: a página do
 * cliente já passava das 300 linhas, e o contrato tem estado, formulário e
 * carregamentos seus. Sem emojis — apenas SVG/CSS.
 *
 * O QUE MOSTRA, E PORQUÊ: além da lista, a **situação de crédito** em destaque.
 * É o número que decide se o cliente pode receber mais serviço, e sem ele quem
 * atende só descobre o problema quando a criação da encomenda é recusada.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  CONTRACT_STATUS_LABELS,
  type Contract,
  type ContractInput,
  type ContractStatus,
  type CreditStatus,
  type PricingZone,
} from '@/services/api';
import { Button, Card, Input, Select } from '@/components/ui';

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

/** Centavos → texto editável em MZN, e de volta. O utilizador escreve meticais. */
function centsToInput(cents: number): string {
  return cents ? String(cents / 100) : '';
}
function inputToCents(valor: string): number {
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

function StatusBadge({ status }: { status: ContractStatus }) {
  const classes: Record<ContractStatus, string> = {
    active:    'bg-emerald-500/15 text-emerald-300',
    draft:     'bg-slate-500/15 text-slate-300',
    suspended: 'bg-amber-500/15 text-amber-300',
    ended:     'bg-red-500/15 text-red-300',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${classes[status]}`}>
      {CONTRACT_STATUS_LABELS[status]}
    </span>
  );
}

function emptyForm(clientRefId: string): ContractInput {
  const hoje = new Date().toISOString().slice(0, 10);
  return {
    client_ref_id: clientRefId,
    code: '',
    status: 'draft',
    starts_on: hoje,
    ends_on: null,
    discount_pct: 0,
    minimum_charge_cents: 0,
    payment_terms_days: 0,
    credit_limit_cents: 0,
    zone_rates: [],
    notes: '',
  };
}

export default function ContratosCliente({ clientRefId }: { clientRefId: string }) {
  const [contratos, setContratos] = useState<Contract[]>([]);
  const [credito, setCredito] = useState<CreditStatus | null>(null);
  const [zonas, setZonas] = useState<PricingZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [form, setForm] = useState<ContractInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const carregar = useCallback(async () => {
    setLoading(true);
    setErro('');
    try {
      const [lista, cred, zs] = await Promise.all([
        adminApi.getContratos(clientRefId),
        adminApi.getCredito(clientRefId),
        adminApi.getPricingZones(true),
      ]);
      setContratos(lista);
      setCredito(cred);
      setZonas(zs);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar os contratos.');
    } finally {
      setLoading(false);
    }
  }, [clientRefId]);

  useEffect(() => { carregar(); }, [carregar]);

  const abrirNovo = () => { setEditId(null); setForm(emptyForm(clientRefId)); };
  const abrirEdicao = (c: Contract) => {
    setEditId(c.id);
    setForm({
      client_ref_id: c.client_ref_id, code: c.code, status: c.status,
      starts_on: String(c.starts_on).slice(0, 10),
      ends_on: c.ends_on ? String(c.ends_on).slice(0, 10) : null,
      discount_pct: c.discount_pct, minimum_charge_cents: c.minimum_charge_cents,
      payment_terms_days: c.payment_terms_days, credit_limit_cents: c.credit_limit_cents,
      zone_rates: c.zone_rates ?? [], notes: c.notes ?? '',
    });
  };

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setErro('');
    try {
      if (editId) await adminApi.updateContrato(editId, form);
      else await adminApi.createContrato(form);
      setForm(null);
      setEditId(null);
      await carregar();
    } catch (err) {
      // A mensagem do servidor é a útil: diz com que contrato houve sobreposição.
      setErro(err instanceof Error ? err.message : 'Não foi possível guardar o contrato.');
    } finally {
      setSaving(false);
    }
  };

  const terminar = async (c: Contract) => {
    setErro('');
    try {
      await adminApi.endContrato(c.id);
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não foi possível terminar o contrato.');
    }
  };

  const setZoneRate = (zoneCode: string, campo: 'base_cents' | 'per_kg_cents', valor: string) => {
    if (!form) return;
    const cents = inputToCents(valor);
    const outras = form.zone_rates.filter((r) => r.zone_code !== zoneCode);
    const atual = form.zone_rates.find((r) => r.zone_code === zoneCode) ?? { zone_code: zoneCode };
    const nova = { ...atual, [campo]: cents || undefined };
    // Uma linha sem nenhum valor acordado é ruído — o servidor recusa-a, e aqui
    // simplesmente não a enviamos.
    const temValor = nova.base_cents || nova.per_kg_cents || nova.included_kg;
    setForm({ ...form, zone_rates: temValor ? [...outras, nova] : outras });
  };

  const rateDe = (zoneCode: string) => form?.zone_rates.find((r) => r.zone_code === zoneCode);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-slate-200">Contratos</h3>
        {!form && <Button size="sm" variant="secondary" onClick={abrirNovo}>Novo contrato</Button>}
      </div>

      {erro && <p role="alert" className="text-xs text-red-400">{erro}</p>}

      {/* Situação de crédito — o número que decide se este cliente recebe mais serviço. */}
      {credito && credito.credit_limit_cents > 0 && (
        <div className={`rounded-xl p-3 border ${credito.ok ? 'border-white/[0.06] bg-surface-elevated' : 'border-red-500/30 bg-red-500/[0.06]'}`}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">Crédito · contrato {credito.contract_code}</p>
              <p className="text-sm text-slate-200 mt-0.5">
                {formatCurrency(credito.outstanding_cents)} em dívida de {formatCurrency(credito.credit_limit_cents)}
              </p>
            </div>
            <p className={`text-sm font-bold ${credito.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {credito.ok
                ? `${formatCurrency(credito.available_cents ?? 0)} disponível`
                : 'Limite ultrapassado — novas encomendas travadas'}
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-500 py-3 text-center">A carregar...</p>
      ) : contratos.length === 0 && !form ? (
        <p className="text-xs text-slate-500 py-3 text-center">
          Sem contratos. Este cliente paga a tabela pública.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {contratos.map((c) => (
            <div key={c.id} className="rounded-xl bg-surface-elevated p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-slate-200">{c.code}</span>
                  <StatusBadge status={c.status} />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {String(c.starts_on).slice(0, 10)} → {c.ends_on ? String(c.ends_on).slice(0, 10) : 'sem termo'}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {c.discount_pct > 0 && <>Desconto {c.discount_pct}% · </>}
                  {c.zone_rates?.length > 0 && <>{c.zone_rates.length} zona(s) negociada(s) · </>}
                  {c.payment_terms_days > 0 ? `Pagamento a ${c.payment_terms_days} dias` : 'Pronto pagamento'}
                  {c.minimum_charge_cents > 0 && <> · Mínimo {formatCurrency(c.minimum_charge_cents)}</>}
                  {c.credit_limit_cents > 0 && <> · Limite {formatCurrency(c.credit_limit_cents)}</>}
                </p>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => abrirEdicao(c)}>Editar</Button>
                {c.status !== 'ended' && (
                  <Button size="sm" variant="ghost" className="text-red-400" onClick={() => terminar(c)}>Terminar</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {form && (
        <Card className="border-brand-500/20">
          <form onSubmit={guardar} className="flex flex-col gap-3">
            <p className="text-xs font-bold text-slate-200">{editId ? 'Editar contrato' : 'Novo contrato'}</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Código" required value={form.code} placeholder="CT2026/0001"
                onChange={(e) => setForm({ ...form, code: e.target.value })} />
              <Select label="Estado" value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as ContractStatus })}
                options={(Object.keys(CONTRACT_STATUS_LABELS) as ContractStatus[])
                  .map((s) => ({ value: s, label: CONTRACT_STATUS_LABELS[s] }))} />
              <Input label="Início" type="date" required value={form.starts_on}
                onChange={(e) => setForm({ ...form, starts_on: e.target.value })} />
              <Input label="Fim (vazio = sem termo)" type="date" value={form.ends_on ?? ''}
                onChange={(e) => setForm({ ...form, ends_on: e.target.value || null })} />
              <Input label="Desconto (%)" type="number" min="0" max="100" value={String(form.discount_pct)}
                onChange={(e) => setForm({ ...form, discount_pct: Number(e.target.value) || 0 })} />
              <Input label="Prazo de pagamento (dias)" type="number" min="0" max="365" value={String(form.payment_terms_days)}
                onChange={(e) => setForm({ ...form, payment_terms_days: Number(e.target.value) || 0 })} />
              <Input label="Frete mínimo (MZN)" value={centsToInput(form.minimum_charge_cents)}
                onChange={(e) => setForm({ ...form, minimum_charge_cents: inputToCents(e.target.value) })} />
              <Input label="Limite de crédito (MZN, vazio = sem limite)" value={centsToInput(form.credit_limit_cents)}
                onChange={(e) => setForm({ ...form, credit_limit_cents: inputToCents(e.target.value) })} />
            </div>

            <div>
              <p className="text-[11px] text-slate-400 mb-1">
                Tarifas negociadas — substituem a tabela pública na zona. Deixar vazio mantém o preço público.
              </p>
              <div className="overflow-x-auto">
                <table className="data-table data-table-compact min-w-[420px]">
                  <thead><tr><th>Zona</th><th>Base (MZN)</th><th>Por kg (MZN)</th></tr></thead>
                  <tbody>
                    {zonas.map((z) => (
                      <tr key={z.code}>
                        <td className="text-xs">{z.name}</td>
                        <td>
                          <input className="input py-1 text-xs" placeholder={String(z.base_cents / 100)}
                            value={centsToInput(rateDe(z.code)?.base_cents ?? 0)}
                            onChange={(e) => setZoneRate(z.code, 'base_cents', e.target.value)} />
                        </td>
                        <td>
                          <input className="input py-1 text-xs" placeholder={String(z.per_kg_cents / 100)}
                            value={centsToInput(rateDe(z.code)?.per_kg_cents ?? 0)}
                            onChange={(e) => setZoneRate(z.code, 'per_kg_cents', e.target.value)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <Input label="Notas" value={form.notes ?? ''}
              onChange={(e) => setForm({ ...form, notes: e.target.value })} />

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setForm(null); setEditId(null); }}>Cancelar</Button>
              <Button type="submit" size="sm" disabled={saving}>{saving ? 'A guardar...' : 'Guardar'}</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
