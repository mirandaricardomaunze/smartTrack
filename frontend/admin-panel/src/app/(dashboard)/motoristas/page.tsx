'use client';

/**
 * @file page.tsx
 * @description Motoristas — cadastro, indicadores e acesso à aplicação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.32 (Contas e acessos)
 *
 * Duas correções que esta página tinha de trazer:
 *   1. "Adicionar Motorista" persiste (antes só escrevia no estado do React, e o
 *      motorista desaparecia ao recarregar);
 *   2. "Criar acesso" — sem conta, o motorista existe no painel mas não entra na
 *      aplicação, e ninguém executa as entregas.
 * Também deixou de mostrar motoristas fictícios quando a API falha (§ 3.24): uma
 * falha real não pode parecer sucesso.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { adminApi, type BackendDriver, type DeliveryModalCode, type DeliveryModalSpec } from '@/services/api';
import { Button, Card, Input, Pagination, Select, StatCard, paginationMeta } from '@/components/ui';

interface DriverRow {
  id: string;
  nome: string;
  email: string;
  veiculo: string;
  placa: string;
  status: 'available' | 'on_route' | 'offline';
  pontualidade: number;
  taxaSucesso: number;
  notaCliente: number;
  totalEntregas: number;
  temAcesso: boolean;
}

const STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  available: { label: 'Disponível', badgeClass: 'badge-success' },
  on_route:  { label: 'Em rota',    badgeClass: 'badge-brand' },
  offline:   { label: 'Offline',    badgeClass: 'badge-neutral' },
};

/**
 * Opções de veículo enquanto o catálogo (§ 3.33) não chega do backend.
 * Não são a fonte de verdade — as capacidades e as cartas vêm de
 * `GET /v1/fleet/modals`; isto só evita um select vazio no primeiro render.
 */
const FALLBACK_VEHICLE_OPTIONS = [
  { value: 'MOTO', label: 'Motociclo' },
  { value: 'MOTOTRICICLO', label: 'Mototriciclo' },
  { value: 'CARRO', label: 'Carro' },
  { value: 'VAN', label: 'Van' },
  { value: 'CAMINHAO', label: 'Camião' },
];

/** Rótulos para a tabela, que é montada antes de o catálogo chegar. */
const VEHICLE_LABELS: Record<string, string> = Object.fromEntries(
  FALLBACK_VEHICLE_OPTIONS.map((option) => [option.value, option.label]),
);

const EMPTY_DRIVER = { name: '', email: '', phone: '', type: 'MOTO', plate: '', capacity_kg: '', licence_category: '' };
const EMPTY_ACCESS = { email: '', password: '' };

function toRow(driver: BackendDriver): DriverRow {
  return {
    id: driver.id,
    nome: driver.name,
    email: driver.email ?? '',
    veiculo: `${VEHICLE_LABELS[driver.vehicle?.type ?? 'MOTO'] ?? driver.vehicle?.type} (${driver.vehicle?.plate ?? ''})`,
    placa: driver.vehicle?.plate ?? '',
    status: driver.current_status,
    pontualidade: driver.performance_metrics?.punctuality ?? 100,
    taxaSucesso: driver.performance_metrics?.success_rate ?? 100,
    notaCliente: driver.performance_metrics?.customer_rating ?? 5,
    totalEntregas: driver.performance_metrics?.total_deliveries ?? 0,
    temAcesso: driver.has_access === true,
  };
}

/** Média de uma métrica, ou null quando não há de quem tirar média. */
function average(rows: DriverRow[], pick: (row: DriverRow) => number): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((total, row) => total + pick(row), 0) / rows.length;
}

export default function MotoristasPage() {
  const router = useRouter();
  const [motoristas, setMotoristas] = useState<DriverRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newDriver, setNewDriver] = useState(EMPTY_DRIVER);
  const [saving, setSaving] = useState(false);

  /** Motorista a quem se está a criar acesso. */
  const [accessFor, setAccessFor] = useState<DriverRow | null>(null);
  const [access, setAccess] = useState(EMPTY_ACCESS);

  const [selectedDriver, setSelectedDriver] = useState<DriverRow | null>(null);

  /** Catálogo de modais (§ 3.33) — capacidade e carta exigida por tipo de veículo. */
  const [modais, setModais] = useState<DeliveryModalSpec[]>([]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      setMotoristas((await adminApi.getMotoristas()).map(toRow));
    } catch (err) {
      // Sem dados de contingência (§ 3.24): mostra-se o erro e a ação de retentar.
      setError(err instanceof Error ? err.message : 'Erro ao carregar motoristas.');
      setMotoristas([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadData(); }, []);

  // O catálogo falha em silêncio de propósito: sem ele o formulário continua a
  // funcionar com as opções de reserva, e um erro aqui não tem de esconder a
  // lista de motoristas, que é o que a página existe para mostrar.
  useEffect(() => { adminApi.getDeliveryModals().then(setModais).catch(() => setModais([])); }, []);

  const modalSelecionado = useMemo(
    () => modais.find((modal) => modal.code === newDriver.type) ?? null,
    [modais, newDriver.type],
  );

  const vehicleOptions = modais.length > 0
    ? modais.map((modal) => ({ value: modal.code, label: modal.label }))
    : FALLBACK_VEHICLE_OPTIONS;

  const filteredMotoristas = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return motoristas.filter((motorista) =>
      motorista.nome.toLowerCase().includes(term)
      || motorista.veiculo.toLowerCase().includes(term)
      || motorista.placa.toLowerCase().includes(term));
  }, [motoristas, searchTerm]);

  const pageMeta = paginationMeta(filteredMotoristas.length, page, pageSize);
  const visibleMotoristas = filteredMotoristas.slice((pageMeta.currentPage - 1) * pageSize, pageMeta.currentPage * pageSize);

  const semAcesso = motoristas.filter((motorista) => !motorista.temAcesso).length;
  const notaMedia = average(motoristas, (row) => row.notaCliente);
  const sucessoMedio = average(motoristas, (row) => row.taxaSucesso);

  async function handleCreateDriver(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const created = await adminApi.createMotorista({
        name: newDriver.name,
        email: newDriver.email,
        phone: newDriver.phone || undefined,
        vehicle: {
          type: newDriver.type as DeliveryModalCode,
          plate: newDriver.plate,
          capacity_kg: newDriver.capacity_kg ? Number(newDriver.capacity_kg) : undefined,
          licence_category: newDriver.licence_category || undefined,
        },
      });
      setNewDriver(EMPTY_DRIVER);
      setIsModalOpen(false);
      setSuccess(`Motorista ${created.name} registado. Crie o acesso para ele entrar na aplicação.`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao registar o motorista.');
    } finally {
      setSaving(false);
    }
  }

  async function handleGrantAccess(event: React.FormEvent) {
    event.preventDefault();
    if (!accessFor) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const account = await adminApi.grantDriverAccess(accessFor.id, access);
      setSuccess(`Acesso criado para ${accessFor.nome} (${account.email}). Comunique a senha por um canal seguro.`);
      setAccess(EMPTY_ACCESS);
      setAccessFor(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar o acesso.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
          <span>{error}</span>
          <Button size="sm" variant="secondary" onClick={() => void loadData()}>Tentar novamente</Button>
        </div>
      )}
      {success && <div role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">{success}</div>}

      <div className="stats-grid">
        <StatCard label="Total de Motoristas" value={motoristas.length} helper={<span className="text-xs text-slate-500">Registados nesta empresa</span>} />
        <StatCard
          label="Sem acesso à aplicação"
          value={semAcesso}
          helper={<span className={`text-xs ${semAcesso > 0 ? 'text-amber-400' : 'text-slate-500'}`}>
            {semAcesso > 0 ? 'Não conseguem executar entregas' : 'Todos com acesso criado'}
          </span>}
        />
        <StatCard
          label="Avaliação Média"
          value={notaMedia === null ? '—' : `${notaMedia.toFixed(1)} / 5.0`}
          helper={<span className="text-xs text-slate-500">Média dos motoristas registados</span>}
        />
        <StatCard
          label="Sucesso na 1.ª Tentativa"
          value={sucessoMedio === null ? '—' : `${sucessoMedio.toFixed(1)}%`}
          helper={<span className="text-xs text-slate-500">Média dos indicadores registados</span>}
        />
      </div>

      <Card className="flex flex-col md:flex-row gap-4 justify-between items-center">
        <Input
          type="text"
          placeholder="Buscar motorista, veículo ou matrícula..."
          containerClassName="md:max-w-96"
          value={searchTerm}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => { setSearchTerm(event.target.value); setPage(1); }}
          rightIcon={<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>}
        />
        <Button onClick={() => setIsModalOpen(true)} variant="primary" className="w-full md:w-auto">Adicionar Motorista</Button>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <div className="col-span-full card py-12 text-center text-slate-500">A carregar motoristas...</div>
        ) : visibleMotoristas.length > 0 ? (
          visibleMotoristas.map((driver) => {
            const statusMeta = STATUS_LABELS[driver.status] ?? STATUS_LABELS.offline;
            return (
              <Card key={driver.id} className="flex flex-col justify-between hover:border-brand-500/30 transition-all duration-200">
                <div>
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-bold text-slate-100">{driver.nome}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{driver.veiculo} • <span className="font-mono">{driver.placa}</span></p>
                    </div>
                    <span className={`badge ${statusMeta.badgeClass}`}>{statusMeta.label}</span>
                  </div>

                  {!driver.temAcesso && (
                    <p className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                      Sem acesso à aplicação — não recebe rota nem registra entregas.
                    </p>
                  )}

                  <hr className="border-white/[0.06] my-4" />

                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="bg-surface-elevated rounded-xl p-2.5">
                      <span className="block text-[0.625rem] font-bold text-slate-500 uppercase tracking-widest">Pontualidade</span>
                      <span className="block text-sm font-extrabold text-brand-400 mt-1">{driver.pontualidade}%</span>
                    </div>
                    <div className="bg-surface-elevated rounded-xl p-2.5">
                      <span className="block text-[0.625rem] font-bold text-slate-500 uppercase tracking-widest">Sucesso</span>
                      <span className="block text-sm font-extrabold text-emerald-400 mt-1">{driver.taxaSucesso}%</span>
                    </div>
                    <div className="bg-surface-elevated rounded-xl p-2.5">
                      <span className="block text-[0.625rem] font-bold text-slate-500 uppercase tracking-widest">Avaliação</span>
                      <span className="block text-sm font-extrabold text-amber-400 mt-1">{driver.notaCliente.toFixed(1)} / 5</span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap justify-between items-center gap-3">
                  <span className="text-xs text-slate-500">
                    <strong className="text-slate-300">{driver.totalEntregas}</strong> entregas concluídas
                  </span>
                  <div className="flex gap-2">
                    {driver.temAcesso
                      ? <Button size="sm" onClick={() => router.push('/rotas')}>Rotas</Button>
                      : (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => { setAccessFor(driver); setAccess({ ...EMPTY_ACCESS, email: driver.email }); }}
                        >
                          Criar acesso
                        </Button>
                      )}
                    <Button size="sm" variant="ghost" onClick={() => setSelectedDriver(driver)}>Perfil</Button>
                  </div>
                </div>
              </Card>
            );
          })
        ) : (
          <div className="col-span-full card text-center py-12 text-slate-500">
            {motoristas.length === 0 ? 'Nenhum motorista registado. Comece por adicionar um.' : 'Nenhum motorista corresponde à busca.'}
          </div>
        )}
      </div>

      <Pagination
        page={pageMeta.currentPage}
        pageSize={pageSize}
        totalItems={filteredMotoristas.length}
        itemLabel="motoristas"
        onPageChange={setPage}
        onPageSizeChange={(next) => { setPageSize(next); setPage(1); }}
      />

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-100">Adicionar Motorista</h2>
              <Button onClick={() => setIsModalOpen(false)} variant="ghost" size="icon" aria-label="Fechar">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            </div>

            <form onSubmit={handleCreateDriver} className="flex flex-col gap-4">
              <Input required label="Nome completo" value={newDriver.name} onChange={(event) => setNewDriver({ ...newDriver, name: event.target.value })} />
              <Input
                required
                type="email"
                label="E-mail"
                hint="Será também o e-mail sugerido para o acesso à aplicação."
                value={newDriver.email}
                onChange={(event) => setNewDriver({ ...newDriver, email: event.target.value })}
              />
              <Input label="Telefone" placeholder="+258 8x xxx xxxx" value={newDriver.phone} onChange={(event) => setNewDriver({ ...newDriver, phone: event.target.value })} />
              <Select
                label="Veículo"
                value={newDriver.type}
                onChange={(event) => setNewDriver({ ...newDriver, type: event.target.value, licence_category: '' })}
                options={vehicleOptions}
                hint={modalSelecionado
                  ? `${modalSelecionado.operator_label} · até ${modalSelecionado.capacity_kg} kg · carta ${modalSelecionado.licence_categories.join(' ou ')}`
                  : undefined}
              />
              <Input
                required
                label="Matrícula"
                placeholder="AAA-000-MP"
                className="uppercase"
                value={newDriver.plate}
                onChange={(event) => setNewDriver({ ...newDriver, plate: event.target.value })}
              />
              <Input
                type="number"
                min={0}
                max={modalSelecionado?.capacity_kg}
                label="Capacidade (kg)"
                hint={modalSelecionado
                  ? `Em branco assume o máximo do modal (${modalSelecionado.capacity_kg} kg). Um valor maior é reduzido a esse teto.`
                  : 'Em branco assume o máximo do tipo de veículo.'}
                value={newDriver.capacity_kg}
                onChange={(event) => setNewDriver({ ...newDriver, capacity_kg: event.target.value })}
              />
              {modalSelecionado && modalSelecionado.licence_categories.length > 1 && (
                <Select
                  label="Categoria da carta"
                  value={newDriver.licence_category}
                  onChange={(event) => setNewDriver({ ...newDriver, licence_category: event.target.value })}
                  options={modalSelecionado.licence_categories.map((categoria) => ({
                    value: categoria,
                    label: `Categoria ${categoria}`,
                  }))}
                />
              )}
              <p className="text-xs text-slate-500">
                O acesso à aplicação cria-se depois, no cartão do motorista.
              </p>
              <div className="flex gap-3 justify-end mt-2">
                <Button type="button" onClick={() => setIsModalOpen(false)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={saving}>Registar motorista</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {accessFor && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Acesso à aplicação</span>
                <h2 className="text-lg font-bold text-slate-100 mt-0.5">{accessFor.nome}</h2>
              </div>
              <Button onClick={() => setAccessFor(null)} variant="ghost" size="icon" aria-label="Fechar">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            </div>

            <form onSubmit={handleGrantAccess} className="flex flex-col gap-4">
              <Input
                required
                type="email"
                label="E-mail de acesso"
                value={access.email}
                onChange={(event) => setAccess({ ...access, email: event.target.value })}
              />
              <Input
                required
                type="password"
                minLength={10}
                label="Senha inicial"
                hint="Mínimo 10 caracteres, com maiúscula, minúscula e número."
                value={access.password}
                onChange={(event) => setAccess({ ...access, password: event.target.value })}
              />
              <p className="text-xs text-slate-500">
                Com esta conta o motorista entra na aplicação e passa a receber a rota dele.
              </p>
              <div className="flex gap-3 justify-end mt-2">
                <Button type="button" onClick={() => setAccessFor(null)}>Cancelar</Button>
                <Button type="submit" variant="primary" loading={saving}>Criar acesso</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedDriver && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Ficha Operacional</span>
                <h2 className="text-xl font-extrabold text-slate-100 mt-0.5">{selectedDriver.nome}</h2>
                <p className="text-xs text-slate-500 font-mono mt-0.5">{selectedDriver.veiculo} • {selectedDriver.placa}</p>
              </div>
              <Button onClick={() => setSelectedDriver(null)} variant="ghost" size="icon" aria-label="Fechar">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-surface/50 border border-white/[0.04] rounded-2xl p-4 text-center">
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Total de Entregas</span>
                <span className="block text-2xl font-black text-slate-200 mt-1">{selectedDriver.totalEntregas}</span>
                <span className="text-[10px] text-slate-600">Acumulado logístico</span>
              </div>
              <div className="bg-surface/50 border border-white/[0.04] rounded-2xl p-4 text-center">
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Nota do Cliente</span>
                <span className="block text-2xl font-black text-amber-400 mt-1">{selectedDriver.notaCliente.toFixed(1)} / 5</span>
                <span className="text-[10px] text-slate-600">Pesquisa de satisfação</span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Indicadores de Qualidade (SLA)</h3>
              <div className="flex flex-col gap-2">
                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-300 mb-1">
                    <span>Pontualidade na Janela</span>
                    <span>{selectedDriver.pontualidade}%</span>
                  </div>
                  <div className="w-full bg-surface rounded-full h-2 overflow-hidden border border-white/5">
                    <div className="bg-brand-500 h-full rounded-full" style={{ width: `${selectedDriver.pontualidade}%` }} />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold text-slate-300 mb-1">
                    <span>Sucesso na 1ª Tentativa</span>
                    <span>{selectedDriver.taxaSucesso}%</span>
                  </div>
                  <div className="w-full bg-surface rounded-full h-2 overflow-hidden border border-white/5">
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${selectedDriver.taxaSucesso}%` }} />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end mt-4">
              <Button
                onClick={() => { setSelectedDriver(null); router.push('/rotas'); }}
                variant="primary"
                className="flex-1 sm:flex-initial"
              >Ver no Mapa GPS</Button>
              <Button onClick={() => setSelectedDriver(null)}>Fechar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
