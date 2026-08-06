'use client';

/**
 * @file page.tsx
 * @description Gestão dinâmica de Armazéns — entrada e envio de encomendas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 8.2 (fluxo de armazém)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (auditabilidade dos movimentos)
 *
 * Sem emojis — apenas SVG/CSS (regra do projeto).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  adminApi,
  type Warehouse,
  type WarehouseStats,
  type WarehouseMovement,
  type Order,
  type CreateWarehouseData,
} from '@/services/api';
import { Button, Card, Input, PageHeader, Pagination, Select, StatCard, paginationMeta } from '@/components/ui';

// ─── Ícones (SVG) ─────────────────────────────────────────────────────────────

function IconWarehouse({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h6" />
    </svg>
  );
}
function IconPlus({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}
function IconLocation({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}
function IconClose({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
function IconArrowIn({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14M3 4v16" />
    </svg>
  );
}
function IconArrowOut({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 8l4 4m0 0l-4 4m4-4H3m18-4v16" />
    </svg>
  );
}

// ─── Helpers de apresentação ──────────────────────────────────────────────────

function statusMeta(status: Warehouse['status']) {
  return status === 'active'
    ? { label: 'Ativo', badge: 'badge-success' }
    : { label: 'Inativo', badge: 'badge-neutral' };
}

/** Cor da barra de ocupação conforme lotação. */
function occupancyBarClass(w: Warehouse): string {
  if (w.full) return 'bg-red-500';
  if (w.nearCapacity) return 'bg-amber-500';
  return 'bg-brand-500';
}

function occupancyLabel(w: Warehouse): string {
  return w.capacity > 0 ? `${w.occupancy} / ${w.capacity}` : `${w.occupancy} · ilimitada`;
}

const EMPTY_FORM = { code: '', name: '', city: '', state: '', country: 'MZ', capacity: '', lat: '', lng: '' };

export default function ArmazensPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [stats, setStats] = useState<WarehouseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Modal criar/editar
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Painel de detalhe (inventário + movimentos)
  const [selected, setSelected] = useState<Warehouse | null>(null);
  const [detailOrders, setDetailOrders] = useState<Order[]>([]);
  const [detailMovements, setDetailMovements] = useState<WarehouseMovement[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Entrada (intake)
  const [intakeTracking, setIntakeTracking] = useState('');
  const [intakeNotes, setIntakeNotes] = useState('');
  const [intakeSubmitting, setIntakeSubmitting] = useState(false);
  const [intakeError, setIntakeError] = useState('');
  const [intakeSuccess, setIntakeSuccess] = useState('');

  // Modo de leitura (scan) — leitor de mão como entrada de teclado (spec § 3.15)
  const [scanMode, setScanMode] = useState(false);
  const [scanValue, setScanValue] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [scanLog, setScanLog] = useState<{ code: string; ok: boolean; msg: string; time: string }[]>([]);
  const scanRef = useRef<HTMLInputElement | null>(null);

  // Levantamento ao balcão (spec § 3.23)
  const [pickupTarget, setPickupTarget] = useState<Order | null>(null);
  const [pickupName, setPickupName] = useState('');
  const [pickupDocument, setPickupDocument] = useState('');
  const [pickupIsRecipient, setPickupIsRecipient] = useState(true);
  const [pickupRelationship, setPickupRelationship] = useState('');
  const [pickupAuthorization, setPickupAuthorization] = useState('');
  const [pickupOtp, setPickupOtp] = useState('');
  const [pickupCodMethod, setPickupCodMethod] = useState('CASH');
  const [pickupNotes, setPickupNotes] = useState('');
  const [pickupSubmitting, setPickupSubmitting] = useState(false);
  const [pickupError, setPickupError] = useState('');

  // Envio (dispatch)
  const [dispatchTarget, setDispatchTarget] = useState<Order | null>(null);
  const [dispatchDest, setDispatchDest] = useState('');
  const [dispatchNotes, setDispatchNotes] = useState('');
  const [dispatchSubmitting, setDispatchSubmitting] = useState(false);
  const [dispatchError, setDispatchError] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [list, statsData] = await Promise.all([
        adminApi.getArmazens(),
        adminApi.getArmazemStats().catch(() => null),
      ]);
      setWarehouses(list);
      setStats(statsData);
    } catch {
      setError('Não foi possível carregar os armazéns do servidor. Verifique a ligação e tente novamente.');
      setWarehouses([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const [orders, movements] = await Promise.all([
        adminApi.getArmazemOrders(id),
        adminApi.getArmazemMovements(id).catch(() => []),
      ]);
      setDetailOrders(orders);
      setDetailMovements(movements);
    } catch {
      setDetailOrders([]);
      setDetailMovements([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetail = (w: Warehouse) => {
    setSelected(w);
    setIntakeTracking('');
    setIntakeNotes('');
    setIntakeError('');
    setIntakeSuccess('');
    setDispatchTarget(null);
    void loadDetail(w.id);
  };

  const refreshSelected = async (id: string) => {
    await loadData();
    const fresh = await adminApi.getArmazens();
    const updated = fresh.find((w) => w.id === id) ?? null;
    if (updated) setSelected(updated);
    await loadDetail(id);
  };

  // ── Criar/editar ──────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFormError('');
    setIsFormOpen(true);
  };

  const openEdit = (w: Warehouse) => {
    setEditing(w);
    setForm({
      code: w.code,
      name: w.name,
      city: w.city,
      state: w.state,
      country: w.country,
      capacity: w.capacity ? String(w.capacity) : '',
      lat: w.gps ? String(w.gps.lat) : '',
      lng: w.gps ? String(w.gps.lng) : '',
    });
    setFormError('');
    setIsFormOpen(true);
  };

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim() || !form.city.trim()) {
      setFormError('Preencha código, nome e cidade.');
      return;
    }
    setFormSubmitting(true);
    setFormError('');
    const payload: CreateWarehouseData = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      city: form.city.trim(),
      state: form.state.trim() || undefined,
      country: form.country.trim() || undefined,
      capacity: form.capacity ? parseInt(form.capacity, 10) : 0,
      lat: form.lat ? parseFloat(form.lat) : undefined,
      lng: form.lng ? parseFloat(form.lng) : undefined,
    };
    try {
      if (editing) {
        await adminApi.updateArmazem(editing.id, payload);
      } else {
        await adminApi.createArmazem(payload);
      }
      setIsFormOpen(false);
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : 'Falha ao guardar o armazém.');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleDeactivate = async (w: Warehouse) => {
    if (!window.confirm(`Desativar o armazém "${w.name}"? Só é possível se estiver vazio.`)) return;
    try {
      await adminApi.deactivateArmazem(w.id);
      await loadData();
      if (selected?.id === w.id) setSelected(null);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Falha ao desativar o armazém.');
    }
  };

  // ── Entrada / envio ─────────────────────────────────────────────────────────

  const handleIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (!intakeTracking.trim()) { setIntakeError('Informe o código de rastreio da encomenda.'); return; }
    setIntakeSubmitting(true);
    setIntakeError('');
    setIntakeSuccess('');
    try {
      const result = await adminApi.intakeEncomenda(selected.id, {
        trackingCode: intakeTracking.trim().toUpperCase(),
        notes: intakeNotes.trim() || undefined,
      });
      setIntakeSuccess(`${result.order.trackingCode} recebida no armazém.`);
      setIntakeTracking('');
      setIntakeNotes('');
      await refreshSelected(selected.id);
    } catch (err) {
      setIntakeError(err instanceof Error && err.message ? err.message : 'Não foi possível registar a entrada.');
    } finally {
      setIntakeSubmitting(false);
    }
  };

  // Leitura rápida: cada código lido dá entrada imediata e é registado no log.
  const handleScan = async (raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!selected || !code || scanBusy) return;
    setScanBusy(true);
    setScanValue('');
    const time = new Date().toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    try {
      const result = await adminApi.intakeEncomenda(selected.id, { trackingCode: code });
      setScanLog((log) => [{ code: result.order.trackingCode, ok: true, msg: 'Entrada registada', time }, ...log].slice(0, 30));
      await refreshSelected(selected.id);
    } catch (err) {
      setScanLog((log) => [{ code, ok: false, msg: err instanceof Error && err.message ? err.message : 'Falha', time }, ...log].slice(0, 30));
    } finally {
      setScanBusy(false);
      scanRef.current?.focus();
    }
  };

  // Mantém o foco no campo de leitura enquanto o modo está ativo (para o leitor de mão).
  useEffect(() => {
    if (scanMode && selected?.status === 'active') scanRef.current?.focus();
  }, [scanMode, selected?.status, scanBusy]);

  const openPickup = (order: Order) => {
    setPickupTarget(order);
    setPickupName(order.client ?? '');
    setPickupDocument('');
    setPickupIsRecipient(true);
    setPickupRelationship('');
    setPickupAuthorization('');
    setPickupOtp('');
    setPickupCodMethod('CASH');
    setPickupNotes('');
    setPickupError('');
  };

  const handlePickup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !pickupTarget) return;
    setPickupSubmitting(true);
    setPickupError('');
    try {
      await adminApi.pickupEncomenda(selected.id, {
        orderId: pickupTarget.id,
        collector_name: pickupName.trim(),
        collector_document: pickupDocument.trim(),
        is_recipient: pickupIsRecipient,
        relationship: pickupIsRecipient ? undefined : pickupRelationship.trim(),
        authorization: pickupIsRecipient ? undefined : pickupAuthorization.trim(),
        otp: pickupOtp.trim() || undefined,
        cod_method: (pickupTarget.codAmount ?? 0) > 0 ? pickupCodMethod : undefined,
        notes: pickupNotes.trim() || undefined,
      });
      setPickupTarget(null);
      await refreshSelected(selected.id);
    } catch (err) {
      setPickupError(err instanceof Error && err.message ? err.message : 'Falha ao registar o levantamento.');
    } finally {
      setPickupSubmitting(false);
    }
  };

  const openDispatch = (order: Order) => {
    setDispatchTarget(order);
    setDispatchDest(order.destination && order.destination !== 'Destino não especificado' ? order.destination : '');
    setDispatchNotes('');
    setDispatchError('');
  };

  const handleDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !dispatchTarget) return;
    if (!dispatchDest.trim()) { setDispatchError('Informe o destino de entrega.'); return; }
    setDispatchSubmitting(true);
    setDispatchError('');
    try {
      await adminApi.dispatchEncomenda(selected.id, {
        orderId: dispatchTarget.id,
        destination: dispatchDest.trim(),
        notes: dispatchNotes.trim() || undefined,
      });
      setDispatchTarget(null);
      await refreshSelected(selected.id);
    } catch (err) {
      setDispatchError(err instanceof Error && err.message ? err.message : 'Falha ao expedir a encomenda.');
    } finally {
      setDispatchSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const pageMeta = paginationMeta(warehouses.length, page, pageSize);
  const visibleWarehouses = warehouses.slice((pageMeta.currentPage - 1) * pageSize, pageMeta.currentPage * pageSize);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Armazéns" description="Gestão dinâmica de armazéns — entrada e envio de encomendas." actions={<Button onClick={openCreate} variant="primary" leftIcon={<IconPlus />}>Novo Armazém</Button>} />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button onClick={loadData} size="sm" className="shrink-0">Tentar Novamente</Button>
        </div>
      )}

      {/* Stats */}
      <div className="stats-grid">
        <StatCard label="Total de Armazéns" value={stats ? stats.total : warehouses.length} helper={<span className="text-xs text-slate-500">Cadastro dinâmico</span>} />
        <StatCard label="Ativos" value={stats ? stats.active : warehouses.filter((w) => w.status === 'active').length} helper={<span className="text-xs text-slate-500">A operar</span>} />
        <StatCard label="Encomendas Armazenadas" value={stats ? stats.storedOrders : warehouses.reduce((sum, warehouse) => sum + warehouse.occupancy, 0)} helper={<span className="text-xs text-slate-500">Aguardando expedição</span>} />
        <StatCard label="Em Lotação" value={stats ? stats.nearCapacity : warehouses.filter((w) => w.nearCapacity).length} helper={<span className={stats && stats.nearCapacity > 0 ? 'stat-delta-down' : 'text-xs text-slate-500'}>Ocupação ≥ 90%</span>} />
      </div>

      {/* Grelha de armazéns */}
      {loading ? (
        <div className="p-8 text-center text-slate-500">Carregando armazéns...</div>
      ) : warehouses.length === 0 ? (
        <Card className="text-center py-12 text-slate-500 flex flex-col items-center gap-3">
          <IconWarehouse className="w-8 h-8 text-slate-600" />
          <p className="text-sm">Nenhum armazém cadastrado.</p>
          <Button onClick={openCreate} variant="primary" size="sm" leftIcon={<IconPlus />}>Criar o primeiro armazém</Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleWarehouses.map((w) => {
            const meta = statusMeta(w.status);
            const barWidth = w.capacity > 0 ? Math.min(100, w.utilization) : (w.occupancy > 0 ? 100 : 8);
            return (
              <Card key={w.id} className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-xl bg-brand-500/10 text-brand-400 flex items-center justify-center shrink-0">
                        <IconWarehouse className="w-4 h-4" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-sm font-bold text-slate-100 truncate">{w.name}</h3>
                        <span className="text-[10px] font-mono text-slate-500">{w.code}</span>
                      </div>
                    </div>
                  </div>
                  <span className={`badge ${meta.badge} shrink-0`}>{meta.label}</span>
                </div>

                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <IconLocation className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="truncate">{w.addressLabel}</span>
                </div>

                {/* Ocupação */}
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="text-slate-500 uppercase tracking-wider font-semibold">Ocupação</span>
                    <span className="font-semibold text-slate-300">
                      {occupancyLabel(w)}{w.capacity > 0 ? ` · ${w.utilization}%` : ''}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-overlay overflow-hidden">
                    <div className={`h-full rounded-full ${occupancyBarClass(w)} transition-all duration-300`} style={{ width: `${barWidth}%` }} />
                  </div>
                  {w.full && <p className="text-[10px] text-red-400 mt-1.5 font-semibold">Capacidade máxima atingida.</p>}
                  {!w.full && w.nearCapacity && <p className="text-[10px] text-amber-400 mt-1.5 font-semibold">Perto da lotação.</p>}
                </div>

                {/* Ações */}
                <div className="flex items-center gap-2 pt-1 mt-auto">
                  <Button onClick={() => openDetail(w)} variant="primary" size="sm" className="flex-1">Ver encomendas</Button>
                  <Button onClick={() => openEdit(w)} size="sm">Editar</Button>
                  {w.status === 'active' && (
                    <Button onClick={() => handleDeactivate(w)} variant="danger" size="sm" title="Desativar armazém">Desativar</Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {!loading && warehouses.length > 0 && <Pagination page={pageMeta.currentPage} pageSize={pageSize} totalItems={warehouses.length} itemLabel="armazéns" onPageChange={setPage} onPageSizeChange={(next) => { setPageSize(next); setPage(1); }} />}

      {/* ── Modal criar/editar ── */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-lg card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Cadastro de Armazém</span>
                <h2 className="text-lg font-bold text-slate-100 mt-0.5">{editing ? 'Editar armazém' : 'Novo armazém'}</h2>
              </div>
              <button onClick={() => setIsFormOpen(false)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar">
                <IconClose />
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">{formError}</div>
            )}

            <form onSubmit={handleSubmitForm} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Código</label>
                  <input type="text" placeholder="WH-MPT" className="input uppercase font-mono" value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} required />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Capacidade</label>
                  <input type="number" min={0} placeholder="0 = ilimitada" className="input" value={form.capacity}
                    onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Nome</label>
                <input type="text" placeholder="Armazém Central - Maputo" className="input" value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Cidade</label>
                  <input type="text" placeholder="Maputo" className="input" value={form.city}
                    onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} required />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Província/UF</label>
                  <input type="text" placeholder="MPM" className="input" value={form.state}
                    onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">País</label>
                  <input type="text" placeholder="MZ" className="input uppercase" value={form.country}
                    onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Latitude (opcional)</label>
                  <input type="number" step="any" placeholder="-25.9692" className="input font-mono" value={form.lat}
                    onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Longitude (opcional)</label>
                  <input type="number" step="any" placeholder="32.5732" className="input font-mono" value={form.lng}
                    onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))} />
                </div>
              </div>
              <span className="text-[10px] text-slate-500 -mt-1">As coordenadas dão distância real ao recalcular a rota na expedição.</span>

              <div className="flex gap-3 justify-end mt-2">
                <button type="button" onClick={() => setIsFormOpen(false)} className="btn btn-secondary" disabled={formSubmitting}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={formSubmitting}>
                  {formSubmitting ? 'A guardar...' : editing ? 'Guardar alterações' : 'Criar armazém'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Painel de detalhe (inventário + movimentos) ── */}
      {selected && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-3xl card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start">
              <div className="min-w-0">
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Armazém</span>
                <h2 className="text-xl font-extrabold text-slate-100 mt-0.5 truncate">{selected.name}</h2>
                <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                  <span className="font-mono">{selected.code}</span>
                  <span className="flex items-center gap-1"><IconLocation className="w-3 h-3" /> {selected.addressLabel}</span>
                  <span className="font-semibold text-slate-300">Ocupação: {occupancyLabel(selected)}</span>
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar">
                <IconClose />
              </button>
            </div>

            {/* Entrada rápida */}
            <div className="rounded-2xl border border-brand-500/20 bg-brand-500/[0.04] p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <IconArrowIn className="w-4 h-4 text-brand-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">Registar entrada</h3>
                </div>
                <button type="button" onClick={() => { setScanMode((v) => !v); setIntakeError(''); setIntakeSuccess(''); }}
                  disabled={selected.status !== 'active'}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40 ${scanMode ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-slate-300 hover:text-white'}`}>
                  {scanMode ? 'Sair do modo leitura' : 'Modo leitura'}
                </button>
              </div>

              {scanMode ? (
                // Leitor de mão: escreve o código e envia (Enter). Entrada imediata.
                <div className="flex flex-col gap-3">
                  <input ref={scanRef} type="text" placeholder="Aponte o leitor e dispare — ou escreva e Enter" autoComplete="off"
                    className="input h-11 uppercase font-mono text-sm" value={scanValue}
                    onChange={(e) => setScanValue(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleScan(scanValue); } }}
                    disabled={scanBusy || selected.status !== 'active'} />
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>{scanBusy ? 'A registar...' : 'Pronto para ler'}</span>
                    {scanLog.length > 0 && <button type="button" onClick={() => setScanLog([])} className="hover:text-slate-300">Limpar registo</button>}
                  </div>
                  {scanLog.length > 0 && (
                    <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
                      {scanLog.map((s, i) => (
                        <div key={i} className={`flex items-center justify-between gap-2 text-xs px-2.5 py-1.5 rounded-lg ${s.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-400'}`}>
                          <span className="font-mono truncate">{s.code}</span>
                          <span className="shrink-0 text-[11px]">{s.msg} · {s.time}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {intakeSuccess && (
                    <div className="p-2.5 mb-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs rounded-xl">{intakeSuccess}</div>
                  )}
                  {intakeError && (
                    <div className="p-2.5 mb-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">{intakeError}</div>
                  )}
                  <form onSubmit={handleIntake} className="flex flex-col sm:flex-row gap-2">
                    <input type="text" placeholder="Código de rastreio (encomenda em trânsito)" className="input h-10 uppercase font-mono flex-1"
                      value={intakeTracking} onChange={(e) => { setIntakeTracking(e.target.value.toUpperCase()); setIntakeError(''); }}
                      disabled={intakeSubmitting || selected.status !== 'active'} />
                    <input type="text" placeholder="Observação (opcional)" className="input h-10 flex-1"
                      value={intakeNotes} onChange={(e) => setIntakeNotes(e.target.value)} disabled={intakeSubmitting || selected.status !== 'active'} />
                    <button type="submit" className="btn btn-primary h-10 shrink-0" disabled={intakeSubmitting || selected.status !== 'active'}>
                      {intakeSubmitting ? 'A registar...' : 'Confirmar receção'}
                    </button>
                  </form>
                </>
              )}
              {selected.status !== 'active' && (
                <p className="text-[10px] text-amber-400 mt-2 font-semibold">Armazém inativo — não aceita entradas.</p>
              )}
            </div>

            {/* Encomendas dentro */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-2">Encomendas no armazém ({detailOrders.length})</h3>
              {detailLoading ? (
                <p className="text-xs text-slate-500 py-4 text-center">A carregar inventário...</p>
              ) : detailOrders.length === 0 ? (
                <p className="text-xs text-slate-500 py-6 text-center bg-surface/30 rounded-xl">Sem encomendas neste armazém.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {detailOrders.map((o) => (
                    <div key={o.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-surface/50 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-brand-400 font-mono truncate">{o.trackingCode}</p>
                        <p className="text-[11px] text-slate-500 truncate">{o.client} · destino: {o.destination}</p>
                      </div>
                      <button onClick={() => openPickup(o)} className="btn btn-secondary btn-sm shrink-0">
                        Levantar
                      </button>
                      <button onClick={() => openDispatch(o)} className="btn btn-primary btn-sm shrink-0 flex items-center gap-1">
                        <IconArrowOut className="w-3.5 h-3.5" /> Expedir
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Movimentos */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-2">Histórico de movimentos</h3>
              {detailMovements.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center bg-surface/30 rounded-xl">Sem movimentos registados.</p>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto pr-1">
                  {detailMovements.map((m) => (
                    <div key={m.id} className="flex items-center gap-2.5 text-xs px-3 py-2 rounded-lg bg-surface/40">
                      <span className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${m.type === 'intake' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400'}`}>
                        {m.type === 'intake' ? <IconArrowIn className="w-3.5 h-3.5" /> : <IconArrowOut className="w-3.5 h-3.5" />}
                      </span>
                      <span className="font-semibold text-slate-300">{m.type === 'intake' ? 'Entrada' : 'Envio'}</span>
                      <span className="font-mono text-brand-400 truncate">{m.trackingCode ?? m.orderId}</span>
                      <span className="text-slate-500 ml-auto whitespace-nowrap">{m.createdAt}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de expedição (envio) ── */}
      {/* Levantamento ao balcão (spec § 3.23) */}
      {pickupTarget && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPickupTarget(null)}>
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-surface p-6" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handlePickup} className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">Levantamento ao balcão</p>
                  <h2 className="text-lg font-bold text-slate-100 font-mono mt-0.5">{pickupTarget.trackingCode}</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Destinatário: {pickupTarget.client}</p>
                </div>
                <button type="button" onClick={() => setPickupTarget(null)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar">
                  <IconClose className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col gap-3">
                <Input label="Nome de quem levanta" value={pickupName} onChange={(e) => setPickupName(e.target.value)} className="text-xs" />
                <Input label="Documento de identificação" value={pickupDocument} onChange={(e) => setPickupDocument(e.target.value)} placeholder="BI, passaporte ou carta de condução" className="text-xs" />

                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={!pickupIsRecipient} onChange={(e) => setPickupIsRecipient(!e.target.checked)} className="accent-brand-500" />
                  Está a levantar em nome do destinatário
                </label>

                {!pickupIsRecipient && (
                  <>
                    <Input label="Relação com o destinatário" value={pickupRelationship} onChange={(e) => setPickupRelationship(e.target.value)} placeholder="Irmão, colega, motorista da empresa..." className="text-xs" />
                    <Input label="Como foi autorizado" value={pickupAuthorization} onChange={(e) => setPickupAuthorization(e.target.value)} placeholder="Autorização escrita, mensagem do destinatário..." className="text-xs" />
                    <p className="text-[11px] text-slate-500">
                      Fica registado quem levou e com que autorização — é o que responde mais tarde a
                      uma reclamação do destinatário.
                    </p>
                  </>
                )}

                <Input label="Código de entrega (se o cliente recebeu um)" value={pickupOtp} onChange={(e) => setPickupOtp(e.target.value)} placeholder="6 dígitos" className="text-xs font-mono" />

                {(pickupTarget.codAmount ?? 0) > 0 && (
                  <Select
                    label={`Cobrança no balcão (${new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((pickupTarget.codAmount ?? 0) / 100)})`}
                    value={pickupCodMethod}
                    onChange={(e) => setPickupCodMethod(e.target.value)}
                    options={[
                      { value: 'CASH', label: 'Numerário' },
                      { value: 'MPESA', label: 'M-Pesa' },
                      { value: 'EMOLA', label: 'eMola' },
                      { value: 'MKESH', label: 'mKesh' },
                    ]}
                    className="text-xs"
                  />
                )}

                <Input label="Observações" value={pickupNotes} onChange={(e) => setPickupNotes(e.target.value)} className="text-xs" />
              </div>

              {pickupError && <p className="text-xs text-red-400">{pickupError}</p>}

              <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-3">
                <button type="button" onClick={() => setPickupTarget(null)} className="btn btn-secondary btn-sm">Cancelar</button>
                <button type="submit" disabled={pickupSubmitting} className="btn btn-primary btn-sm">
                  {pickupSubmitting ? 'A registar...' : 'Entregar ao cliente'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dispatchTarget && selected && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[60] animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Expedir do armazém</span>
                <h2 className="text-lg font-bold text-slate-100 font-mono mt-0.5">{dispatchTarget.trackingCode}</h2>
              </div>
              <button onClick={() => setDispatchTarget(null)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar">
                <IconClose />
              </button>
            </div>

            {dispatchError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl text-center">{dispatchError}</div>
            )}

            <form onSubmit={handleDispatch} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Destino de entrega</label>
                <input type="text" placeholder="Cidade - UF" className="input" value={dispatchDest}
                  onChange={(e) => setDispatchDest(e.target.value)} required />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Observação (opcional)</label>
                <input type="text" placeholder="Ex.: Entregar no período da manhã" className="input" value={dispatchNotes}
                  onChange={(e) => setDispatchNotes(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 mt-1">
                <button type="button" onClick={() => setDispatchTarget(null)} className="btn btn-secondary" disabled={dispatchSubmitting}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={dispatchSubmitting}>
                  {dispatchSubmitting ? 'A expedir...' : 'Confirmar envio'}
                </button>
              </div>
            </form>
            <p className="text-[10px] text-slate-600 leading-relaxed">
              A encomenda passa a <strong className="text-slate-400">Saiu para Entrega</strong>, liberta a ocupação do armazém e a rota é recalculada (spec § 8.2).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
