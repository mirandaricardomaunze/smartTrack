'use client';

/**
 * @file page.tsx
 * @description Registo de Clientes/Remetentes — lista, criação/edição e histórico.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.12
 *
 * Contactos reutilizáveis, remetentes B2B (NUIT) e histórico de encomendas por
 * cliente (via orders.client_ref_id). Sem emojis — apenas SVG/CSS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type Client,
  type ClientStats,
  type ClientStatus,
  type ClientType,
  type CreateClientData,
} from '@/services/api';
import { Button, Card, Input, Select, PageHeader, StatCard, DataTable, Pagination } from '@/components/ui';
import ContratosCliente from '@/components/ContratosCliente';

const STATUS_PT: Record<string, string> = {
  created: 'Criado', collected: 'Coletado', in_transit: 'Em Trânsito', at_warehouse: 'No Armazém',
  awaiting_destination: 'Aguardando Destino', out_for_delivery: 'Saiu p/ Entrega',
  delivered: 'Entregue', failed: 'Insucesso', cancelled: 'Cancelado',
};

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format((cents ?? 0) / 100);
}

const EMPTY_FORM: CreateClientData = { name: '', type: 'individual', email: '', phone: '', tax_id: '', address: { city: '', state: '', country: 'MZ' }, notes: '' };

function TypeBadge({ type }: { type: ClientType }) {
  return type === 'business'
    ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300">Empresa</span>
    : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-300">Individual</span>;
}

export default function ClientesPage() {
  const [items, setItems] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | ClientStatus>('');
  const [stats, setStats] = useState<ClientStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Modal criar/editar
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [form, setForm] = useState<CreateClientData>({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Detalhe
  const [detail, setDetail] = useState<Client | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [res, s] = await Promise.all([
        adminApi.getClientes({ search: search || undefined, status: statusFilter || undefined, page, pageSize }),
        adminApi.getClienteStats().catch(() => null),
      ]);
      setItems(res.items);
      setTotal(res.total);
      setStats(s);
    } catch {
      setError('Não foi possível carregar os clientes. Confirme que o backend está a correr.');
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, page, pageSize]);

  // Debounce da pesquisa
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (c: Client) => {
    setEditing(c);
    setForm({
      name: c.name, type: c.type, email: c.email ?? '', phone: c.phone ?? '', tax_id: c.tax_id ?? '',
      address: { street: c.address?.street ?? '', city: c.address?.city ?? '', state: c.address?.state ?? '', country: c.address?.country ?? 'MZ' },
      notes: c.notes ?? '',
    });
    setFormError('');
    setFormOpen(true);
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setFormError('O nome é obrigatório.'); return; }
    setSubmitting(true);
    setFormError('');
    try {
      if (editing) await adminApi.updateCliente(editing.id, form);
      else await adminApi.createCliente(form);
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Falha ao guardar o cliente.');
    } finally {
      setSubmitting(false);
    }
  };

  const openDetail = async (c: Client) => {
    setDetailLoading(true);
    setDetail(c);
    try {
      setDetail(await adminApi.getCliente(c.id));
    } catch {
      /* mantém o resumo já disponível */
    } finally {
      setDetailLoading(false);
    }
  };

  const deactivate = async (c: Client) => {
    try {
      await adminApi.deactivateCliente(c.id);
      await load();
      if (detail?.id === c.id) setDetail({ ...detail, status: 'inactive' });
    } catch {
      setError('Falha ao desativar o cliente.');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clientes"
        description="Registo de clientes e remetentes, com contactos e histórico de encomendas."
        actions={<Button variant="primary" onClick={openCreate}>Novo Cliente</Button>}
      />

      <div className="stats-grid">
        <StatCard label="Total de clientes" value={stats?.total ?? '—'} helper="Registados no sistema" />
        <StatCard label="Ativos" value={stats?.active ?? '—'} helper="Contas ativas" />
        <StatCard label="Empresas (B2B)" value={stats?.business ?? '—'} helper="Remetentes empresariais" />
      </div>

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center gap-3">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => load()}>Tentar Novamente</Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
        <Input label="Pesquisar" placeholder="Nome, email, telefone ou NUIT" value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }} className="text-xs" containerClassName="flex-1" />
        <Select label="Estado" value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value as '' | ClientStatus); }}
          options={[{ value: '', label: 'Todos' }, { value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }]}
          className="text-xs" containerClassName="sm:w-44" />
      </div>

      <DataTable<Client>
        data={items}
        loading={loading}
        getRowKey={(c) => c.id}
        emptyTitle="Nenhum cliente encontrado"
        emptyDescription="Crie o primeiro cliente ou ajuste a pesquisa."
        columns={[
          { key: 'name', header: 'Nome', cell: (c) => (
            <div className="flex flex-col gap-1">
              <span className="font-semibold text-slate-200">{c.name}</span>
              <TypeBadge type={c.type} />
            </div>
          ) },
          { key: 'contacts', header: 'Contactos', cell: (c) => (
            <div className="flex flex-col text-xs text-slate-400">
              <span>{c.email ?? '—'}</span>
              <span className="font-mono">{c.phone ?? '—'}</span>
            </div>
          ) },
          { key: 'tax', header: 'NUIT', cell: (c) => <span className="font-mono text-xs text-slate-400">{c.tax_id ?? '—'}</span> },
          { key: 'orders', header: 'Encomendas', headerClassName: 'text-center', cellClassName: 'text-center',
            cell: (c) => <span className="font-semibold text-slate-200">{c.order_count ?? 0}</span> },
          { key: 'status', header: 'Estado', cell: (c) => c.status === 'active'
            ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Ativo</span>
            : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400">Inativo</span> },
          { key: 'actions', header: '', headerClassName: 'text-right', cellClassName: 'text-right',
            cell: (c) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => openDetail(c)}>Ver</Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>Editar</Button>
                {c.status === 'active' && <Button size="sm" variant="ghost" onClick={() => deactivate(c)} className="text-red-400">Desativar</Button>}
              </div>
            ) },
        ]}
        footer={<Pagination page={page} pageSize={pageSize} totalItems={total} itemLabel="clientes"
          onPageChange={setPage} onPageSizeChange={(s) => { setPage(1); setPageSize(s); }} />}
      />

      {/* Modal criar/editar */}
      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setFormOpen(false)}>
          <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={submitForm} className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-100">{editing ? 'Editar cliente' : 'Novo cliente'}</h2>
                <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>Fechar</Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="Nome" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="text-xs" containerClassName="sm:col-span-2" />
                <Select label="Tipo" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ClientType })}
                  options={[{ value: 'individual', label: 'Individual' }, { value: 'business', label: 'Empresa (B2B)' }]} className="text-xs" />
                <Input label="NUIT" value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} className="text-xs font-mono" />
                <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="text-xs" />
                <Input label="Telefone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="text-xs font-mono" />
                <Input label="Cidade" value={form.address?.city} onChange={(e) => setForm({ ...form, address: { ...form.address, city: e.target.value } })} className="text-xs" />
                <Input label="Província" value={form.address?.state} onChange={(e) => setForm({ ...form, address: { ...form.address, state: e.target.value } })} className="text-xs" />
                <Input label="Morada" value={form.address?.street} onChange={(e) => setForm({ ...form, address: { ...form.address, street: e.target.value } })} className="text-xs" containerClassName="sm:col-span-2" />
              </div>
              {formError && <p className="text-xs text-red-400">{formError}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={submitting}>{editing ? 'Guardar' : 'Criar'}</Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Detalhe + histórico */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-slate-100">{detail.name}</h2>
                    <TypeBadge type={detail.type} />
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{detail.email ?? 'sem email'} · <span className="font-mono">{detail.phone ?? 'sem telefone'}</span></p>
                  {detail.tax_id && <p className="text-xs text-slate-500 mt-0.5">NUIT: <span className="font-mono">{detail.tax_id}</span></p>}
                  {detail.address?.city && <p className="text-xs text-slate-500 mt-0.5">{[detail.address.street, detail.address.city, detail.address.state, detail.address.country].filter(Boolean).join(', ')}</p>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Fechar</Button>
              </div>

              {detail.order_metrics && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl bg-surface-elevated p-3 text-center">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Encomendas</p>
                    <p className="text-lg font-bold text-slate-100">{detail.order_metrics.total}</p>
                  </div>
                  <div className="rounded-xl bg-surface-elevated p-3 text-center">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Entregues</p>
                    <p className="text-lg font-bold text-emerald-400">{detail.order_metrics.delivered}</p>
                  </div>
                  <div className="rounded-xl bg-surface-elevated p-3 text-center">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wider">Valor total</p>
                    <p className="text-sm font-bold text-slate-100 mt-1">{formatCurrency(detail.order_metrics.total_value_cents)}</p>
                  </div>
                </div>
              )}

              {/* Contratos antes do histórico: a condição acordada é o que quem
                  atende precisa de ver primeiro para responder ao cliente. */}
              <div className="border-t border-white/[0.06] pt-3">
                <ContratosCliente clientRefId={detail.id} />
              </div>

              <div className="border-t border-white/[0.06] pt-3">
                <h3 className="text-sm font-bold text-slate-200 mb-2">Histórico de encomendas</h3>
                {detailLoading ? (
                  <p className="text-xs text-slate-500 py-4 text-center">A carregar...</p>
                ) : !detail.orders || detail.orders.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center">Sem encomendas ligadas a este cliente.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data-table data-table-compact min-w-[440px]">
                      <thead><tr><th>Código</th><th>Estado</th><th className="text-right">Valor</th></tr></thead>
                      <tbody>
                        {detail.orders.map((o) => (
                          <tr key={o.id}>
                            <td className="font-mono text-xs">{o.tracking_code}</td>
                            <td className="text-xs">{STATUS_PT[o.current_status] ?? o.current_status}</td>
                            <td className="text-right font-mono text-xs">{formatCurrency(o.value ?? 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t border-white/[0.06] pt-3">
                <Button variant="secondary" size="sm" onClick={() => { setDetail(null); openEdit(detail); }}>Editar</Button>
                {detail.status === 'active' && <Button variant="ghost" size="sm" className="text-red-400" onClick={() => deactivate(detail)}>Desativar</Button>}
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
