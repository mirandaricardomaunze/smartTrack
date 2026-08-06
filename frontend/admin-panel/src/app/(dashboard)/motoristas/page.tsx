'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { adminApi } from '@/services/api';
import { Button, Card, Input, Pagination, Select, StatCard, paginationMeta } from '@/components/ui';

interface MotoristaMock {
  id: string;
  nome: string;
  veiculo: string;
  placa: string;
  status: 'available' | 'on_route' | 'offline';
  pontualidade: number;      // 0-100
  taxaSucesso: number;       // 0-100
  notaCliente: number;       // 1-5
  totalEntregas: number;
}

const MOCK_MOTORISTAS: MotoristaMock[] = [
  { id: '1', nome: 'Marcos Souza', veiculo: 'Moto (Honda Cargo)', placa: 'TST-1234', status: 'on_route', pontualidade: 96, taxaSucesso: 98, notaCliente: 4.9, totalEntregas: 142 },
  { id: '2', nome: 'Pedro Santos', veiculo: 'Van (Peugeot Partner)', placa: 'TST-5678', status: 'available', pontualidade: 92, taxaSucesso: 95, notaCliente: 4.7, totalEntregas: 88 },
  { id: '3', nome: 'Lucas Lima', veiculo: 'Carro (Fiorino)', placa: 'TST-9012', status: 'available', pontualidade: 98, taxaSucesso: 100, notaCliente: 5.0, totalEntregas: 210 },
  { id: '4', nome: 'Roberto Alves', veiculo: 'Moto (Yamaha Factor)', placa: 'TST-3456', status: 'offline', pontualidade: 85, taxaSucesso: 90, notaCliente: 4.2, totalEntregas: 54 },
];

const STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  available: { label: 'Disponível', badgeClass: 'badge-success' },
  on_route:  { label: 'Em rota',    badgeClass: 'badge-brand' },
  offline:   { label: 'Offline',    badgeClass: 'badge-neutral' },
};

export default function MotoristasPage() {
  const router = useRouter();
  const [motoristas, setMotoristas] = useState<MotoristaMock[]>(MOCK_MOTORISTAS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await adminApi.getMotoristas();
      
      const mapped = data.map((d): MotoristaMock => ({
        id: d.id,
        nome: d.name,
        veiculo: `${d.vehicle?.type || 'Moto'} (${d.vehicle?.plate || ''})`,
        placa: d.vehicle?.plate || '',
        status: d.current_status as any,
        pontualidade: d.performance_metrics?.punctuality ?? 100,
        taxaSucesso: d.performance_metrics?.success_rate ?? 100,
        notaCliente: d.performance_metrics?.customer_rating ?? 5.0,
        totalEntregas: d.performance_metrics?.total_deliveries ?? 0,
      }));
      
      setMotoristas(mapped);
    } catch (err) {
      setError('Erro ao carregar motoristas do servidor. Exibindo dados locais de contingência.');
      setMotoristas(MOCK_MOTORISTAS);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  // Creation Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newDriverNome, setNewDriverNome] = useState('');
  const [newDriverVeiculo, setNewDriverVeiculo] = useState('Moto');
  const [newDriverPlaca, setNewDriverPlaca] = useState('');

  // Detail Modal State
  const [selectedDriver, setSelectedDriver] = useState<MotoristaMock | null>(null);

  const filteredMotoristas = motoristas.filter((motorista: MotoristaMock) =>
    motorista.nome.toLowerCase().includes(searchTerm.toLowerCase()) ||
    motorista.veiculo.toLowerCase().includes(searchTerm.toLowerCase()) ||
    motorista.placa.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const pageMeta = paginationMeta(filteredMotoristas.length, page, pageSize);
  const visibleMotoristas = filteredMotoristas.slice((pageMeta.currentPage - 1) * pageSize, pageMeta.currentPage * pageSize);

  const handleCreateDriver = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDriverNome || !newDriverPlaca) return;

    const newDriver: MotoristaMock = {
      id: String(motoristas.length + 1),
      nome: newDriverNome,
      veiculo: newDriverVeiculo,
      placa: newDriverPlaca.toUpperCase(),
      status: 'available',
      pontualidade: 100,
      taxaSucesso: 100,
      notaCliente: 5.0,
      totalEntregas: 0,
    };

    setMotoristas(prev => [newDriver, ...prev]);
    setNewDriverNome('');
    setNewDriverPlaca('');
    setIsModalOpen(false);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Stats Cards */}
      <div className="stats-grid">
        <StatCard label="Total de Motoristas" value={motoristas.length} helper={<span className="text-xs text-slate-500">Cadastrados na plataforma</span>} />
        <StatCard label="Ativos Agora" value={motoristas.filter((m: MotoristaMock) => m.status !== 'offline').length} helper={<span className="text-xs text-emerald-400">Online no app do motorista</span>} />
        <StatCard label="Avaliação Média" value="4.8 / 5.0" helper={<span className="stat-delta-up">↑ Excelente satisfação</span>} />
        <StatCard label="Taxa de Conclusão" value="95.7%" helper={<span className="text-xs text-slate-500">Dentro da janela planejada</span>} />
      </div>

      {/* Controls */}
      <Card className="flex flex-col md:flex-row gap-4 justify-between items-center">
          <Input
            type="text"
            placeholder="Buscar motorista, veículo ou placa..."
            containerClassName="md:max-w-96"
            value={searchTerm}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setSearchTerm(e.target.value); setPage(1); }}
            rightIcon={<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>}
          />

        <Button onClick={() => setIsModalOpen(true)} variant="primary" className="w-full md:w-auto">Adicionar Motorista</Button>
      </Card>

      {/* Drivers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {visibleMotoristas.length > 0 ? (
          visibleMotoristas.map((driver) => {
            const statusMeta = STATUS_LABELS[driver.status];
            return (
              <Card key={driver.id} className="flex flex-col justify-between hover:border-brand-500/30 transition-all duration-200">
                <div>
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-bold text-slate-100">{driver.nome}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{driver.veiculo} • <span className="font-mono">{driver.placa}</span></p>
                    </div>
                    <span className={`badge ${statusMeta.badgeClass}`}>
                      {statusMeta.label}
                    </span>
                  </div>

                  <hr className="border-white/[0.06] my-4" />

                  {/* Driver Metrics */}
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

                <div className="mt-6 flex justify-between items-center">
                  <span className="text-xs text-slate-500">
                    <strong className="text-slate-300">{driver.totalEntregas}</strong> entregas concluídas
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => router.push('/rotas')}>Rotas</Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedDriver(driver)}>Perfil</Button>
                  </div>
                </div>
              </Card>
            );
          })
        ) : (
          <div className="col-span-full card text-center py-12 text-slate-500">
            Nenhum motorista encontrado.
          </div>
        )}
      </div>
      <Pagination page={pageMeta.currentPage} pageSize={pageSize} totalItems={filteredMotoristas.length} itemLabel="motoristas" onPageChange={setPage} onPageSizeChange={(next) => { setPageSize(next); setPage(1); }} />

      {/* Add Driver Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-100">Adicionar Novo Motorista</h2>
              <Button onClick={() => setIsModalOpen(false)} variant="ghost" size="icon" aria-label="Fechar">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Button>
            </div>

            <form onSubmit={handleCreateDriver} className="flex flex-col gap-4">
                <Input
                  label="Nome Completo"
                  type="text"
                  placeholder="Nome do motorista"
                  value={newDriverNome}
                  onChange={(e) => setNewDriverNome(e.target.value)}
                  required
                />

                <Select
                  label="Veículo"
                  value={newDriverVeiculo}
                  onChange={(e) => setNewDriverVeiculo(e.target.value)}
                  options={['Moto (Honda Cargo)', 'Van (Peugeot Partner)', 'Carro (Fiorino)', 'Caminhão (HR)'].map((value) => ({ value, label: value }))}
                />

                <Input
                  label="Placa do Veículo"
                  type="text"
                  placeholder="AAA-0000"
                  className="uppercase"
                  value={newDriverPlaca}
                  onChange={(e) => setNewDriverPlaca(e.target.value)}
                  required
                />

              <div className="flex gap-3 justify-end mt-4">
                <Button onClick={() => setIsModalOpen(false)}>Cancelar</Button>
                <Button type="submit" variant="primary">Cadastrar Motorista</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Driver Scorecard Modal */}
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
                onClick={() => {
                  setSelectedDriver(null);
                  router.push('/rotas');
                }}
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
