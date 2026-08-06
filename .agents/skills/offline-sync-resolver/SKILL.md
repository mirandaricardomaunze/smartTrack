# SKILL.md — offline-sync-resolver

---
name: offline-sync-resolver
description: >
  Handles the offline-to-online synchronization logic for the Driver App (Next.js PWA).
  Use when writing or reviewing sync queue processing, conflict resolution,
  local IndexedDB schema (idb), or event replay logic in the driver-app or orders-service.
  NOTE: driver-app uses IndexedDB (browser) via the `idb` package — NOT SQLite.
triggers:
  - "offline sync"
  - "sync conflict"
  - "driver app offline"
  - "conflict resolution"
  - "indexeddb"
  - "idb"
  - "event replay"
  - "motorista offline"
  - "sincronização offline"
  - "service worker"
  - "pwa offline"
---

## Objective

Ensure driver-side events captured offline are reliably synchronized to the backend
without data loss, duplication, or silent conflicts.

## Architecture Overview

```
[Driver Device]
  └── SQLite (local DB)
        ├── pending_events (queue)
        ├── conflict_log (audit)
        └── sync_state (cursor)

  On reconnect:
    1. Read pending_events ordered by device_timestamp ASC
    2. POST /v1/sync/driver-events (batch, max 50 per request)
    3. On 200 ACK: delete from pending_events
    4. On 409 CONFLICT: log to conflict_log, apply resolution
    5. On 5xx / timeout: retry with exponential backoff
```

## Local SQLite Schema

```sql
-- driver-app/src/database/schema.sql

CREATE TABLE IF NOT EXISTS pending_events (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  order_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,  -- 'STATUS_UPDATE' | 'PHOTO_CAPTURE' | 'SIGNATURE' | 'LOCATION'
  payload         TEXT NOT NULL,  -- JSON string
  device_timestamp TEXT NOT NULL, -- ISO8601 UTC
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  sync_attempts   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS conflict_log (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  order_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  local_value     TEXT NOT NULL,  -- JSON
  server_value    TEXT NOT NULL,  -- JSON
  resolution      TEXT NOT NULL,  -- 'LOCAL_WINS' | 'SERVER_WINS'
  resolved_at     TEXT NOT NULL DEFAULT (datetime('now', 'utc'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## Conflict Resolution Rules

| Scenario | Resolution Strategy |
|----------|-------------------|
| Same `order_id` + `event_type`, different `device_timestamp` | `LOCAL_WINS` if `device_timestamp` > `server_timestamp`; else `SERVER_WINS` |
| STATUS_UPDATE conflict (e.g., two DELIVERED events) | `SERVER_WINS` — server state is authoritative for delivery confirmation |
| LOCATION conflict | `LOCAL_WINS` — latest GPS reading is always more accurate |
| PHOTO / SIGNATURE conflict | Keep both — store as separate attachments with timestamps |

**Rule for Agents:** Conflict resolution must always be logged to `conflict_log`. Silent discards are forbidden.

## Sync Service Interface (Backend)

```typescript
// services/orders-service/src/application/sync/driver-sync.dto.ts
export class DriverEventDto {
  orderId: string;
  eventType: 'STATUS_UPDATE' | 'PHOTO_CAPTURE' | 'SIGNATURE' | 'LOCATION';
  payload: Record<string, unknown>;
  deviceTimestamp: string; // ISO8601 UTC
  deviceId: string;
  correlationId: string;
}

export class SyncBatchDto {
  events: DriverEventDto[];
  driverId: string;
  syncSessionId: string; // unique per reconnection
}
```

## Retry Policy

```typescript
const RETRY_CONFIG = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30_000,
  jitterMs: 500, // add random jitter to avoid thundering herd
};
```

After `maxAttempts` exceeded: mark event as `FAILED_SYNC`, emit alert to observability.

## Rules for Agents Using This Skill

1. Never mark a sync as successful without server ACK (HTTP 200 or 207 partial success).
2. Always process pending events in `device_timestamp ASC` order.
3. Always batch events (max 50 per request) — never one request per event.
4. Conflicts must be written to `conflict_log` before applying resolution.
5. Sync process must be idempotent: re-running sync on already-synced events must not create duplicates.
6. Add tests in `tests/integration/driver-sync.spec.ts` for: happy path, conflict scenario, network timeout retry.

## Test Scenarios Required

```typescript
describe('DriverSyncService', () => {
  it('should sync pending events in chronological order');
  it('should not duplicate events already acknowledged by server');
  it('should log conflict when server has newer STATUS_UPDATE');
  it('should retry up to maxAttempts on network timeout');
  it('should mark event as FAILED_SYNC after maxAttempts exceeded');
  it('should keep both photo attachments when PHOTO_CAPTURE conflict');
});
```

## References

- `apps/driver-app/src/database/schema.sql`
- `apps/driver-app/src/services/sync.service.ts`
- `services/orders-service/src/application/sync/`
- `tests/integration/driver-sync.spec.ts`
- `tests/harness/fixtures/offline-events-batch.json`
