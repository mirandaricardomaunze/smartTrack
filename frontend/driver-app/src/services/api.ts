const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export interface DriverRouteStop {
  order_id: string;
  address: string;
  lat: number | null;
  lng: number | null;
  sequence: number;
  status: 'pending' | 'delivered' | 'failed';
}

export interface DriverRoute {
  id: string;
  driver_id: string;
  status: 'PLANEJADA' | 'EM_ANDAMENTO';
  distance_km: number | null;
  stops: DriverRouteStop[];
  summary: { total: number; delivered: number; failed: number; pending: number };
}

export interface DriverOrder {
  id: string;
  tracking_code: string;
  client: string;
  client_phone: string | null;
  destination: unknown;
  current_status: string;
  value: number;
  cod_amount: number;
  updated_at: string;
}

function token() {
  return typeof window === 'undefined' ? null : localStorage.getItem('token');
}

export function authenticatedDriverId(): string | null {
  const value = token();
  if (!value) return null;
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'DRIVER' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = token();
  if (!accessToken) throw new Error('Sessão do motorista não encontrada.');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Falha na API (${response.status}).`);
  }
  return response.json();
}

export const driverApi = {
  login: async (email: string, password: string) => {
    const response = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Não foi possível autenticar.');
    if (body.user?.role !== 'DRIVER') throw new Error('Esta conta não pertence a um motorista.');
    return body as { token: string; user: { email: string; role: 'DRIVER' } };
  },
  myRoute: () => request<DriverRoute | null>('/v1/routes/me'),
  order: (id: string) => request<DriverOrder>(`/v1/orders/${encodeURIComponent(id)}/driver-view`),
  deliver: (id: string, payload: { recipient_name: string; signature: string; photo?: string; notes?: string; lat?: number; lng?: number; cod_method?: string; otp?: string }) =>
    request(`/v1/orders/${encodeURIComponent(id)}/deliver`, { method: 'POST', body: JSON.stringify(payload) }),
  failDelivery: (id: string, payload: { reason: string; notes?: string }) =>
    request(`/v1/orders/${encodeURIComponent(id)}/delivery-failure`, { method: 'POST', body: JSON.stringify(payload) }),
  updateGps: (driverId: string, location: { lat: number; lng: number; heading: number; speed: number }) =>
    request(`/v1/drivers/${encodeURIComponent(driverId)}/gps`, { method: 'PUT', body: JSON.stringify(location) }),
};

export function formatAddress(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return 'Endereço não informado';
  return Object.values(value as Record<string, unknown>).filter((part) => typeof part === 'string' && part.trim()).join(', ') || 'Endereço não informado';
}
