import type { TestOrder } from '../factories/order.factory';

export class OfflineSyncRepositoryMock {
  private readonly processed = new Set<string>();
  readonly orders = new Map<string, TestOrder>();

  constructor(order: TestOrder) { this.orders.set(order.id, { ...order }); }
  async findById(id: string) { return this.orders.get(id); }
  async findByCode(code: string) { return [...this.orders.values()].find((order) => order.tracking_code === code); }
  async latestServerEvent() { return null; }
  async wasProcessed(key: string) { return this.processed.has(key); }
  async markProcessed(dto: { dedupe_key: string }) { this.processed.add(dto.dedupe_key); return true; }
  async applyEvent() { throw new Error('POD final deve usar applyFinalStatus.'); }
  async logConflict() { return undefined; }
  async conflictsForOrder() { return []; }
}
