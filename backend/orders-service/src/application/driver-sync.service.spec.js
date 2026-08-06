/**
 * @file driver-sync.service.spec.js
 * @description Testes do sync offline, dirigidos pelos fixtures do harness.
 *
 * Skill ref: .agents/skills/offline-sync-resolver/SKILL.md § Test Scenarios Required
 *
 * O cenário de conflito vem inteiro de `offline-events-batch.json`: o motorista
 * regista "insucesso" offline às 10:00, mas o servidor já registou "entregue" às
 * 10:05. A skill manda SERVER_WINS — o servidor é autoritativo na entrega — e o
 * conflito TEM de ir para o conflict_log (descartes silenciosos são proibidos).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import offlineBatches from '../../../../tests/harness/fixtures/offline-events-batch.json';

const require = createRequire(import.meta.url);
const service = require('./driver-sync.service.js');

const {
  syncDriverEvents,
  getConflicts,
  configurePorts,
  resetPorts,
  MissingRequiredFieldError,
} = service;

const [happyBatch, conflictBatch] = offlineBatches;

// ─── Fake do repositório ──────────────────────────────────────────────────────

/** @type {Map<string, object>} id → order */
const orders = new Map();
/** @type {Map<string, {status: string, server_timestamp: string}>} order_id → server event */
const serverEvents = new Map();
/** @type {Set<string>} dedupe keys processadas */
const processed = new Set();
/** @type {object[]} conflict_log */
const conflicts = [];
/** @type {object[]} eventos aplicados (timeline) */
const applied = [];

const fakeRepo = {
  async findById(id) { return orders.get(id); },
  async findByCode(code) {
    return [...orders.values()].find((o) => o.tracking_code === code);
  },
  async latestServerEvent(orderId) {
    return serverEvents.get(orderId) ?? null;
  },
  async applyEvent(evento) {
    applied.push(evento);
    const order = orders.get(evento.order_id);
    if (order) order.current_status = evento.status;
    // Espelha o pg.repository: server_timestamp prefere o device_timestamp do
    // evento aplicado (COALESCE(device_timestamp, created_at)).
    serverEvents.set(evento.order_id, {
      status: evento.status,
      server_timestamp: evento.device_timestamp ?? new Date().toISOString(),
    });
    return order;
  },
  async wasProcessed(key) { return processed.has(key); },
  async markProcessed(dto) {
    if (processed.has(dto.dedupe_key)) return false;
    processed.add(dto.dedupe_key);
    return true;
  },
  async logConflict(entry) { conflicts.push(entry); },
  async conflictsForOrder(orderId) {
    return conflicts.filter((c) => c.order_id === orderId);
  },
};

/** Repõe o estado e semeia os pedidos dos fixtures. */
function seed() {
  orders.clear();
  serverEvents.clear();
  processed.clear();
  conflicts.length = 0;
  applied.length = 0;

  // Pedido do cenário feliz — começa em 'created'
  orders.set('order-test-uuid-0001', {
    id: 'order-test-uuid-0001', tracking_code: 'TRK00000001BR',
    client_id: 'c1', current_status: 'created', driver_id: 'driver-test-uuid-0001',
  });

  // Pedido do cenário de conflito — o servidor JÁ o marcou como entregue às 10:05
  orders.set('order-test-uuid-0002', {
    id: 'order-test-uuid-0002', tracking_code: 'LX987654321CN',
    client_id: 'c2', current_status: 'delivered', driver_id: 'driver-test-uuid-0002',
  });
  serverEvents.set('order-test-uuid-0002', {
    status: 'delivered',
    server_timestamp: conflictBatch.server_concurrent_event.server_timestamp, // 10:05
  });
}

beforeEach(() => {
  resetPorts();
  configurePorts({ repo: fakeRepo });
  seed();
});

// ─── Validação do lote ────────────────────────────────────────────────────────

describe('syncDriverEvents — validação', () => {
  it('should reject a batch without events', async () => {
    await expect(syncDriverEvents({})).rejects.toThrow(MissingRequiredFieldError);
  });

  it('should reject a batch over the max size', async () => {
    const events = Array.from({ length: 51 }, (_, i) => ({
      order_id: 'order-test-uuid-0001', event_type: 'LOCATION',
      device_timestamp: new Date(Date.now() + i).toISOString(),
    }));

    await expect(syncDriverEvents({ events })).rejects.toThrow(/máximo 50/);
  });
});

// ─── Cenário feliz (fixture batch 1) ──────────────────────────────────────────

describe('syncDriverEvents — cenário feliz do fixture', () => {
  it('should apply the collection and location events', async () => {
    const r = await syncDriverEvents(happyBatch);

    // coletado (created→collected) aplica; LOCATION aplica sem mudar status
    const coletado = r.details.find((d) => d.new_status === 'collected');
    expect(coletado.outcome).toBe('applied');

    expect(orders.get('order-test-uuid-0001').current_status).toBe('collected');
  });

  it('should refuse to skip in_transit when going straight to out_for_delivery', async () => {
    // A máquina de estados é estrita: collected → out_for_delivery é inválido.
    // O sync não pode "saltar" estados só porque o motorista os pulou offline.
    const r = await syncDriverEvents(happyBatch);

    const saiu = r.details.find((d) => d.reason && d.reason.includes('Transição inválida'));
    expect(saiu).toBeTruthy();
    expect(saiu.reason).toMatch(/collected → out_for_delivery/);
  });
});

// ─── Cenário de conflito (fixture batch 2) ────────────────────────────────────

describe('syncDriverEvents — cenário de conflito do fixture', () => {
  it('should let the server win over a stale offline failure', async () => {
    // Device: insucesso @10:00; Server: entregue @10:05 → SERVER_WINS
    const r = await syncDriverEvents(conflictBatch);

    expect(r.applied).toBe(0);
    expect(r.conflicts).toBe(1);

    const detalhe = r.details[0];
    expect(detalhe.outcome).toBe('skipped');
    expect(detalhe.resolution).toBe('SERVER_WINS');
  });

  it('should keep the order delivered, not overwrite with failed', async () => {
    await syncDriverEvents(conflictBatch);

    // O estado autoritativo do servidor não foi desfeito
    expect(orders.get('order-test-uuid-0002').current_status).toBe('delivered');
  });

  it('should log the conflict — silent discards are forbidden (skill rule 4)', async () => {
    await syncDriverEvents(conflictBatch);

    const registados = await getConflicts('order-test-uuid-0002');
    expect(registados).toHaveLength(1);
    expect(registados[0].resolution).toBe('SERVER_WINS');
    expect(registados[0].reason).toMatch(/entrega/i);
    // O valor local é preservado para auditoria
    expect(registados[0].local_value).toBeTruthy();
  });
});

// ─── Idempotência (skill regra 5) ─────────────────────────────────────────────

describe('syncDriverEvents — idempotência', () => {
  it('should not reapply events when the same batch is sent twice', async () => {
    const primeira = await syncDriverEvents(happyBatch);
    const aplicadosApos1 = applied.length;

    const segunda = await syncDriverEvents(happyBatch);

    // A segunda passagem vê tudo como duplicado
    expect(segunda.applied).toBe(0);
    expect(segunda.duplicates).toBeGreaterThan(0);
    // Nada de novo foi aplicado à timeline
    expect(applied.length).toBe(aplicadosApos1);
    expect(primeira.applied).toBeGreaterThan(0);
  });
});

// ─── Ordenação cronológica (skill regra 2) ────────────────────────────────────

describe('syncDriverEvents — ordem cronológica', () => {
  it('should process events oldest-first regardless of arrival order', async () => {
    // Enviar o lote feliz ao contrário não deve mudar o resultado
    const baralhado = { ...happyBatch, events: [...happyBatch.events].reverse() };
    const r = await syncDriverEvents(baralhado);

    // A coleta (a mais antiga) foi aplicada antes da tentativa de saída
    const coletado = r.details.find((d) => d.new_status === 'collected');
    expect(coletado.outcome).toBe('applied');
    expect(orders.get('order-test-uuid-0001').current_status).toBe('collected');
  });
});
