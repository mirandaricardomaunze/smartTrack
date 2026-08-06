import { addPendingEvent, getPendingEvents, recordSyncFailure, removePendingEvent, updateCachedOrderStatus } from './db';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export interface SyncResult {
  success: boolean;
  syncedCount: number;
  remainingCount: number;
  error?: string;
}

export type OfflineFinalDelivery =
  | { status: 'entregue'; recipient_name: string; signature: string; photo?: string; notes?: string; otp?: string; cod_method?: string; lat?: number; lng?: number }
  | { status: 'insucesso'; reason: string; notes?: string; lat?: number; lng?: number };

/** Guarda o comando completo; nenhum POD é concluído localmente sem ACK. */
export async function queueFinalDelivery(orderId: string, command: OfflineFinalDelivery) {
  const { status, ...payload } = command;
  const event = await addPendingEvent({
    order_id: orderId,
    event_type: 'STATUS_UPDATE',
    payload: { ...payload, new_status: status },
    device_timestamp: new Date().toISOString(),
  });
  await updateCachedOrderStatus(orderId, status, command.notes, command.status === 'insucesso' ? command.reason : undefined);
  return event;
}

function deviceId(): string {
  const key = 'sistematrack:driver-device-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

async function sendBatch(payload: object, token: string | null): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(`${API_URL}/v1/driver-sync/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      if (response.status < 500 || attempt === RETRY_DELAYS_MS.length - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    if (attempt < RETRY_DELAYS_MS.length - 1) {
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] + jitter));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Falha de rede durante sincronização.');
}

export async function processSyncQueue(driverId: string): Promise<SyncResult> {
  if (typeof window === 'undefined' || !navigator.onLine) {
    const pending = await getPendingEvents();
    return { success: false, syncedCount: 0, remainingCount: pending.length, error: 'Dispositivo offline' };
  }

  try {
    const events = await getPendingEvents();
    if (events.length === 0) {
      return { success: true, syncedCount: 0, remainingCount: 0 };
    }

    // Batching max 50 events as per offline-sync-resolver SKILL.md
    const batch = events.slice(0, 50);

    const payload = {
      driver_id: driverId,
      sync_session_id: `sync-session-${Date.now()}`,
      events: batch.map((evt) => ({
        order_id: evt.order_id,
        event_type: evt.event_type,
        payload: evt.payload,
        device_timestamp: evt.device_timestamp,
        device_id: deviceId(),
        correlation_id: `corr-${evt.id}`,
      })),
    };

    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const response = await sendBatch(payload, token);

    if (!response.ok) {
      await recordSyncFailure(batch.map((event) => event.id), `HTTP ${response.status}`, response.status >= 500);
      const remaining = await getPendingEvents();
      return { success: false, syncedCount: 0, remainingCount: remaining.length, error: `HTTP ${response.status}` };
    }

    const ack = await response.json() as { details?: Array<{ correlation_id?: string }> };
    const acknowledged = new Set((ack.details ?? []).map((detail) => detail.correlation_id));
    if (acknowledged.size !== batch.length) {
      const remaining = await getPendingEvents();
      return { success: false, syncedCount: 0, remainingCount: remaining.length, error: 'ACK de sincronização incompleto' };
    }

    // Só remove eventos explicitamente confirmados pelo servidor.
    for (const evt of batch) {
      if (acknowledged.has(`corr-${evt.id}`)) await removePendingEvent(evt.id);
    }

    const remaining = await getPendingEvents();
    return {
      success: true,
      syncedCount: batch.length,
      remainingCount: remaining.length,
    };
  } catch (err) {
    const events = await getPendingEvents().catch(() => []);
    await recordSyncFailure(events.slice(0, 50).map((event) => event.id), err instanceof Error ? err.message : 'Erro de rede', true).catch(() => undefined);
    const remaining = await getPendingEvents().catch(() => []);
    return {
      success: false,
      syncedCount: 0,
      remainingCount: remaining.length,
      error: err instanceof Error ? err.message : 'Erro de rede',
    };
  }
}
