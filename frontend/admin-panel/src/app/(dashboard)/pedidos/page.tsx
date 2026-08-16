'use client';

/**
 * @file page.tsx
 * @description Orders Page (English).
 */

import React, { useState, useEffect } from 'react';
import { adminApi, Pedido, HistoricoItem, type BackendDriver, type Warehouse, type DeliveryFailureReason, type CodMethod, type Client, type PricingZone, type QuoteBreakdown, type ServiceLevel, type OrdersStatsResponse, type PodImages, type ReturnReason, type Branch, COD_METHOD_LABELS, RETURN_REASON_LABELS } from '@/services/api';
import { printInvoice } from '@/services/invoicePrint';
import { printLabels, type LabelData } from '@/services/labelPrint';
import { usePreferences, densityClass } from '@/hooks/usePreferences';
import {
  Button,
  Card,
  DataTable,
  Input,
  PageHeader,
  Pagination,
  Select,
  SignaturePad,
  StatCard,
  paginationMeta,
  type DataTableColumn,
} from '@/components/ui';

const FAILURE_REASON_OPTIONS: { value: DeliveryFailureReason; label: string }[] = [
  { value: 'RECIPIENT_ABSENT', label: 'Destinatário ausente' },
  { value: 'WRONG_ADDRESS',    label: 'Morada incorreta' },
  { value: 'REFUSED',          label: 'Encomenda recusada' },
  { value: 'OTHER',            label: 'Outro motivo' },
];

const STATUS_LABELS: Record<string, { label: string; badgeClass: string }> = {
  created:              { label: 'Criado',               badgeClass: 'badge-brand' },
  collected:            { label: 'Coletado',             badgeClass: 'badge-info' },
  in_transit:           { label: 'Em Trânsito',          badgeClass: 'badge-info' },
  at_warehouse:         { label: 'No Armazém',           badgeClass: 'badge-warning' },
  awaiting_destination: { label: 'Aguardando Destino',   badgeClass: 'badge-warning' },
  out_for_delivery:     { label: 'Saiu para Entrega',     badgeClass: 'badge-warning' },
  delivered:            { label: 'Entregue',             badgeClass: 'badge-success' },
  failed:               { label: 'Insucesso',            badgeClass: 'badge-error' },
  cancelled:            { label: 'Cancelado',            badgeClass: 'badge-neutral' },
};

/** Estados em que o pedido está fisicamente num armazém (spec § 8.2). */
const WAREHOUSE_STATUSES = ['at_warehouse', 'awaiting_destination'];

const EVENT_ORIGINS: Record<string, { label: string; className: string }> = {
  DRIVER:       { label: 'Motorista',          className: 'bg-blue-500/10 text-blue-300 border-blue-500/20' },
  ADMIN:        { label: 'Administração',      className: 'bg-brand-500/10 text-brand-300 border-brand-500/20' },
  CARRIER_INTL: { label: 'Transportadora',     className: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20' },
  SYSTEM:       { label: 'Sistema',            className: 'bg-slate-500/10 text-slate-400 border-white/10' },
};

function trackingLocationLabel(location: HistoricoItem['location']): string | null {
  if (!location) return null;
  if (typeof location === 'string') {
    const labels: Record<string, string> = {
      'In transit': 'Em trânsito',
      'International Origin': 'Origem internacional',
      'National Sorting Center': 'Centro de triagem nacional',
    };
    return labels[location] ?? location;
  }
  const accuracy = location.accuracy_meters != null ? ` · precisão ±${Math.round(location.accuracy_meters)} m` : '';
  return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}${accuracy}`;
}

function trackingDescription(description: string | undefined, status: string): string {
  const translations: Record<string, string> = {
    'Order registered in the national system': 'Encomenda registada no sistema nacional.',
    'International order registered — awaiting processing': 'Encomenda internacional registada e aguardando processamento.',
    'Updated via driver app': 'Estado atualizado pelo aplicativo do motorista.',
    'Package collected at sender': 'Encomenda recolhida no remetente.',
    'Transferring between hubs': 'Encomenda em transferência entre centros logísticos.',
    'Out for delivery to recipient': 'Encomenda saiu para entrega ao destinatário.',
    'Delivered successfully': 'Encomenda entregue com sucesso.',
  };
  if (!description) return `Estado atualizado para ${STATUS_LABELS[status]?.label ?? status}.`;
  if (translations[description]) return translations[description];
  if (description.startsWith('Status updated to ')) {
    return `Estado atualizado para ${STATUS_LABELS[status]?.label ?? status}.`;
  }
  return description;
}

function trackingDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value, time: '' };
  return {
    date: date.toLocaleDateString('pt-MZ', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: date.toLocaleTimeString('pt-MZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}

function TrackingEventIcon({ status }: { status: string }) {
  const path = status === 'delivered'
    ? 'M5 13l4 4L19 7'
    : status === 'failed' || status === 'cancelled'
      ? 'M6 18L18 6M6 6l12 12'
      : status === 'at_warehouse' || status === 'awaiting_destination'
        ? 'M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01'
        : 'M3 12h18M12 3l9 9-9 9';
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
    </svg>
  );
}

/**
 * Deriva o armazém onde o pedido se encontra, a partir do histórico.
 * Devolve null quando o pedido não está num armazém.
 */
function warehouseLocationOf(p: Pedido): string | null {
  if (!WAREHOUSE_STATUSES.includes(p.status)) return null;
  const wh = p.history?.find((h) => h.status === 'at_warehouse');
  return trackingLocationLabel(wh?.location ?? p.history?.[0]?.location);
}

/** Ícone de localização em SVG (sem emoji). */
function LocationPin({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export default function PedidosPage() {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  // Total e contadores vêm do servidor: contá-los no browser obrigava a
  // descarregar a tabela toda (spec § 3.1).
  const [totalPedidos, setTotalPedidos] = useState(0);
  const [orderStats, setOrderStats] = useState<OrdersStatsResponse | null>(null);
  const [receivePedido, setReceivePedido] = useState<Pedido | null>(null);
  const [motoristas, setMotoristas] = useState<BackendDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  // Filial de ORIGEM (spec § 3.45). Só aparece a quem tem mais do que uma base:
  // um seletor com uma única opção é ruído, e a quem está restrito a uma filial
  // o backend já filtra — o seletor não lhe daria escolha nenhuma.
  const [branchFilter, setBranchFilter] = useState('all');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [error, setError] = useState('');

  // Creation Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newOrderTracking, setNewOrderTracking] = useState('');
  const [newOrderClient, setNewOrderClient] = useState('');
  const [newOrderDestino, setNewOrderDestino] = useState('');
  // Pré-preenchido com a tarifa base das Configurações ao abrir o modal
  const [newOrderValor, setNewOrderValor] = useState('');
  const [newOrderCod, setNewOrderCod] = useState('');
  const [newOrderPhone, setNewOrderPhone] = useState('');
  const [newOrderEmail, setNewOrderEmail] = useState('');
  // Ligação a um cliente registado (spec § 3.12) — prefill de contactos
  const [newOrderClientRefId, setNewOrderClientRefId] = useState<string | undefined>(undefined);
  const [clientResults, setClientResults] = useState<Client[]>([]);
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  // Tarifação (spec § 3.13)
  const [newOrderWeight, setNewOrderWeight] = useState('');
  // Dimensões e distância (§ 3.13). Vazias por omissão: a encomenda simples
  // continua a orçar-se com peso e zona, sem seis campos por preencher.
  const [newOrderC, setNewOrderC] = useState('');
  const [newOrderL, setNewOrderL] = useState('');
  const [newOrderA, setNewOrderA] = useState('');
  const [newOrderKm, setNewOrderKm] = useState('');
  const [newOrderZone, setNewOrderZone] = useState('');
  const [newOrderService, setNewOrderService] = useState<ServiceLevel>('normal');
  const [pricingZones, setPricingZones] = useState<PricingZone[]>([]);
  const [newOrderQuote, setNewOrderQuote] = useState<QuoteBreakdown | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modalError, setModalError] = useState('');

  // Receção no armazém — preparado para digitação ou leitor de código de barras.
  const [isReceiveModalOpen, setIsReceiveModalOpen] = useState(false);
  const [receiveTracking, setReceiveTracking] = useState('');
  const [receiveWarehouseId, setReceiveWarehouseId] = useState('');
  const [receiveNotes, setReceiveNotes] = useState('');
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);
  const [receiveError, setReceiveError] = useState('');
  const [receiveSuccess, setReceiveSuccess] = useState('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  
  // Details/Timeline Modal State
  const [selectedPedido, setSelectedPedido] = useState<Pedido | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  // Reagendamento e devolução (§ 3.37) — só aparecem num pedido falhado.
  const [reagendarData, setReagendarData] = useState('');
  const [devolucaoMotivo, setDevolucaoMotivo] = useState<ReturnReason>('ATTEMPTS_EXHAUSTED');
  const [devolucaoRecebidoPor, setDevolucaoRecebidoPor] = useState('');
  const [redeliveryBusy, setRedeliveryBusy] = useState(false);
  const [redeliveryErro, setRedeliveryErro] = useState('');
  const [invoiceMsg, setInvoiceMsg] = useState('');
  // Imagens do comprovativo: fora da listagem por peso (spec § 3.28), buscadas
  // quando o detalhe abre.
  const [podImages, setPodImages] = useState<PodImages | null>(null);
  const [podLoading, setPodLoading] = useState(false);
  const [podError, setPodError] = useState('');

  // Warehouse Shipment Modal State (spec § 8.2)
  const [warehousePedido, setWarehousePedido] = useState<Pedido | null>(null);
  const [whDestino, setWhDestino] = useState('');
  const [whNotes, setWhNotes] = useState('');
  const [whSubmitting, setWhSubmitting] = useState(false);
  const [whError, setWhError] = useState('');
  // Coordenadas reais capturadas do dispositivo (spec § 8.2 — localização de quem confirma)
  const [whCoords, setWhCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [whGeoLoading, setWhGeoLoading] = useState(false);

  // Registro de entrega / POD (spec § 3.1)
  const [deliveryPedido, setDeliveryPedido] = useState<Pedido | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<'delivered' | 'failed'>('delivered');
  const [podRecipient, setPodRecipient] = useState('');
  const [podSignature, setPodSignature] = useState<string | null>(null);
  const [podPhoto, setPodPhoto] = useState<string | null>(null);
  const [podNotes, setPodNotes] = useState('');
  const [failReason, setFailReason] = useState<DeliveryFailureReason>('RECIPIENT_ABSENT');
  const [codMethod, setCodMethod] = useState<CodMethod>('CASH');
  const [otpCode, setOtpCode] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [otpInfo, setOtpInfo] = useState('');
  const [deliveryCoords, setDeliveryCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [deliveryGeoLoading, setDeliveryGeoLoading] = useState(false);
  const [deliverySubmitting, setDeliverySubmitting] = useState(false);
  const [deliveryError, setDeliveryError] = useState('');

  const { prefs } = usePreferences();

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const [ordersPage, driversData] = await Promise.all([
        adminApi.getOrdersPage({
          page: currentPage,
          pageSize,
          status: statusFilter === 'all' ? undefined : statusFilter,
          branch_id: branchFilter === 'all' ? undefined : branchFilter,
          search: searchTerm.trim() || undefined,
        }),
        adminApi.getDrivers(),
      ]);
      setPedidos(ordersPage.items);
      setTotalPedidos(ordersPage.total);
      setMotoristas(driversData);
      adminApi.getOrdersStats().then(setOrderStats).catch(() => setOrderStats(null));
      try {
        setWarehouses(await adminApi.getArmazens());
      } catch {
        setWarehouses([]);
      }
      // Falha em silêncio: sem filiais o ecrã fica exatamente como estava, e a
      // lista de encomendas não depende disto para funcionar.
      adminApi.getFiliais().then((r) => setBranches(r.branches)).catch(() => setBranches([]));
    } catch (err) {
      setError('Erro ao carregar dados do servidor. Exibindo dados locais de contingência.');
      setPedidos([
        { id: '1', trackingCode: 'TRK00000001BR', client: 'Carlos Silva', destination: 'São Paulo - SP', driver: 'Marcos Souza', status: 'in_transit', value: 2990, updatedAt: '18/07/2026 15:30' },
        { id: '2', trackingCode: 'LX987654321CN', client: 'Ana Oliveira', destination: 'Rio de Janeiro - RJ', driver: 'Pedro Santos', status: 'at_warehouse', value: 8990, updatedAt: '18/07/2026 14:15' },
        { id: '3', trackingCode: 'TRK00000003BR', client: 'Roberto Souza', destination: 'Belo Horizonte - MG', status: 'created', value: 1500, updatedAt: '18/07/2026 16:00' },
        { id: '4', trackingCode: 'TRK00000004BR', client: 'Juliana Lima', destination: 'Curitiba - PR', driver: 'Lucas Lima', status: 'delivered', value: 4500, updatedAt: '17/07/2026 18:20' },
        { id: '5', trackingCode: 'TRK00000005BR', client: 'Fernanda Costa', destination: 'Porto Alegre - RS', status: 'awaiting_destination', value: 3500, updatedAt: '18/07/2026 11:00' },
        { id: '6', trackingCode: 'TRK00000006BR', client: 'Ricardo Alves', destination: 'Salvador - BA', driver: 'Marcos Souza', status: 'failed', value: 5200, updatedAt: '18/07/2026 09:45' },
      ]);
      setMotoristas([]);
    } finally {
      setLoading(false);
    }
    
  };

  // Recarrega do servidor sempre que muda a página, o tamanho, o estado ou a
  // pesquisa. O atraso evita um pedido por cada tecla escrita.
  useEffect(() => {
    const timer = setTimeout(() => { void loadData(); }, searchTerm ? 300 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize, statusFilter, branchFilter, searchTerm]);
  // Procura a encomenda do código lido diretamente no servidor.
  useEffect(() => {
    const code = receiveTracking.trim().toUpperCase();
    if (!code) { setReceivePedido(null); return undefined; }
    const timer = setTimeout(() => {
      adminApi.getOrdersPage({ search: code, pageSize: 5 })
        .then((r) => setReceivePedido(r.items.find((o) => o.trackingCode.toUpperCase() === code) ?? null))
        .catch(() => setReceivePedido(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [receiveTracking]);


  const driverNameOf = (pedido: Pedido): string | null => {
    if (!pedido.driver) return null;
    const driver = motoristas.find((item) => item.id === pedido.driver);
    if (driver) return driver.name;
    // Dados locais antigos já podem trazer o nome em vez do ID.
    return pedido.driver.startsWith('driver-') ? 'Motorista não encontrado' : pedido.driver;
  };

  // A pesquisa e o filtro de estado são resolvidos em SQL (spec § 3.1): o que
  // chega já é a página certa. Contar e cortar aqui seria contar sobre uma amostra.
  const ordersPageMeta = paginationMeta(totalPedidos, currentPage, pageSize);
  const paginatedPedidos = pedidos;

  // A encomenda a receber é procurada NO SERVIDOR: com a listagem paginada, o
  // código lido pode não estar na página aberta (spec § 3.1). A normalização do
  // código vive no efeito que faz a procura, não aqui.
  const canReceivePedido = receivePedido?.status === 'in_transit';
  const availableWarehouses = warehouses.filter((warehouse) => warehouse.status === 'active' && !warehouse.full);
  const receiveWarehouse = warehouses.find((warehouse) => warehouse.id === receiveWarehouseId) ?? null;
  const selectedHistory = selectedPedido?.history
    ? [...selectedPedido.history].sort((a, b) => {
        const aTime = Date.parse(a.device_timestamp ?? a.timestamp);
        const bTime = Date.parse(b.device_timestamp ?? b.timestamp);
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      })
    : [];

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(cents / 100);
  };

  // Pesquisa de clientes registados (debounce) para prefill no modal de criação.
  useEffect(() => {
    if (!isModalOpen) return;
    const term = newOrderClient.trim();
    // Se um cliente já está selecionado e o nome bate certo, não repesquisar.
    if (newOrderClientRefId || term.length < 2) { setClientResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await adminApi.getClientes({ search: term, status: 'active', pageSize: 6 });
        setClientResults(res.items);
      } catch { setClientResults([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [newOrderClient, newOrderClientRefId, isModalOpen]);

  const selectClient = (c: Client) => {
    setNewOrderClientRefId(c.id);
    setNewOrderClient(c.name);
    if (c.phone) setNewOrderPhone(c.phone);
    if (c.email) setNewOrderEmail(c.email);
    setClientResults([]);
    setClientPickerOpen(false);
  };

  /**
   * Comprovativo: só se carrega o que se vai mostrar (spec § 3.28).
   *
   * A listagem devolve `has_signature`/`has_photo` e nada de imagens; quando o
   * detalhe abre e há prova, vamos buscá-la. Sem isto, cada página de 25 pedidos
   * trazia as assinaturas e fotos de todas as entregas para desenhar uma tabela
   * que nem imagens tem.
   */
  useEffect(() => {
    const pod = selectedPedido?.pod;
    if (!selectedPedido || !pod || (!pod.has_signature && !pod.has_photo)) {
      setPodImages(null); setPodError('');
      return;
    }
    let cancelled = false;
    setPodLoading(true); setPodError(''); setPodImages(null);
    adminApi.getOrderPod(selectedPedido.id)
      .then((images) => { if (!cancelled) setPodImages(images); })
      .catch(() => { if (!cancelled) setPodError('Não foi possível carregar o comprovativo.'); })
      .finally(() => { if (!cancelled) setPodLoading(false); });
    return () => { cancelled = true; };
  }, [selectedPedido]);

  // Carrega as zonas de tarifação ao abrir o modal de criação (spec § 3.13).
  useEffect(() => {
    if (!isModalOpen || pricingZones.length > 0) return;
    adminApi.getPricingZones(true)
      .then((zs) => { setPricingZones(zs); if (zs.length && !newOrderZone) setNewOrderZone(zs[0].code); })
      .catch(() => setPricingZones([]));
  }, [isModalOpen, pricingZones.length, newOrderZone]);

  /** Corre uma ação de reagendamento/devolução e recarrega o pedido. */
  const acaoRedelivery = async (fn: () => Promise<unknown>) => {
    setRedeliveryBusy(true);
    setRedeliveryErro('');
    try {
      await fn();
      setSelectedPedido(null);
      await loadData();
    } catch (e) {
      // A mensagem do servidor é a útil: diz quantas tentativas restam ou
      // porque é que a data foi recusada.
      setRedeliveryErro(e instanceof Error ? e.message : 'A operação falhou.');
    } finally {
      setRedeliveryBusy(false);
    }
  };

  const calcularOrcamento = async () => {
    if (!newOrderZone) return;
    setQuoting(true);
    try {
      const q = await adminApi.quotePrice({
        zone_code: newOrderZone,
        weight_grams: Math.round((parseFloat(newOrderWeight) || 0) * 1000),
        service: newOrderService,
        cod_amount: parseInt(newOrderCod, 10) || 0,
        // Só com os três lados: com dois não há volume que calcular.
        dimensions_cm: (parseFloat(newOrderC) > 0 && parseFloat(newOrderL) > 0 && parseFloat(newOrderA) > 0)
          ? { length_cm: parseFloat(newOrderC), width_cm: parseFloat(newOrderL), height_cm: parseFloat(newOrderA) }
          : undefined,
        distance_km: parseFloat(newOrderKm) > 0 ? parseFloat(newOrderKm) : undefined,
        // Com cliente registado, o contrato em vigor entra sozinho no preço
        // (§ 3.35) — é o que evita ter de lembrar o desconto acordado.
        client_ref_id: newOrderClientRefId,
      });
      setNewOrderQuote(q);
      setNewOrderValor(String(q.total_cents));
    } catch {
      setNewOrderQuote(null);
    } finally {
      setQuoting(false);
    }
  };

  // Etiqueta de expedição com código de barras (spec § 3.15).
  const pedidoToLabel = (p: Pedido): LabelData => ({
    trackingCode: p.trackingCode,
    client: p.client,
    destination: p.destination,
    valueCents: p.value,
    codCents: (p.codAmount ?? 0) > 0 ? p.codAmount : undefined,
  });

  // Emite (ou reutiliza) a fatura-recibo do frete e abre o documento (spec § 3.14).
  const gerarFatura = async (pedido: Pedido) => {
    setInvoiceBusy(true);
    setInvoiceMsg('');
    try {
      const inv = await adminApi.createInvoiceFromOrder(pedido.id);
      const full = await adminApi.getInvoice(inv.id).catch(() => inv);
      setInvoiceMsg(`Fatura ${inv.number} emitida.`);
      printInvoice(full);
    } catch {
      setInvoiceMsg('Falha ao emitir a fatura.');
    } finally {
      setInvoiceBusy(false);
    }
  };

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrderTracking || !newOrderClient || !newOrderDestino) {
      setModalError('Por favor, preencha todos os campos obrigatórios.');
      return;
    }
    
    setIsSubmitting(true);
    setModalError('');

    try {
      await adminApi.createOrder({
        trackingCode: newOrderTracking,
        client: newOrderClient,
        destination: newOrderDestino,
        value: parseInt(newOrderValor, 10) || prefs.baseFeeCents,
        codAmount: parseInt(newOrderCod, 10) || 0,
        clientPhone: newOrderPhone.trim() || undefined,
        clientEmail: newOrderEmail.trim() || undefined,
        clientRefId: newOrderClientRefId,
        weightGrams: Math.round((parseFloat(newOrderWeight) || 0) * 1000) || undefined,
        pricing: newOrderQuote ?? undefined,
      });

      await loadData();

      setNewOrderTracking('');
      setNewOrderClient('');
      setNewOrderDestino('');
      setNewOrderValor(String(prefs.baseFeeCents));
      setNewOrderCod('');
      setNewOrderPhone('');
      setNewOrderEmail('');
      setNewOrderClientRefId(undefined);
      setClientResults([]);
      setNewOrderWeight('');
      setNewOrderQuote(null);
      setNewOrderService('normal');
      setIsModalOpen(false);
    } catch (err) {
      setModalError('Falha ao registrar no servidor. Por favor, verifique sua conexão.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openReceiveModal = (pedido?: Pedido) => {
    setReceiveTracking(pedido?.trackingCode ?? '');
    setReceiveWarehouseId((current) => {
      const currentAvailable = availableWarehouses.some((warehouse) => warehouse.id === current);
      return currentAvailable ? current : availableWarehouses[0]?.id ?? '';
    });
    setReceiveNotes('');
    setReceiveError('');
    setReceiveSuccess('');
    setIsReceiveModalOpen(true);
  };

  const closeReceiveModal = () => {
    if (receiveSubmitting) return;
    setIsReceiveModalOpen(false);
    setReceiveError('');
    setReceiveSuccess('');
  };

  const handleReceiveAtWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    setReceiveError('');
    setReceiveSuccess('');

    if (!receivePedido) {
      setReceiveError('Código de rastreio não encontrado. Confirme o código e tente novamente.');
      return;
    }
    if (!canReceivePedido) {
      const currentLabel = STATUS_LABELS[receivePedido.status]?.label ?? receivePedido.status;
      setReceiveError(`Esta encomenda está em “${currentLabel}” e não pode ser recebida novamente.`);
      return;
    }
    if (!receiveWarehouseId || !receiveWarehouse) {
      setReceiveError('Selecione um armazém cadastrado para receber a encomenda.');
      return;
    }
    if (receiveWarehouse.status !== 'active' || receiveWarehouse.full) {
      setReceiveError('O armazém selecionado está inativo ou sem capacidade disponível.');
      return;
    }

    setReceiveSubmitting(true);
    try {
      await adminApi.intakeEncomenda(receiveWarehouse.id, {
        orderId: receivePedido.id,
        notes: receiveNotes.trim() || undefined,
      });
      setReceiveSuccess(`${receivePedido.trackingCode} recebida com sucesso em ${receiveWarehouse.name}.`);
      setReceiveTracking('');
      setReceiveNotes('');
      await loadData();
    } catch (err) {
      setReceiveError(err instanceof Error && err.message
        ? err.message
        : 'Não foi possível registar a receção da encomenda.');
    } finally {
      setReceiveSubmitting(false);
    }
  };

  const openWarehouseModal = (pedido: Pedido) => {
    setWarehousePedido(pedido);
    setWhDestino(pedido.destination || '');
    setWhNotes('');
    setWhError('');
    setWhCoords(null);
    setWhGeoLoading(false);
  };

  const captureCurrentLocation = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setWhError('Este navegador não suporta geolocalização.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setWhError('O navegador só permite GPS em HTTPS ou localhost.');
      return;
    }
    setWhGeoLoading(true);
    setWhError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setWhCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setWhGeoLoading(false);
      },
      (err) => {
        setWhGeoLoading(false);
        setWhError(
          err.code === err.PERMISSION_DENIED
            ? 'Permissão de localização negada. Autorize o GPS no navegador.'
            : 'Não foi possível obter a localização atual.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );
  };

  const handleRequestShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!warehousePedido) return;
    if (!whDestino.trim()) { setWhError('Informe o destino de entrega.'); return; }

    setWhSubmitting(true);
    setWhError('');
    try {
      await adminApi.requestWarehouseShipment(
        warehousePedido.id,
        whDestino.trim(),
        whNotes.trim() || undefined,
        whCoords ?? undefined,
      );
      await loadData();
      setWarehousePedido(null);
    } catch (err) {
      setWhError(err instanceof Error && err.message ? err.message : 'Falha ao solicitar o envio.');
    } finally {
      setWhSubmitting(false);
    }
  };

  const handleHoldForDestination = async () => {
    if (!warehousePedido) return;
    setWhSubmitting(true);
    setWhError('');
    try {
      const wh = warehouseLocationOf(warehousePedido) || 'Armazém';
      await adminApi.holdForDestination(warehousePedido.id, wh);
      await loadData();
      setWarehousePedido(null);
    } catch (err) {
      setWhError(err instanceof Error && err.message ? err.message : 'Falha ao colocar em espera.');
    } finally {
      setWhSubmitting(false);
    }
  };

  // ── Entrega / POD (spec § 3.1) ──────────────────────────────────────────────

  const openDeliveryModal = (pedido: Pedido) => {
    setDeliveryPedido(pedido);
    setDeliveryMode('delivered');
    setPodRecipient('');
    setPodSignature(null);
    setPodPhoto(null);
    setPodNotes('');
    setFailReason('RECIPIENT_ABSENT');
    setCodMethod('CASH');
    setOtpCode('');
    setOtpSending(false);
    setOtpInfo('');
    setDeliveryCoords(null);
    setDeliveryGeoLoading(false);
    setDeliveryError('');
  };

  const handleSendOtp = async () => {
    if (!deliveryPedido) return;
    setOtpSending(true);
    setDeliveryError('');
    setOtpInfo('');
    try {
      await adminApi.requestDeliveryOtp(deliveryPedido.id);
      setOtpInfo('Código enviado por SMS ao cliente. Peça o código para confirmar a entrega.');
    } catch (err) {
      setDeliveryError(err instanceof Error && err.message ? err.message : 'Falha ao enviar o código.');
    } finally {
      setOtpSending(false);
    }
  };

  const captureDeliveryLocation = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setDeliveryError('Este navegador não suporta geolocalização.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setDeliveryError('O navegador só permite GPS em HTTPS ou localhost.');
      return;
    }
    setDeliveryGeoLoading(true);
    setDeliveryError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDeliveryCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setDeliveryGeoLoading(false);
      },
      (err) => {
        setDeliveryGeoLoading(false);
        setDeliveryError(
          err.code === err.PERMISSION_DENIED
            ? 'Permissão de localização negada. Autorize o GPS no navegador.'
            : 'Não foi possível obter a localização atual.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );
  };

  const handlePodPhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      setDeliveryError('A foto é demasiado grande (máximo 2 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPodPhoto(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const handleDeliverySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deliveryPedido) return;
    setDeliveryError('');

    if (deliveryMode === 'delivered' && !podRecipient.trim()) {
      setDeliveryError('Informe o nome de quem recebeu.');
      return;
    }

    setDeliverySubmitting(true);
    try {
      if (deliveryMode === 'delivered') {
        await adminApi.deliverOrder(deliveryPedido.id, {
          recipientName: podRecipient.trim(),
          signature: podSignature ?? undefined,
          photo: podPhoto ?? undefined,
          notes: podNotes.trim() || undefined,
          coords: deliveryCoords ?? undefined,
          codMethod: (deliveryPedido.codAmount ?? 0) > 0 ? codMethod : undefined,
          otp: otpCode.trim() || undefined,
        });
      } else {
        await adminApi.failDelivery(deliveryPedido.id, failReason, podNotes.trim() || undefined);
      }
      await loadData();
      setDeliveryPedido(null);
    } catch (err) {
      setDeliveryError(err instanceof Error && err.message ? err.message : 'Falha ao registar a entrega.');
    } finally {
      setDeliverySubmitting(false);
    }
  };

  const orderColumns: DataTableColumn<Pedido>[] = [
    {
      key: 'trackingCode',
      header: 'Código',
      headerClassName: 'w-[155px]',
      cellClassName: 'font-semibold text-brand-400 font-mono whitespace-nowrap',
      cell: (pedido) => pedido.trackingCode,
    },
    {
      key: 'client',
      header: 'Cliente',
      headerClassName: 'min-w-[165px]',
      cellClassName: 'min-w-[165px]',
      cell: (pedido) => pedido.client,
    },
    {
      key: 'destination',
      header: 'Destino',
      headerClassName: 'min-w-[190px]',
      cellClassName: 'min-w-[190px]',
      cell: (pedido) => pedido.destination,
    },
    {
      key: 'driver',
      header: 'Motorista',
      headerClassName: 'min-w-[165px]',
      cellClassName: 'min-w-[165px] whitespace-nowrap',
      cell: (pedido) => driverNameOf(pedido) || <span className="text-slate-600">Não atribuído</span>,
    },
    {
      key: 'status',
      header: 'Status',
      headerClassName: 'min-w-[155px]',
      cellClassName: 'min-w-[155px]',
      cell: (pedido) => {
        const statusMeta = STATUS_LABELS[pedido.status] || { label: pedido.status, badgeClass: 'badge-neutral' };
        const warehouseLocation = warehouseLocationOf(pedido);
        return (
          <>
            <span className={`badge ${statusMeta.badgeClass}`}>{statusMeta.label}</span>
            {warehouseLocation && (
              <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-amber-400/90">
                <LocationPin className="h-3 w-3 shrink-0" /> {warehouseLocation}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: 'updatedAt',
      header: 'Atualizado em',
      headerClassName: 'w-[145px]',
      cellClassName: 'text-xs whitespace-nowrap',
      cell: (pedido) => pedido.updatedAt,
    },
    {
      key: 'actions',
      header: 'Ações',
      headerClassName: 'w-[220px] text-right',
      cellClassName: 'text-right min-w-[220px]',
      cell: (pedido) => {
        const warehouseLocation = warehouseLocationOf(pedido);
        return (
          <div className="flex justify-end gap-2 whitespace-nowrap">
            {warehouseLocation && (
              <Button size="sm" variant="primary" onClick={() => openWarehouseModal(pedido)}>
                Solicitar Envio
              </Button>
            )}
            {pedido.status === 'in_transit' && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => openReceiveModal(pedido)}
                title="Registar a entrada desta encomenda no armazém"
              >
                Receber
              </Button>
            )}
            {pedido.status === 'out_for_delivery' && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => openDeliveryModal(pedido)}
                title="Registar a entrega com comprovativo"
              >
                Registrar entrega
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelectedPedido(pedido)}>
              Detalhes
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pedidos"
        description="Gerencie encomendas, receções e expedições."
        actions={
          <>
            <Button
              variant="secondary"
              fullWidth
              disabled={paginatedPedidos.length === 0}
              onClick={() => printLabels(paginatedPedidos.map(pedidoToLabel))}
              leftIcon={
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z" />
                </svg>
              }
            >
              Imprimir Etiquetas
            </Button>
            <Button
              variant="secondary"
              fullWidth
              onClick={() => openReceiveModal()}
              leftIcon={
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10" />
                </svg>
              }
            >
              Receber no Armazém
            </Button>
            <Button
              variant="primary"
              fullWidth
              onClick={() => { setNewOrderValor(String(prefs.baseFeeCents)); setIsModalOpen(true); }}
              leftIcon={
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              }
            >
              Novo Pedido
            </Button>
          </>
        }
      />

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 p-4 rounded-2xl text-xs flex justify-between items-center">
          <span>{error}</span>
          <button onClick={loadData} className="btn btn-secondary btn-sm">Tentar Novamente</button>
        </div>
      )}

      {/* Stats Cards */}
      <div className="stats-grid">
        <StatCard label="Total de Pedidos" value={orderStats?.total ?? totalPedidos} helper={<span className="text-xs text-slate-500">Todos os pedidos da empresa</span>} />
        <StatCard
          label="Em Trânsito"
          value={orderStats?.in_transit ?? 0}
          helper={<span className="text-xs text-slate-500">Motoristas ativos em rota</span>}
        />
        <StatCard
          label="Aguardando Destino"
          value={orderStats?.awaiting_destination ?? 0}
          helper={<span className="stat-delta-down">Ações pendentes do cliente</span>}
        />
        <StatCard
          label="Taxa de Sucesso"
          value={orderStats ? `${orderStats.success_rate_pct}%` : '—'}
          helper={<span className="text-xs text-slate-500">Entregues sobre o que já terminou</span>}
        />
      </div>

      {/* Filter and Search Controls */}
      <Card className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <Input
          type="search"
          aria-label="Buscar pedidos"
          placeholder="Buscar por código, cliente ou motorista..."
          containerClassName="md:flex-1 md:max-w-md"
          value={searchTerm}
          onChange={(event) => {
            setSearchTerm(event.target.value);
            setCurrentPage(1);
          }}
          rightIcon={
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
        />

        {/* Flex que embrulha, e não um grid de colunas fixas: o seletor de
            filial só aparece quando há mais do que uma base (§ 3.45), e um grid
            de duas colunas empurrava o botão para uma segunda linha assim que
            ele entrava — defeito que só se via em empresas multifilial. */}
        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:shrink-0">
          <Select
            aria-label="Filtrar por status"
            containerClassName="min-w-[10rem] flex-1 md:w-52 md:flex-none"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            options={[
              { value: 'all', label: 'Todos os Status' },
              ...Object.entries(STATUS_LABELS).map(([value, meta]) => ({ value, label: meta.label })),
            ]}
          />

          {branches.length > 1 && (
            <Select
              aria-label="Filtrar por filial de origem"
              containerClassName="min-w-[10rem] flex-1 md:w-52 md:flex-none"
              value={branchFilter}
              onChange={(event) => {
                setBranchFilter(event.target.value);
                setCurrentPage(1);
              }}
              options={[
                { value: 'all', label: 'Todas as filiais' },
                ...branches.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
          )}

          <Button
            variant="secondary"
            className="shrink-0"
            onClick={loadData}
            leftIcon={
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            }
          >
            Atualizar
          </Button>
        </div>
      </Card>

      {/* Data Table */}
      <DataTable
        data={paginatedPedidos}
        columns={orderColumns}
        getRowKey={(pedido) => pedido.id}
        loading={loading}
        loadingLabel="A carregar pedidos..."
        emptyTitle="Nenhum pedido encontrado"
        emptyDescription="Ajuste a pesquisa ou o filtro de status para encontrar outras encomendas."
        tableClassName={`min-w-[1120px] ${densityClass(prefs.density)}`}
        rowClassName={(pedido) => prefs.alertOnFailure && pedido.status === 'failed' ? 'bg-red-500/[0.06]' : undefined}
        footer={
          <Pagination
            page={ordersPageMeta.currentPage}
            pageSize={pageSize}
            totalItems={totalPedidos}
            itemLabel="pedidos"
            onPageChange={setCurrentPage}
            onPageSizeChange={(nextPageSize) => {
              setPageSize(nextPageSize);
              setCurrentPage(1);
            }}
          />
        }
      />

      {/* Receção no Armazém — fluxo rápido para operador ou leitor de código de barras */}
      {isReceiveModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-lg card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Operação de Armazém</span>
                <h2 className="text-lg font-bold text-slate-100 mt-0.5">Receber encomenda</h2>
                <p className="text-xs text-slate-500 mt-1">Leia o código de barras ou introduza o código de rastreio.</p>
              </div>
              <button
                type="button"
                onClick={closeReceiveModal}
                disabled={receiveSubmitting}
                className="text-slate-500 hover:text-slate-200 transition-colors p-1"
                aria-label="Fechar receção"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {receiveSuccess && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs rounded-xl flex items-start gap-2">
                <svg className="w-4 h-4 shrink-0 mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>{receiveSuccess}<strong className="block mt-0.5 text-emerald-400">Pronto para receber a próxima.</strong></span>
              </div>
            )}

            {receiveError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">
                {receiveError}
              </div>
            )}

            <form onSubmit={handleReceiveAtWarehouse} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Código de rastreio</label>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="text"
                    autoFocus
                    autoComplete="off"
                    placeholder="Leia ou digite o código"
                    className="input h-11 pr-10 uppercase font-mono"
                    value={receiveTracking}
                    onChange={(e) => {
                      setReceiveTracking(e.target.value.toUpperCase());
                      setReceiveError('');
                      setReceiveSuccess('');
                    }}
                    disabled={receiveSubmitting}
                    required
                  />
                  <svg className="absolute right-3 top-3 w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5v14M7 5v14M11 5v14M16 5v14M21 5v14" />
                  </svg>
                </div>
              </div>

              {receivePedido && (
                <div className={`rounded-xl border p-4 ${canReceivePedido ? 'bg-brand-500/[0.05] border-brand-500/20' : 'bg-amber-500/[0.05] border-amber-500/20'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-100 truncate">{receivePedido.client}</p>
                      <p className="text-xs text-slate-500 mt-1 truncate">Destino: {receivePedido.destination}</p>
                    </div>
                    <span className={`badge shrink-0 ${STATUS_LABELS[receivePedido.status]?.badgeClass ?? 'badge-neutral'}`}>
                      {STATUS_LABELS[receivePedido.status]?.label ?? receivePedido.status}
                    </span>
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="receive-warehouse" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Armazém de receção</label>
                <select
                  id="receive-warehouse"
                  className="input h-11 w-full"
                  value={receiveWarehouseId}
                  onChange={(e) => { setReceiveWarehouseId(e.target.value); setReceiveError(''); }}
                  disabled={receiveSubmitting}
                  required
                >
                  <option value="">Selecione um armazém</option>
                  {warehouses.map((warehouse) => (
                    <option
                      key={warehouse.id}
                      value={warehouse.id}
                      disabled={warehouse.status !== 'active' || warehouse.full}
                    >
                      {warehouse.name} · {warehouse.code} · {warehouse.occupancy}/{warehouse.capacity || '∞'}
                      {warehouse.status !== 'active' ? ' · Inativo' : warehouse.full ? ' · Lotado' : ''}
                    </option>
                  ))}
                </select>
                {warehouses.length === 0 ? (
                  <span className="text-[10px] text-amber-400 mt-1 block">Nenhum armazém cadastrado está disponível. Cadastre ou ative um armazém primeiro.</span>
                ) : (
                  <span className="text-[10px] text-slate-500 mt-1 block">A ocupação é atualizada automaticamente após a confirmação.</span>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Observação (opcional)</label>
                <textarea
                  rows={3}
                  placeholder="Ex.: Embalagem conferida e sem danos"
                  className="input resize-none"
                  value={receiveNotes}
                  onChange={(e) => setReceiveNotes(e.target.value)}
                  disabled={receiveSubmitting}
                />
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
                <button type="button" onClick={closeReceiveModal} disabled={receiveSubmitting} className="btn btn-secondary h-10">
                  Fechar
                </button>
                <button type="submit" disabled={receiveSubmitting || !canReceivePedido || !receiveWarehouseId} className="btn btn-primary h-10">
                  {receiveSubmitting ? 'A registar...' : 'Confirmar receção'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Creation Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-lg card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-100">Cadastrar Novo Pedido</h2>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {modalError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl text-center">
                {modalError}
              </div>
            )}

            <form onSubmit={handleCreateOrder} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Código de Rastreio (ex: TRK12345678BR ou LX123456789CN)</label>
                <input
                  type="text"
                  placeholder="TRK00000000BR"
                  className="input uppercase"
                  value={newOrderTracking}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrderTracking(e.target.value)}
                  required
                />
                <span className="text-[10px] text-slate-500 mt-1 block">Suporta padrões nacionais e internacionais.</span>
              </div>

              <div className="relative">
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Nome do Cliente
                  {newOrderClientRefId && <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Cliente registado</span>}
                </label>
                <input
                  type="text"
                  placeholder="Nome ou pesquisar cliente registado"
                  className="input"
                  value={newOrderClient}
                  autoComplete="off"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setNewOrderClient(e.target.value);
                    setNewOrderClientRefId(undefined); // digitar desliga a ligação
                    setClientPickerOpen(true);
                  }}
                  onFocus={() => setClientPickerOpen(true)}
                  required
                />
                {clientPickerOpen && clientResults.length > 0 && !newOrderClientRefId && (
                  <div className="absolute z-20 left-0 right-0 mt-1 rounded-xl bg-surface-overlay border border-white/10 shadow-xl overflow-hidden">
                    {clientResults.map((c) => (
                      <button key={c.id} type="button" onClick={() => selectClient(c)}
                        className="w-full text-left px-3 py-2 hover:bg-surface-elevated transition-colors flex flex-col">
                        <span className="text-xs font-semibold text-slate-200">{c.name}</span>
                        <span className="text-[11px] text-slate-500">{[c.email, c.phone].filter(Boolean).join(' · ') || 'sem contactos'}</span>
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-[10px] text-slate-500 mt-1 block">Escreva para pesquisar um cliente registado (prefill de contactos) ou insira um novo nome.</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Destino de Entrega</label>
                <input
                  type="text"
                  placeholder="Cidade - UF"
                  className="input"
                  value={newOrderDestino}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrderDestino(e.target.value)}
                  required
                />
              </div>

              {/* Tarifação — orçamento por peso/zona (spec § 3.13) */}
              <div className="rounded-xl border border-white/[0.06] bg-surface-elevated/40 p-3 flex flex-col gap-3">
                <span className="text-xs font-semibold text-slate-300">Tarifação (opcional)</span>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Peso (kg)</label>
                    <input type="number" min="0" step="0.1" placeholder="0.0" className="input" value={newOrderWeight}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setNewOrderWeight(e.target.value); setNewOrderQuote(null); }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Zona</label>
                    <select className="input" value={newOrderZone}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setNewOrderZone(e.target.value); setNewOrderQuote(null); }}>
                      {pricingZones.length === 0 && <option value="">—</option>}
                      {pricingZones.map((z) => <option key={z.id} value={z.code}>{z.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Serviço</label>
                    <select className="input" value={newOrderService}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setNewOrderService(e.target.value as ServiceLevel); setNewOrderQuote(null); }}>
                      <option value="normal">Normal</option>
                      <option value="express">Expresso</option>
                    </select>
                  </div>
                </div>

                {/* Dimensões e distância — opcionais. Uma caixa grande e leve
                    paga pelo espaço que ocupa, não pelo peso (§ 3.13). */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Comp. (cm)</label>
                    <input type="number" min="0" step="1" placeholder="—" className="input" value={newOrderC}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setNewOrderC(e.target.value); setNewOrderQuote(null); }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Larg. (cm)</label>
                    <input type="number" min="0" step="1" placeholder="—" className="input" value={newOrderL}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setNewOrderL(e.target.value); setNewOrderQuote(null); }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Alt. (cm)</label>
                    <input type="number" min="0" step="1" placeholder="—" className="input" value={newOrderA}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setNewOrderA(e.target.value); setNewOrderQuote(null); }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Distância (km)</label>
                    <input type="number" min="0" step="0.1" placeholder="—" className="input" value={newOrderKm}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setNewOrderKm(e.target.value); setNewOrderQuote(null); }} />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={calcularOrcamento} disabled={!newOrderZone || quoting}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50 transition-colors">
                    {quoting ? 'A calcular...' : 'Calcular orçamento'}
                  </button>
                  {newOrderQuote && (
                    <span className="text-xs text-slate-300">
                      Total: <strong className="text-emerald-400 font-mono">{new Intl.NumberFormat('pt-MZ', { style: 'currency', currency: 'MZN' }).format(newOrderQuote.total_cents / 100)}</strong>
                    </span>
                  )}
                </div>
                {newOrderQuote && (
                  <div className="flex flex-col gap-0.5">
                    <p className="text-[10px] text-slate-500">
                      Base {newOrderQuote.base_cents / 100} + peso {newOrderQuote.weight_cents / 100}
                      {newOrderQuote.distance_cents > 0 ? ` + distância ${newOrderQuote.distance_cents / 100}` : ''}
                      {newOrderQuote.service_cents > 0 ? ` + serviço ${newOrderQuote.service_cents / 100}` : ''} MZN · preenche o valor abaixo.
                    </p>
                    {/* Os dois pesos: sem eles, a fatura de uma caixa leve e
                        volumosa não tem como se explicar ao cliente. */}
                    {newOrderQuote.charged_by_volume && (
                      <p className="text-[10px] text-amber-400">
                        Cobrado por volume: real {(newOrderQuote.weight_grams / 1000).toFixed(1)} kg ·
                        volumétrico {(newOrderQuote.volumetric_grams / 1000).toFixed(1)} kg.
                      </p>
                    )}
                    {newOrderQuote.contract_code && (
                      <p className="text-[10px] text-brand-300">
                        Contrato {newOrderQuote.contract_code}
                        {(newOrderQuote.contract_discount_cents ?? 0) > 0 ? ` · desconto ${(newOrderQuote.contract_discount_cents ?? 0) / 100} MZN` : ''}
                        {newOrderQuote.negotiated_zone_rate ? ' · tarifa negociada' : ''}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Valor Estimado (em centavos, ex: 2990 = 29,90 MT)</label>
                <input
                  type="number"
                  placeholder="2990"
                  className="input"
                  value={newOrderValor}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrderValor(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">A cobrar na entrega — COD (centavos; 0 = sem cobrança)</label>
                <input
                  type="number"
                  min={0}
                  placeholder="0"
                  className="input"
                  value={newOrderCod}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrderCod(e.target.value)}
                />
                <span className="text-[10px] text-slate-500 mt-1 block">O motorista recolhe este valor na entrega (numerário ou mobile money).</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Telefone do cliente</label>
                  <input
                    type="tel"
                    placeholder="+258 84 000 0000"
                    className="input"
                    value={newOrderPhone}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrderPhone(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Email do cliente</label>
                  <input
                    type="email"
                    placeholder="cliente@exemplo.mz"
                    className="input"
                    value={newOrderEmail}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewOrderEmail(e.target.value)}
                  />
                </div>
              </div>
              <span className="text-[10px] text-slate-500 -mt-2 block">Usados para avisar por SMS/email quando a encomenda dá entrada no armazém.</span>

              <div className="flex gap-3 justify-end mt-4">
                <button 
                  type="button" 
                  onClick={() => setIsModalOpen(false)}
                  className="btn btn-secondary"
                  disabled={isSubmitting}
                >
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Salvando...' : 'Salvar Pedido'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Details/Timeline Modal */}
      {selectedPedido && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-2xl card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5 max-h-[88vh] overflow-y-auto">
            
            {/* Header */}
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Detalhes do Pedido</span>
                <h2 className="text-xl font-extrabold text-slate-100 font-mono mt-0.5">{selectedPedido.trackingCode}</h2>
              </div>
              <button
                onClick={() => { setSelectedPedido(null); setInvoiceMsg(''); }}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-2 gap-4 bg-surface/50 border border-white/[0.04] rounded-xl p-4 text-xs">
              <div>
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Cliente</span>
                <span className="font-semibold text-slate-200 mt-1 block">{selectedPedido.client}</span>
              </div>
              <div>
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Destino</span>
                <span className="font-semibold text-slate-200 mt-1 block">{selectedPedido.destination}</span>
              </div>
              <div>
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Motorista</span>
                <span className="font-semibold text-slate-200 mt-1 block">
                  {driverNameOf(selectedPedido) || 'Não atribuído'}
                </span>
              </div>
              <div>
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Valor Declarado</span>
                <span className="font-semibold text-slate-200 mt-1 block">{formatCurrency(selectedPedido.value)}</span>
              </div>
              {warehouseLocationOf(selectedPedido) && (
                <div className="col-span-2">
                  <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Armazém atual</span>
                  <span className="font-semibold text-amber-400 mt-1 flex items-center gap-1"><LocationPin className="w-3.5 h-3.5 shrink-0" /> {warehouseLocationOf(selectedPedido)}</span>
                </div>
              )}
            </div>

            {/* Faturação (spec § 3.14) + Etiqueta (spec § 3.15) */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.04] bg-surface/50 p-3">
              <div>
                <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Documentos</span>
                <span className="text-xs text-slate-400">{invoiceMsg || 'Fatura-recibo (IVA 16%) e etiqueta com código de barras.'}</span>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => printLabels([pedidoToLabel(selectedPedido)])}
                  className="text-xs font-semibold px-3 py-2 rounded-lg bg-surface-elevated text-slate-200 hover:bg-white/10 transition-colors">
                  Imprimir etiqueta
                </button>
                <button type="button" onClick={() => gerarFatura(selectedPedido)} disabled={invoiceBusy}
                  className="text-xs font-semibold px-3 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50 transition-colors">
                  {invoiceBusy ? 'A emitir...' : 'Gerar fatura'}
                </button>
              </div>
            </div>

            {/* Reagendar ou devolver (§ 3.37). Só num pedido falhado: é a única
                situação em que estas duas saídas fazem sentido. */}
            {selectedPedido.status === 'failed' && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-amber-300">Entrega falhada</h4>
                  <span className="text-[11px] text-slate-400">
                    {selectedPedido.deliveryAttempts ?? 0} tentativa(s)
                  </span>
                </div>

                {redeliveryErro && <p role="alert" className="text-xs text-red-400">{redeliveryErro}</p>}

                <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                  <div className="flex-1">
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                      Nova tentativa
                    </label>
                    <input type="date" className="input text-xs" value={reagendarData}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReagendarData(e.target.value)} />
                  </div>
                  <button type="button" disabled={!reagendarData || redeliveryBusy}
                    onClick={() => acaoRedelivery(() => adminApi.rescheduleDelivery(selectedPedido.id, reagendarData))}
                    className="text-xs font-semibold px-3 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50 transition-colors">
                    Reagendar
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 sm:items-end border-t border-white/[0.06] pt-3">
                  <div className="flex-1">
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                      Devolver ao remetente
                    </label>
                    <select className="input text-xs" value={devolucaoMotivo}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDevolucaoMotivo(e.target.value as ReturnReason)}>
                      {(Object.keys(RETURN_REASON_LABELS) as ReturnReason[]).map((r) => (
                        <option key={r} value={r}>{RETURN_REASON_LABELS[r]}</option>
                      ))}
                    </select>
                  </div>
                  <button type="button" disabled={redeliveryBusy}
                    onClick={() => acaoRedelivery(() => adminApi.iniciarDevolucao(selectedPedido.id, devolucaoMotivo))}
                    className="text-xs font-semibold px-3 py-2 rounded-lg bg-surface-elevated text-slate-200 border border-white/10 hover:bg-surface-overlay disabled:opacity-50 transition-colors">
                    Iniciar devolução
                  </button>
                </div>
              </div>
            )}

            {/* Devolução em curso: falta confirmar quem a recebeu de volta. */}
            {selectedPedido.returnInfo && !selectedPedido.returnInfo.received_at && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 flex flex-col gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-amber-300">Devolução em curso</h4>
                <p className="text-[11px] text-slate-400">
                  Motivo: {RETURN_REASON_LABELS[selectedPedido.returnInfo.reason]}. A encomenda está a caminho do remetente.
                </p>
                {redeliveryErro && <p role="alert" className="text-xs text-red-400">{redeliveryErro}</p>}
                <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                  <div className="flex-1">
                    <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                      Quem recebeu de volta
                    </label>
                    <input className="input text-xs" placeholder="Nome de quem recebeu" value={devolucaoRecebidoPor}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevolucaoRecebidoPor(e.target.value)} />
                  </div>
                  <button type="button" disabled={!devolucaoRecebidoPor.trim() || redeliveryBusy}
                    onClick={() => acaoRedelivery(() => adminApi.confirmarDevolucao(selectedPedido.id, devolucaoRecebidoPor.trim()))}
                    className="text-xs font-semibold px-3 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50 transition-colors">
                    Confirmar devolução
                  </button>
                </div>
              </div>
            )}

            {/* Devolvida: o registo do que aconteceu, incluindo a fatura por decidir. */}
            {selectedPedido.returnInfo?.received_at && (
              <div className="rounded-xl border border-white/10 bg-surface-elevated p-4 flex flex-col gap-1">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300">Devolvida ao remetente</h4>
                <p className="text-[11px] text-slate-400">
                  {RETURN_REASON_LABELS[selectedPedido.returnInfo.reason]} · recebida por {selectedPedido.returnInfo.received_by}
                </p>
                {selectedPedido.returnInfo.invoice_alert && (
                  <p className="text-[11px] text-amber-300 mt-1">
                    Fatura {selectedPedido.returnInfo.invoice_alert.number} continua ativa —
                    emitir nota de crédito se a política da empresa o exigir.
                  </p>
                )}
              </div>
            )}

            {/* Comprovativo de entrega (POD) */}
            {selectedPedido.pod && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-300">Comprovativo de entrega</h3>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Recebido por</span>
                    <span className="font-semibold text-slate-100 mt-1 block">{selectedPedido.pod.recipient_name}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Registado em</span>
                    <span className="font-semibold text-slate-200 mt-1 block">{trackingDate(selectedPedido.pod.captured_at).date} {trackingDate(selectedPedido.pod.captured_at).time}</span>
                  </div>
                </div>
                {/* As imagens não vêm na listagem (spec § 3.28) — chegam por getOrderPod
                    quando este modal abre, para o ecrã de pedidos não arrastar megabytes. */}
                {(selectedPedido.pod.has_signature || selectedPedido.pod.has_photo) && (
                  <div className="flex gap-4 mt-3">
                    {podLoading && <span className="text-[11px] text-slate-500 self-center">A carregar comprovativo...</span>}
                    {podError && <span role="alert" className="text-[11px] text-red-400 self-center">{podError}</span>}
                    {podImages?.signature && (
                      <div>
                        <span className="block text-[10px] text-slate-500 mb-1">Assinatura</span>
                        {/* eslint-disable-next-line @next/next/no-img-element -- A imagem é um data: URL vindo do POD — next/image não otimiza data URLs. */}
                        <img src={podImages.signature} alt="Assinatura do destinatário" className="h-16 rounded-lg bg-surface border border-white/10" />
                      </div>
                    )}
                    {podImages?.photo && (
                      <div>
                        <span className="block text-[10px] text-slate-500 mb-1">Foto</span>
                        {/* eslint-disable-next-line @next/next/no-img-element -- A imagem é um data: URL vindo do POD — next/image não otimiza data URLs. */}
                        <img src={podImages.photo} alt="Foto da entrega" className="h-16 w-16 rounded-lg object-cover border border-white/10" />
                      </div>
                    )}
                  </div>
                )}
                {selectedPedido.pod.notes && <p className="text-[11px] text-slate-400 mt-3">{selectedPedido.pod.notes}</p>}
              </div>
            )}

            {/* COD — cobrança na entrega */}
            {(selectedPedido.codAmount ?? 0) > 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 flex items-center justify-between gap-3 text-xs">
                <div>
                  <span className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wide">A cobrar na entrega (COD)</span>
                  <span className="font-bold text-slate-100 mt-1 block">{formatCurrency(selectedPedido.codAmount ?? 0)}</span>
                </div>
                <div className="text-right">
                  {selectedPedido.cod ? (
                    <>
                      <span className="badge badge-success">Cobrado · {COD_METHOD_LABELS[selectedPedido.cod.method]}</span>
                      <span className="block text-[10px] text-slate-500 mt-1">
                        {selectedPedido.codStatus === 'settled' ? 'Incluído num acerto' : 'Por acertar'}
                      </span>
                    </>
                  ) : (
                    <span className="badge badge-warning">Por cobrar</span>
                  )}
                </div>
              </div>
            )}

            {/* Timeline History */}
            <div className="flex flex-col gap-4">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Histórico de Rastreamento</h3>
                  <p className="text-[11px] text-slate-500 mt-1">Linha cronológica auditável, com os movimentos mais recentes primeiro.</p>
                </div>
                <span className="text-[11px] text-slate-500 whitespace-nowrap">
                  {selectedHistory.length} {selectedHistory.length === 1 ? 'movimento' : 'movimentos'}
                </span>
              </div>

              {selectedHistory.length > 0 ? (
                <div className="relative flex flex-col gap-4 pl-11">
                  <div className="absolute left-[17px] top-5 bottom-5 w-px bg-gradient-to-b from-brand-500/60 via-white/10 to-transparent" />
                  {selectedHistory.map((evt: HistoricoItem, idx) => {
                    const statusMeta = STATUS_LABELS[evt.status] || { label: evt.status, badgeClass: 'badge-neutral' };
                    const isLatest = idx === 0;
                    const originKey = evt.event_origin ?? (evt.user_id ? 'DRIVER' : 'SYSTEM');
                    const origin = EVENT_ORIGINS[originKey] ?? EVENT_ORIGINS.SYSTEM;
                    const occurred = trackingDate(evt.device_timestamp ?? evt.timestamp);
                    const registered = trackingDate(evt.timestamp);
                    const location = trackingLocationLabel(evt.location);
                    const actor = evt.user_id
                      ? motoristas.find((driver) => driver.id === evt.user_id)?.name
                      : null;

                    return (
                      <div
                        key={evt.id ?? evt.hash ?? `${evt.status}-${evt.timestamp}-${idx}`}
                        className={`relative rounded-2xl border p-4 ${
                          isLatest
                            ? 'border-brand-500/25 bg-brand-500/[0.045] shadow-lg shadow-brand-950/10'
                            : 'border-white/[0.06] bg-surface/50'
                        }`}
                      >
                        <div className={`absolute -left-[43px] top-4 w-9 h-9 rounded-xl flex items-center justify-center border-2 z-10 ${
                          isLatest
                            ? 'bg-brand-600 border-brand-400 text-white ring-4 ring-brand-500/15'
                            : 'bg-surface-elevated border-white/10 text-slate-500'
                        }`}>
                          <TrackingEventIcon status={evt.status} />
                        </div>

                        <div className="flex flex-col gap-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`badge ${statusMeta.badgeClass} text-[9px]`}>
                              {statusMeta.label}
                              </span>
                              {isLatest && (
                                <span className="text-[9px] font-bold uppercase tracking-widest text-brand-300">Estado atual</span>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[11px] font-semibold text-slate-300">{occurred.date}</p>
                              {occurred.time && <p className="text-[10px] font-mono text-slate-500 mt-0.5">{occurred.time}</p>}
                            </div>
                          </div>

                          <p className="text-sm text-slate-200 font-medium leading-relaxed">
                            {trackingDescription(evt.description, evt.status)}
                          </p>

                          {location && (
                            <div className="flex items-start gap-2 rounded-xl bg-surface-elevated/70 border border-white/[0.04] px-3 py-2">
                              <LocationPin className="w-3.5 h-3.5 shrink-0 text-brand-400 mt-px" />
                              <span className="text-[11px] text-slate-400 font-medium">{location}</span>
                            </div>
                          )}

                          <div className="flex items-center gap-x-3 gap-y-2 flex-wrap pt-2 border-t border-white/[0.05]">
                            <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${origin.className}`}>
                              {origin.label}
                            </span>
                            {actor && <span className="text-[10px] text-slate-400">Responsável: <strong className="text-slate-300">{actor}</strong></span>}
                            {evt.device_id && <span className="text-[10px] text-slate-500 font-mono" title={evt.device_id}>Dispositivo {evt.device_id.slice(-8)}</span>}
                            {evt.device_timestamp && evt.device_timestamp !== evt.timestamp && (
                              <span className="text-[10px] text-slate-500" title={`Registado no servidor em ${registered.date} ${registered.time}`}>
                                Sincronizado posteriormente
                              </span>
                            )}
                            {evt.hash && (
                              <span className="text-[10px] text-slate-600 font-mono ml-auto" title={evt.hash}>
                                registo {evt.hash.slice(0, 10)}…
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-500 text-center py-4 bg-surface/30 rounded-xl">
                  Nenhum evento de rastreio registrado para este pedido.
                </p>
              )}
            </div>

            <div className="flex justify-end mt-2">
              <button
                onClick={() => setSelectedPedido(null)}
                className="btn btn-secondary w-full sm:w-auto"
              >
                Fechar Detalhes
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Warehouse Shipment Modal (spec § 8.2 — Solicitar Envio ao Chegar no Armazém) */}
      {warehousePedido && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-md card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Solicitar Envio no Armazém</span>
                <h2 className="text-lg font-bold text-slate-100 font-mono mt-0.5">{warehousePedido.trackingCode}</h2>
              </div>
              <button
                onClick={() => setWarehousePedido(null)}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="bg-surface/50 border border-white/[0.04] rounded-xl p-3 text-xs flex items-center gap-2">
              <span className="text-amber-400 font-semibold shrink-0 flex items-center gap-1"><LocationPin className="w-3.5 h-3.5" /> No armazém:</span>
              <span className="text-slate-200 font-semibold truncate">{warehouseLocationOf(warehousePedido) || '—'}</span>
            </div>

            {whError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl text-center">
                {whError}
              </div>
            )}

            <form onSubmit={handleRequestShipment} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Destino de entrega</label>
                <input
                  type="text"
                  placeholder="Cidade - UF"
                  className="input"
                  value={whDestino}
                  onChange={(e) => setWhDestino(e.target.value)}
                  required
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Confirma para onde o pedido segue a partir do armazém.
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Coordenadas (opcional)</label>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={captureCurrentLocation}
                    disabled={whGeoLoading}
                    className="btn btn-secondary btn-sm flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8a4 4 0 100 8 4 4 0 000-8z"/>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v3m0 14v3m10-10h-3M5 12H2"/>
                    </svg>
                    {whGeoLoading ? 'A localizar...' : 'Usar a minha localização atual'}
                  </button>
                  {whCoords && (
                    <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {whCoords.lat.toFixed(5)}, {whCoords.lng.toFixed(5)}
                      <button type="button" onClick={() => setWhCoords(null)} className="ml-1 text-slate-500 hover:text-slate-300 font-sans not-italic">remover</button>
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Sem coordenadas, o routes-service não consegue medir a distância (fica 0 km).
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Observação (opcional)</label>
                <input
                  type="text"
                  placeholder="Ex.: Entregar no período da manhã"
                  className="input"
                  value={whNotes}
                  onChange={(e) => setWhNotes(e.target.value)}
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-2 justify-end mt-2">
                {warehousePedido.status === 'at_warehouse' && (
                  <button
                    type="button"
                    onClick={handleHoldForDestination}
                    disabled={whSubmitting}
                    className="btn btn-secondary btn-sm"
                  >
                    Aguardar destino do cliente
                  </button>
                )}
                <button type="submit" disabled={whSubmitting} className="btn btn-primary btn-sm">
                  {whSubmitting ? 'A processar...' : 'Confirmar destino e solicitar envio'}
                </button>
              </div>
            </form>

            <p className="text-[10px] text-slate-600 leading-relaxed">
              Ao confirmar, o pedido passa a <strong className="text-slate-400">Saiu para Entrega</strong> e a rota é recalculada (spec § 8.2).
            </p>
          </div>
        </div>
      )}

      {/* Delivery / POD Modal (spec § 3.1) */}
      {deliveryPedido && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4">
          <div className="w-full max-w-lg card bg-surface-elevated border border-white/[0.08] shadow-2xl p-6 flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-400">Registro de Entrega</span>
                <h2 className="text-lg font-bold text-slate-100 font-mono mt-0.5">{deliveryPedido.trackingCode}</h2>
              </div>
              <button onClick={() => setDeliveryPedido(null)} className="text-slate-500 hover:text-slate-200 transition-colors" aria-label="Fechar">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Segmento: Entregue / Insucesso */}
            <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-surface/60 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => setDeliveryMode('delivered')}
                className={`h-9 rounded-lg text-sm font-semibold transition-colors ${deliveryMode === 'delivered' ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400 hover:text-slate-200'}`}
              >
                Entregue
              </button>
              <button
                type="button"
                onClick={() => setDeliveryMode('failed')}
                className={`h-9 rounded-lg text-sm font-semibold transition-colors ${deliveryMode === 'failed' ? 'bg-red-500/15 text-red-300' : 'text-slate-400 hover:text-slate-200'}`}
              >
                Insucesso
              </button>
            </div>

            {deliveryError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl">{deliveryError}</div>
            )}

            <form onSubmit={handleDeliverySubmit} className="flex flex-col gap-4">
              {deliveryMode === 'delivered' ? (
                <>
                  <Input
                    label="Recebido por"
                    placeholder="Nome de quem recebeu"
                    value={podRecipient}
                    onChange={(e) => setPodRecipient(e.target.value)}
                    required
                  />
                  {deliveryPedido.clientPhone && (
                    <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.05] p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-brand-300">Código de entrega (SMS)</span>
                        <Button type="button" variant="secondary" size="sm" onClick={handleSendOtp} loading={otpSending}>
                          {deliveryPedido.otp?.issued ? 'Reenviar código' : 'Enviar código'}
                        </Button>
                      </div>
                      {otpInfo && <p className="text-[11px] text-emerald-400">{otpInfo}</p>}
                      <Input
                        label="Código recebido pelo cliente"
                        inputMode="numeric"
                        placeholder="000000"
                        className="font-mono tracking-widest"
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      />
                      <span className="text-[10px] text-slate-500">Envie o código, peça-o ao cliente e introduza-o para confirmar. Sem provedor real, o código aparece na tela Mensagens.</span>
                    </div>
                  )}
                  {(deliveryPedido.codAmount ?? 0) > 0 && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-amber-300">A cobrar na entrega</span>
                        <span className="text-sm font-bold text-slate-100">{formatCurrency(deliveryPedido.codAmount ?? 0)}</span>
                      </div>
                      <Select
                        label="Método de cobrança"
                        options={(['CASH', 'MPESA', 'EMOLA', 'MKESH'] as CodMethod[]).map((m) => ({ value: m, label: COD_METHOD_LABELS[m] }))}
                        value={codMethod}
                        onChange={(e) => setCodMethod(e.target.value as CodMethod)}
                      />
                    </div>
                  )}
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">Assinatura</label>
                    <SignaturePad onChange={setPodSignature} />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-400">Foto (opcional)</label>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handlePodPhotoChange}
                      className="block w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-overlay file:px-3 file:py-2 file:text-slate-200 file:cursor-pointer"
                    />
                    {podPhoto && (
                      <div className="mt-2 flex items-center gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element -- A imagem é um data: URL vindo do POD — next/image não otimiza data URLs. */}
                        <img src={podPhoto} alt="Pré-visualização da foto" className="h-14 w-14 rounded-lg object-cover border border-white/10" />
                        <button type="button" onClick={() => setPodPhoto(null)} className="btn btn-ghost btn-sm">Remover</button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button type="button" variant="secondary" size="sm" onClick={captureDeliveryLocation} loading={deliveryGeoLoading}>
                      Capturar GPS
                    </Button>
                    {deliveryCoords && (
                      <span className="text-[11px] font-mono text-emerald-400">
                        {deliveryCoords.lat.toFixed(5)}, {deliveryCoords.lng.toFixed(5)}
                      </span>
                    )}
                  </div>
                  <Input
                    label="Observação (opcional)"
                    placeholder="Ex.: entregue na receção"
                    value={podNotes}
                    onChange={(e) => setPodNotes(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <Select
                    label="Motivo do insucesso"
                    options={FAILURE_REASON_OPTIONS}
                    value={failReason}
                    onChange={(e) => setFailReason(e.target.value as DeliveryFailureReason)}
                  />
                  <Input
                    label="Observação (opcional)"
                    placeholder="Detalhe o que aconteceu"
                    value={podNotes}
                    onChange={(e) => setPodNotes(e.target.value)}
                  />
                </>
              )}

              <div className="flex justify-end gap-2 mt-1">
                <Button type="button" variant="secondary" onClick={() => setDeliveryPedido(null)} disabled={deliverySubmitting}>
                  Cancelar
                </Button>
                <Button type="submit" variant="primary" loading={deliverySubmitting}>
                  {deliveryMode === 'delivered' ? 'Confirmar entrega' : 'Registar insucesso'}
                </Button>
              </div>
            </form>

            <p className="text-[10px] text-slate-600 leading-relaxed">
              {deliveryMode === 'delivered'
                ? 'O comprovativo fica anexado ao pedido e ao histórico auditável (spec § 3.1).'
                : 'O pedido passa a Insucesso, com o motivo registado no histórico.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
