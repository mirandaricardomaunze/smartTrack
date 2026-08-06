/**
 * @file useSidebarStats.spec.ts
 * @description Testes unitários do hook useSidebarStats (em Inglês).
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { SidebarStatsFactory } from 'tests/harness/factories/sidebar-stats.factory';
import { useSidebarStats }     from '@/hooks/useSidebarStats';
import { vi, describe, beforeEach, it, expect, afterEach } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mocka fetch global para retornar os payloads de stats */
function mockFetch(
  ordersPayload: unknown,
  driversPayload: unknown,
  status = 200,
) {
  let callCount = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    callCount++;
    const isOrdersCall = callCount % 2 === 1; // alterna: orders, drivers
    const body = isOrdersCall ? ordersPayload : driversPayload;
    return Promise.resolve({
      ok:   status === 200,
      status,
      json: () => Promise.resolve(body),
    });
  }) as any;
}

function restoreFetch() {
  vi.restoreAllMocks();
}

// ─── Testes ──────────────────────────────────────────────────────────────────

describe('useSidebarStats', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('should return null stats while loading', () => {
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as any;
    const { result } = renderHook(() => useSidebarStats());
    expect(result.current.loading).toBe(true);
    expect(result.current.pendingOrders).toBeNull();
    expect(result.current.offlineDrivers).toBeNull();
  });

  it('should populate stats from API responses', async () => {
    const stats = SidebarStatsFactory.build({ pendingOrders: 5, offlineDrivers: 2 });
    const ordersPayload  = { pending: stats.pendingOrders, failed: 0, active: 10 };
    const driversPayload = { offline: stats.offlineDrivers!, on_route: 3, available: 4 };

    mockFetch(ordersPayload, driversPayload);
    const { result } = renderHook(() => useSidebarStats());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.pendingOrders).toBe(5);
    expect(result.current.offlineDrivers).toBe(2);
  });

  it('should apply graceful degradation when orders endpoint fails', async () => {
    global.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('API Error: 503'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ offline: 3, on_route: 1, available: 5 }),
      }) as any;

    const { result } = renderHook(() => useSidebarStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.pendingOrders).toBeNull();
    expect(result.current.offlineDrivers).toBe(3);
  });

  it('should keep null badges when both endpoints return 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok:     false,
      status: 404,
      json:   () => Promise.resolve({}),
    }) as any;

    const { result } = renderHook(() => useSidebarStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.pendingOrders).toBeNull();
    expect(result.current.offlineDrivers).toBeNull();
  });

  it('should refetch stats when refresh() is called', async () => {
    const stats = SidebarStatsFactory.buildClean();
    const ordersPayload  = { pending: stats.pendingOrders, failed: 0, active: 0 };
    const driversPayload = { offline: stats.offlineDrivers, on_route: 0, available: 5 };

    mockFetch(ordersPayload, driversPayload);
    const { result } = renderHook(() => useSidebarStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refresh());
    expect(result.current.loading).toBe(true);
  });

  it('should handle overflow badge values (> 99)', async () => {
    const overflow = SidebarStatsFactory.buildOverflow();
    mockFetch(
      { pending: overflow.pendingOrders, failed: overflow.failedOrders, active: 200 },
      { offline: overflow.offlineDrivers, on_route: 8, available: 2 },
    );

    const { result } = renderHook(() => useSidebarStats());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.pendingOrders).toBe(150);
    expect(result.current.offlineDrivers).toBe(12);
  });
});
