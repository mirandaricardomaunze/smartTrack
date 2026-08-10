/**
 * @file inventory.service.spec.ts
 * @description Testes unitários do núcleo do inventário.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * `reconcile` é a peça que dá sentido tanto à conferência de uma transferência
 * como à contagem de um armazém — é a mesma operação, e é aqui que se afirma o
 * que ela considera em falta, a mais, e conferido. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { InventoryFactory } from '../../../../tests/harness';

const { reconcile, ageInventory, generateTransferCode } = require('./inventory.service');

describe('Inventário · reconciliação', () => {
  it('should report a clean match when everything arrived', () => {
    const { expected, scanned } = InventoryFactory.perfectReconciliation();
    const r = reconcile(expected, scanned);

    expect(r.ok).toBe(true);
    expect(r.found).toHaveLength(3);
    expect(r.missing).toEqual([]);
    expect(r.unexpected).toEqual([]);
  });

  it('should name what is missing — the reason the transfer exists', () => {
    const { expected, scanned } = InventoryFactory.withMissing();
    const r = reconcile(expected, scanned);

    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['TRK2']);
    expect(r.found).toEqual(['TRK1', 'TRK3']);
  });

  it('should name what arrived without being on the manifest', () => {
    const { expected, scanned } = InventoryFactory.withUnexpected();
    const r = reconcile(expected, scanned);

    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(['TRK9']);
  });

  it('should absorb a label scanned twice', () => {
    // Ler duas vezes a mesma etiqueta é o que acontece num armazém; contá-la
    // duas vezes produziria uma divergência que não existe.
    const { expected, scanned } = InventoryFactory.withDuplicateScans();
    const r = reconcile(expected, scanned);

    expect(r.ok).toBe(true);
    expect(r.scanned_count).toBe(2);
  });

  it('should treat an extra parcel as wrong, not as a bonus', () => {
    // Um armazém com uma encomenda a mais está tão errado como um com uma a
    // menos: aquela encomenda devia estar noutro sítio.
    const r = reconcile(['TRK1'], ['TRK1', 'TRK2']);
    expect(r.ok).toBe(false);
  });

  it('should survive empty and missing inputs', () => {
    expect(reconcile([], []).ok).toBe(true);
    expect(reconcile(undefined as unknown as string[], undefined as unknown as string[]).ok).toBe(true);
  });

  it('should ignore blanks instead of counting them as parcels', () => {
    // Um leitor de mão manda por vezes uma linha vazia; contá-la como código
    // daria uma encomenda fantasma em falta.
    const r = reconcile(['TRK1', '', null as unknown as string], ['TRK1']);
    expect(r.expected_count).toBe(1);
    expect(r.ok).toBe(true);
  });
});

describe('Inventário · idade da carga parada', () => {
  const AGORA = Date.parse('2026-08-09T12:00:00.000Z');

  it('should bucket parcels by how long they have been sitting', () => {
    // A ocupação diz quantas estão lá; a idade diz quais é que não deviam estar.
    const r = ageInventory(InventoryFactory.agedInventory(AGORA), new Date(AGORA).toISOString());

    expect(r.buckets).toEqual({ fresh: 2, aging: 1, stale: 1 });
    expect(r.oldest_days).toBe(21);
  });

  it('should list the oldest first — that is the one someone has to go see', () => {
    const r = ageInventory(InventoryFactory.agedInventory(AGORA), new Date(AGORA).toISOString());
    expect(r.items[0].tracking_code).toBe('TRK-STALE-1');
  });

  it('should not report negative ages for a future timestamp', () => {
    // Relógios dessincronizados entre o posto e o servidor acontecem; uma idade
    // negativa aparecia no ecrã como "-2 dias".
    const futuro = [{ id: 'x', tracking_code: 'TRK-X', updated_at: new Date(AGORA + 86_400_000).toISOString() }];
    expect(ageInventory(futuro, new Date(AGORA).toISOString()).items[0].days_in_warehouse).toBe(0);
  });

  it('should handle an empty warehouse', () => {
    const r = ageInventory([], new Date(AGORA).toISOString());
    expect(r.buckets).toEqual({ fresh: 0, aging: 0, stale: 0 });
    expect(r.oldest_days).toBe(0);
  });
});

describe('Inventário · código da transferência', () => {
  it('should carry the year so a code is readable out of context', () => {
    expect(generateTransferCode('2026-08-09T12:00:00.000Z')).toMatch(/^TR2026\/[A-Z0-9]{6}$/);
  });

  it('should not repeat itself across calls', () => {
    const codigos = new Set(Array.from({ length: 50 }, () => generateTransferCode()));
    expect(codigos.size).toBe(50);
  });
});
