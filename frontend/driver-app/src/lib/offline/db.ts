import { openDB, DBSchema, IDBPDatabase } from 'idb';

export interface PendingEvent {
  id: string;
  order_id: string;
  event_type: 'STATUS_UPDATE' | 'LOCATION' | 'PHOTO_CAPTURE' | 'SIGNATURE';
  payload: Record<string, unknown>;
  device_timestamp: string;
  created_at: string;
  sync_attempts: number;
  last_error?: string;
}

export interface ConflictLog {
  id: string;
  order_id: string;
  event_type: string;
  local_value: Record<string, unknown>;
  server_value: Record<string, unknown>;
  resolution: 'LOCAL_WINS' | 'SERVER_WINS';
  resolved_at: string;
}

export interface CachedOrder {
  id: string;
  codigoRastreio: string;
  cliente: string;
  endereco: string;
  status: 'coletado' | 'em_transito' | 'saiu_para_entrega' | 'entregue' | 'insucesso';
  updated_at: string;
  notes?: string;
  reason?: string;
  cod_amount?: number;
}

interface DriverDB extends DBSchema {
  pending_events: {
    key: string;
    value: PendingEvent;
    indexes: { 'by-timestamp': string };
  };
  conflict_log: {
    key: string;
    value: ConflictLog;
  };
  cached_orders: {
    key: string;
    value: CachedOrder;
  };
}

const DB_NAME = 'sistematrack-driver-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<DriverDB>> | null = null;

export function getDB() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('IndexedDB is only available in browser environment'));
  }
  if (!dbPromise) {
    dbPromise = openDB<DriverDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending_events')) {
          const store = db.createObjectStore('pending_events', { keyPath: 'id' });
          store.createIndex('by-timestamp', 'device_timestamp');
        }
        if (!db.objectStoreNames.contains('conflict_log')) {
          db.createObjectStore('conflict_log', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('cached_orders')) {
          db.createObjectStore('cached_orders', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export async function addPendingEvent(event: Omit<PendingEvent, 'id' | 'created_at' | 'sync_attempts'>): Promise<PendingEvent> {
  const db = await getDB();
  const fullEvent: PendingEvent = {
    ...event,
    id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    created_at: new Date().toISOString(),
    sync_attempts: 0,
  };
  await db.put('pending_events', fullEvent);
  return fullEvent;
}

export async function getPendingEvents(): Promise<PendingEvent[]> {
  const db = await getDB();
  const events = await db.getAllFromIndex('pending_events', 'by-timestamp');
  return events;
}

export async function removePendingEvent(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('pending_events', id);
}

export async function recordSyncFailure(ids: string[], message: string, finalFailure: boolean): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('pending_events', 'readwrite');
  for (const id of ids) {
    const event = await tx.store.get(id);
    if (!event) continue;
    event.sync_attempts += 1;
    event.last_error = finalFailure ? `FAILED_SYNC: ${message}` : message;
    await tx.store.put(event);
  }
  await tx.done;
}

export async function countPendingEvents(): Promise<number> {
  const db = await getDB();
  return db.count('pending_events');
}

export async function cacheOrders(orders: CachedOrder[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('cached_orders', 'readwrite');
  for (const order of orders) {
    await tx.store.put(order);
  }
  await tx.done;
}

export async function getCachedOrders(): Promise<CachedOrder[]> {
  const db = await getDB();
  return db.getAll('cached_orders');
}

export async function updateCachedOrderStatus(id: string, status: CachedOrder['status'], notes?: string, reason?: string): Promise<void> {
  const db = await getDB();
  const order = await db.get('cached_orders', id);
  if (order) {
    order.status = status;
    order.updated_at = new Date().toISOString();
    if (notes) order.notes = notes;
    if (reason) order.reason = reason;
    await db.put('cached_orders', order);
  }
}
