'use client';

/**
 * @file page.tsx
 * @description Tarifação — zonas de preço (base + por kg) e simulador de orçamento.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * Valores em MZN (guardados em centavos). Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { adminApi, type PricingZone, type CreateZoneData, type DeliveryModalCode, type DeliveryModalSpec, type QuoteBreakdown, type ServiceLevel } from '@/services/api';
import { Button, Card, Input, Select, PageHeader, DataTable } from '@/components/ui';

function mzn(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

// Formulário em MZN (o utilizador escreve valores legíveis; convertemos p/ centavos).
interface ZoneForm { code: string; name: string; base: string; perKg: string; included: string; perKm: string; includedKm: string; sort: string }
// `perKm` a zero por omissão: uma zona nova não cobra distância até alguém o
// decidir. O contrário faria a primeira zona criada depois do deploy sair com
// um preço diferente de todas as outras sem ninguém dar por isso.
const EMPTY_ZONE: ZoneForm = { code: '', name: '', base: '', perKg: '', included: '1', perKm: '0', includedKm: '0', sort: '0' };

function toForm(z: PricingZone): ZoneForm {
  return {
    code: z.code, name: z.name,
    base: String(z.base_cents / 100), perKg: String(z.per_kg_cents / 100), included: String(z.included_kg),
    perKm: String((z.per_km_cents ?? 0) / 100), includedKm: String(z.included_km ?? 0),
    sort: String(z.sort_order),
  };
}

export default function TarifasPage() {
  const [zones, setZones] = useState<PricingZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PricingZone | null>(null);
  const [form, setForm] = useState<ZoneForm>({ ...EMPTY_ZONE });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Simulador
  const [simZone, setSimZone] = useState('');
  const [simWeight, setSimWeight] = useState('2.5');
  const [simService, setSimService] = useState<ServiceLevel>('normal');
  /** Vazio = sem modal: o preço fica o de base, como antes do § 3.33. */
  const [simModal, setSimModal] = useState<'' | DeliveryModalCode>('');
  // Dimensões e distância — vazias por omissão para o simulador continuar a
  // responder ao caso simples sem exigir seis campos preenchidos.
  const [simC, setSimC] = useState('');
  const [simL, setSimL] = useState('');
  const [simA, setSimA] = useState('');
  const [simKm, setSimKm] = useState('');
  const [modais, setModais] = useState<DeliveryModalSpec[]>([]);
  const [quote, setQuote] = useState<QuoteBreakdown | null>(null);
  const [quoteErr, setQuoteErr] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const list = await adminApi.getPricingZones();
      setZones(list);
      if (!simZone && list.length) setSimZone(list.find((z) => z.active)?.code ?? list[0].code);
    } catch {
      setError('Não foi possível carregar as zonas de tarifação.');
      setZones([]);
    } finally {
      setLoading(false);
    }
  }, [simZone]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setEditing(null); setForm({ ...EMPTY_ZONE }); setFormError(''); setFormOpen(true); };
  const openEdit = (z: PricingZone) => { setEditing(z); setForm(toForm(z)); setFormError(''); setFormOpen(true); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) { setFormError('Código e nome são obrigatórios.'); return; }
    setSubmitting(true);
    setFormError('');
    const payload: CreateZoneData = {
      code: form.code.trim(),
      name: form.name.trim(),
      base_cents: Math.round((parseFloat(form.base) || 0) * 100),
      per_kg_cents: Math.round((parseFloat(form.perKg) || 0) * 100),
      included_kg: parseFloat(form.included) || 0,
      per_km_cents: Math.round((parseFloat(form.perKm) || 0) * 100),
      included_km: parseFloat(form.includedKm) || 0,
      sort_order: parseInt(form.sort, 10) || 0,
    };
    try {
      if (editing) await adminApi.updatePricingZone(editing.id, payload);
      else await adminApi.createPricingZone(payload);
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Falha ao guardar a zona.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (z: PricingZone) => {
    try {
      if (z.active) await adminApi.deactivatePricingZone(z.id);
      else await adminApi.updatePricingZone(z.id, { active: true });
      await load();
    } catch {
      setError('Falha ao atualizar a zona.');
    }
  };

  const runQuote = useCallback(async () => {
    if (!simZone) { setQuote(null); return; }
    setQuoteErr('');
    try {
      setQuote(await adminApi.quotePrice({
        zone_code: simZone,
        weight_grams: Math.round((parseFloat(simWeight) || 0) * 1000),
        service: simService,
        vehicle_modal: simModal || undefined,
        // Só envia dimensões com os três lados: com dois não se calcula volume
        // nenhum, e o servidor ignora-as na mesma.
        dimensions_cm: (parseFloat(simC) > 0 && parseFloat(simL) > 0 && parseFloat(simA) > 0)
          ? { length_cm: parseFloat(simC), width_cm: parseFloat(simL), height_cm: parseFloat(simA) }
          : undefined,
        distance_km: parseFloat(simKm) > 0 ? parseFloat(simKm) : undefined,
      }));
    } catch (err) {
      setQuote(null);
      setQuoteErr(err instanceof Error ? err.message : 'Falha ao calcular.');
    }
  }, [simZone, simWeight, simService, simModal, simC, simL, simA, simKm]);

  useEffect(() => { void runQuote(); }, [runQuote]);

  useEffect(() => { adminApi.getDeliveryModals().then(setModais).catch(() => setModais([])); }, []);

  /** Rótulo de um modal para as mensagens do simulador. */
  const modalLabel = (code: string | null) => modais.find((m) => m.code === code)?.label ?? code ?? '';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tarifação"
        description="Zonas de preço (base + por kg) e simulador de orçamento."
        actions={<Button variant="primary" onClick={openCreate}>Nova Zona</Button>}
      />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        <DataTable<PricingZone>
          data={zones}
          loading={loading}
          getRowKey={(z) => z.id}
          emptyTitle="Nenhuma zona configurada"
          emptyDescription="Crie a primeira zona de tarifação."
          columns={[
            { key: 'name', header: 'Zona', cell: (z) => (
              <div className="flex flex-col">
                <span className="font-semibold text-slate-200">{z.name}</span>
                <span className="font-mono text-[11px] text-slate-500">{z.code}</span>
              </div>
            ) },
            { key: 'base', header: 'Base', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (z) => mzn(z.base_cents) },
            { key: 'perkg', header: 'Por kg', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs', cell: (z) => mzn(z.per_kg_cents) },
            { key: 'incl', header: 'Incluído', headerClassName: 'text-center', cellClassName: 'text-center text-xs', cell: (z) => `${z.included_kg} kg` },
            { key: 'perkm', header: 'Por km', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-xs',
              // Um traço e não "0,00 MZN": a zona não cobra distância, e um zero
              // formatado leva a ler que cobra e dá zero.
              cell: (z) => (z.per_km_cents ?? 0) > 0 ? `${mzn(z.per_km_cents)}${z.included_km ? ` (+${z.included_km}km)` : ''}` : '—' },
            { key: 'active', header: 'Estado', cell: (z) => z.active
              ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Ativa</span>
              : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400">Inativa</span> },
            { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right', cell: (z) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => openEdit(z)}>Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => toggleActive(z)} className={z.active ? 'text-red-400' : 'text-emerald-400'}>{z.active ? 'Desativar' : 'Ativar'}</Button>
              </div>
            ) },
          ]}
        />

        {/* Simulador */}
        <Card className="flex flex-col gap-4">
          <div>
            <h3 className="text-sm font-bold text-slate-100">Simulador de orçamento</h3>
            <p className="text-xs text-slate-500">Calcule o frete para uma zona e peso.</p>
          </div>
          <Select label="Zona" value={simZone} onChange={(e) => setSimZone(e.target.value)}
            options={zones.filter((z) => z.active).map((z) => ({ value: z.code, label: z.name }))} className="text-xs" />
          <Input label="Peso (kg)" type="number" min="0" step="0.1" value={simWeight} onChange={(e) => setSimWeight(e.target.value)} className="text-xs" />
          <Select label="Serviço" value={simService} onChange={(e) => setSimService(e.target.value as ServiceLevel)}
            options={[{ value: 'normal', label: 'Normal' }, { value: 'express', label: 'Expresso' }]} className="text-xs" />
          <Select label="Modal" value={simModal} onChange={(e) => setSimModal(e.target.value as '' | DeliveryModalCode)}
            options={[
              { value: '', label: 'Sem modal (preço de base)' },
              ...modais.map((m) => ({ value: m.code, label: `${m.label} — até ${m.capacity_kg} kg` })),
            ]} className="text-xs" />

          <div>
            <p className="text-[11px] text-slate-400 mb-1">Dimensões (cm) — só contam com os três lados</p>
            <div className="grid grid-cols-3 gap-2">
              <Input label="Comp." type="number" min="0" step="1" value={simC} onChange={(e) => setSimC(e.target.value)} className="text-xs" />
              <Input label="Larg." type="number" min="0" step="1" value={simL} onChange={(e) => setSimL(e.target.value)} className="text-xs" />
              <Input label="Alt." type="number" min="0" step="1" value={simA} onChange={(e) => setSimA(e.target.value)} className="text-xs" />
            </div>
          </div>
          <Input label="Distância (km)" type="number" min="0" step="0.1" value={simKm} onChange={(e) => setSimKm(e.target.value)} className="text-xs" />

          {quoteErr && <p className="text-xs text-red-400">{quoteErr}</p>}
          {quote && (
            <div className="rounded-xl bg-surface-elevated p-3 flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between"><span className="text-slate-400">Base</span><span className="font-mono">{mzn(quote.base_cents)}</span></div>
              <div className="flex justify-between">
                <span className="text-slate-400">
                  Peso{quote.charged_by_volume && <span className="text-amber-400"> (volumétrico)</span>}
                </span>
                <span className="font-mono">{mzn(quote.weight_cents)}</span>
              </div>
              {/* Os dois pesos lado a lado: é a resposta a "porque pago 24 kg se
                  a caixa pesa 8?", que é a pergunta mais frequente na fatura. */}
              {quote.charged_by_volume && (
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>real {(quote.weight_grams / 1000).toFixed(1)} kg · volumétrico {(quote.volumetric_grams / 1000).toFixed(1)} kg</span>
                  <span>cobra {(quote.chargeable_grams / 1000).toFixed(1)} kg</span>
                </div>
              )}
              {quote.distance_cents > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-400">Distância{quote.distance_km ? ` (${quote.distance_km} km)` : ''}</span>
                  <span className="font-mono">{mzn(quote.distance_cents)}</span>
                </div>
              )}
              {quote.service_cents > 0 && <div className="flex justify-between"><span className="text-slate-400">Serviço</span><span className="font-mono">{mzn(quote.service_cents)}</span></div>}
              {quote.modal_cents !== 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-400">{modalLabel(quote.vehicle_modal)}</span>
                  <span className="font-mono">{mzn(quote.modal_cents)}</span>
                </div>
              )}
              {quote.cod_surcharge_cents > 0 && <div className="flex justify-between"><span className="text-slate-400">Sobretaxa COD</span><span className="font-mono">{mzn(quote.cod_surcharge_cents)}</span></div>}
              <div className="flex justify-between border-t border-white/10 pt-1.5 mt-1 font-bold text-slate-100"><span>Total</span><span className="font-mono">{mzn(quote.total_cents)}</span></div>
            </div>
          )}

          {/* O peso não cabe no modal pedido: o preço é real, a entrega não é
              exequível assim. Dizer as duas coisas é mais útil do que esconder
              o orçamento ou fingir que cabe. */}
          {quote && !quote.modal_fits && (
            <p role="alert" className="text-xs text-amber-400">
              {quote.modal_reason}
              {quote.suggested_modal && ` Sugestão: ${modalLabel(quote.suggested_modal)}.`}
            </p>
          )}
          {quote && quote.modal_fits && !simModal && quote.suggested_modal && (
            <p className="text-xs text-slate-500">Modal mais económico para este peso: {modalLabel(quote.suggested_modal)}.</p>
          )}
        </Card>
      </div>

      {/* Modal criar/editar zona */}
      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setFormOpen(false)}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">{editing ? 'Editar zona' : 'Nova zona'}</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>Fechar</Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="text-xs font-mono" disabled={!!editing} placeholder="MAPUTO_CITY" />
                <Input label="Ordem" type="number" value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} className="text-xs" />
                <Input label="Nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="text-xs" containerClassName="col-span-2" />
                <Input label="Preço base (MZN)" type="number" min="0" step="0.01" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} className="text-xs" />
                <Input label="Por kg (MZN)" type="number" min="0" step="0.01" value={form.perKg} onChange={(e) => setForm({ ...form, perKg: e.target.value })} className="text-xs" />
                <Input label="Peso incluído (kg)" type="number" min="0" step="0.1" value={form.included} onChange={(e) => setForm({ ...form, included: e.target.value })} className="text-xs" containerClassName="col-span-2" />
                <Input label="Por km (MZN)" type="number" min="0" step="0.01" value={form.perKm} onChange={(e) => setForm({ ...form, perKm: e.target.value })} className="text-xs" />
                <Input label="Km incluídos" type="number" min="0" step="0.5" value={form.includedKm} onChange={(e) => setForm({ ...form, includedKm: e.target.value })} className="text-xs" />
              </div>
              <p className="text-[11px] text-slate-500 -mt-1">
                Por km a zero desliga a tarifação por distância nesta zona — é o comportamento de sempre.
                Os km incluídos evitam que a entrega ao lado do armazém saia mais cara do que a da concorrência.
              </p>
              {formError && <p className="text-xs text-red-400">{formError}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={submitting}>{editing ? 'Guardar' : 'Criar'}</Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
