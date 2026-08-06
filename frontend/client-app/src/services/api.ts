const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const API_VERSION = process.env.NEXT_PUBLIC_API_VERSION || 'v1';

// O backend responde em inglês; a UI do cliente usa vocabulário PT. Mapeamos aqui.
const STATUS_PT: Record<string, string> = {
  created:              'Criado',
  collected:            'Coletado',
  in_transit:           'Em Trânsito',
  at_warehouse:         'No Armazém',
  awaiting_destination: 'Aguardando Destino',
  out_for_delivery:     'Saiu para Entrega',
  delivered:            'Entregue',
  failed:               'Insucesso',
  cancelled:            'Cancelado',
};

export interface TrackingEvento {
  status:      string;
  descricao:   string;
  localizacao: string;
  timestamp:   string;
}

/** Comprovativo de entrega (POD) — subconjunto exibido ao cliente. */
export interface TrackingPod {
  recebidoPor:  string;
  assinatura?:  string; // data URL
  foto?:        string; // data URL
  registadoEm:  string;
}

export interface TrackingPedido {
  codigoRastreio: string;
  statusAtual:    string;
  statusCode:     string; // estado cru (inglês) — usado na lógica (ex.: armazém)
  origem:         string;
  destino:        string;
  historico:      TrackingEvento[];
  pod?:           TrackingPod;
}

function formatPlace(p: { city?: string; state?: string } | undefined): string {
  if (!p) return '';
  return [p.city, p.state].filter(Boolean).join(' - ');
}

/** Repara texto legado que foi persistido com caracteres UTF-8 corrompidos. */
function cleanDisplayText(value: unknown): string {
  return String(value ?? '')
    .replace(/Armaz(?:�|Ã©)m/g, 'Armazém')
    .replace(/Armazém Central\s*�\s*Maputo/g, 'Armazém Central - Maputo');
}

/** Normaliza o pedido cru (inglês) do backend para o shape que a UI do cliente usa. */
function mapOrder(o: any): TrackingPedido {
  return {
    codigoRastreio: o.tracking_code ?? '',
    statusCode:     o.current_status ?? '',
    statusAtual:    STATUS_PT[o.current_status] ?? o.current_status ?? '',
    origem:         formatPlace(o.origin),
    destino:        formatPlace(o.destination),
    historico:      (o.history ?? []).map((h: any) => ({
      status:      STATUS_PT[h.status] ?? h.status ?? '',
      descricao:   cleanDisplayText(h.description),
      localizacao: cleanDisplayText(h.location),
      timestamp:   h.timestamp ?? '',
    })),
    pod: o.pod ? {
      recebidoPor: cleanDisplayText(o.pod.recipient_name),
      assinatura:  o.pod.signature,
      foto:        o.pod.photo,
      registadoEm: o.pod.captured_at ?? '',
    } : undefined,
  };
}

export async function fetchTrackingStatus(code: string): Promise<TrackingPedido> {
  const response = await fetch(`${API_URL}/${API_VERSION}/orders/${code}/status`);
  if (!response.ok) {
    throw new Error('Código de rastreio não encontrado no sistema.');
  }
  return mapOrder(await response.json());
}

/**
 * Solicita o envio do pedido para um destino (fluxo do cliente, spec § 8.2).
 * Público, por código de rastreio. `coords` são a localização real de quem confirma.
 */
export async function requestShipment(
  code: string,
  destination: string,
  notes?: string,
  coords?: { lat: number; lng: number },
): Promise<TrackingPedido> {
  const response = await fetch(`${API_URL}/${API_VERSION}/orders/${code}/request-shipment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination, notes, ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data && data.error) || 'Falha ao solicitar o envio.');
  }
  return mapOrder(data);
}

// ─── Chat de suporte (spec § 3.9) ─────────────────────────────────────────────

export type SupportSender = 'client' | 'agent' | 'system' | 'bot';
export type SupportThreadStatus = 'open' | 'resolved';

export interface SupportMessage {
  id: string;
  thread_id: string;
  sender: SupportSender;
  sender_name: string;
  body: string;
  created_at: string;
}

export interface SupportThread {
  id: string;
  client_name: string;
  client_email?: string;
  subject: string;
  order_id?: string;
  tracking_code?: string;
  status: SupportThreadStatus;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  messages: SupportMessage[];
}

export interface OpenSupportPayload {
  client_name: string;
  client_email?: string;
  subject?: string;
  message: string;
  tracking_code?: string;
}

async function supportJson(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || 'Falha na operação de suporte.');
  return data;
}

/** Abre uma conversa. Devolve a conversa + o token de acesso (guardar localmente). */
export async function openSupportThread(payload: OpenSupportPayload): Promise<{ thread: SupportThread; access_token: string }> {
  const res = await fetch(`${API_URL}/${API_VERSION}/support/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return supportJson(res);
}

/** Vê a conversa (mensagens completas) — usado no polling. */
export async function getSupportThread(id: string, token: string): Promise<SupportThread> {
  const res = await fetch(`${API_URL}/${API_VERSION}/support/threads/${id}?token=${encodeURIComponent(token)}`);
  return supportJson(res);
}

/** Cliente responde na conversa. */
export async function replySupportThread(id: string, token: string, body: string): Promise<SupportThread> {
  const res = await fetch(`${API_URL}/${API_VERSION}/support/threads/${id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, body }),
  });
  return supportJson(res);
}
