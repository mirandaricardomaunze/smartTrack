/**
 * @file useSidebarStats.ts
 * @description Hook que busca contagens de stats para o sidebar do admin panel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 *
 * Tipos alinhados com:
 *   - OrderStatus enum (backend/shared/types/src/order-status.enum.ts)
 *   - TestDriver.status_atual (tests/harness/factories/driver.factory.ts)
 *   - SidebarStats (tests/harness/factories/sidebar-stats.factory.ts)
 *
 * Endpoints:
 *   GET /v1/orders/stats → { pending: number; failed: number; active: number }
 *   GET /v1/drivers/stats → { offline: number; on_route: number; available: number }
 *
 * Graceful degradation: se o endpoint ainda não existir (404/500),
 * retorna null nos contadores — badges não são exibidos (evita dados falsos).
 */
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchApi } from '@/services/api';

/** Shape de resposta de /v1/orders/stats */
interface OrdersStatsResponse {
  /** Pedidos com status_atual === 'criado' (OrderStatus.CREATED) */
  pending: number;
  /** Pedidos com status_atual === 'insucesso' (OrderStatus.FAILED) */
  failed: number;
  /** Total de pedidos ativos */
  active: number;
}

/** Shape de resposta de /v1/drivers/stats */
interface DriversStatsResponse {
  /** Motoristas com status_atual === 'OFFLINE' */
  offline: number;
  /** Motoristas com status_atual === 'EM_ROTA' */
  on_route: number;
  /** Motoristas com status_atual === 'DISPONIVEL' */
  available: number;
}

/** Shape de resposta de /v1/warehouses/stats */
interface WarehousesStatsResponse {
  total: number;
  active: number;
  storedOrders: number;
  /** Armazéns em lotação (ocupação ≥ 90% da capacidade) */
  nearCapacity: number;
}

export interface SidebarStats {
  /** Pedidos pendentes (OrderStatus.CREATED) — null se endpoint indisponível */
  pendingOrders: number | null;
  /** Motoristas offline — null se endpoint indisponível */
  offlineDrivers: number | null;
  /** Pedidos com insucesso — null se endpoint indisponível */
  failedOrders: number | null;
  /** Armazéns em lotação (ocupação ≥ 90%) — null se endpoint indisponível */
  warehousesNearCapacity: number | null;
  /** true durante o fetch inicial */
  loading: boolean;
  /** Força refetch manual */
  refresh: () => void;
}

const REFETCH_INTERVAL_MS = 30_000; // 30s — conforme spec §4 (performance)

export function useSidebarStats(): SidebarStats {
  const [pendingOrders, setPendingOrders] = useState<number | null>(null);
  const [offlineDrivers, setOfflineDrivers] = useState<number | null>(null);
  const [failedOrders, setFailedOrders]   = useState<number | null>(null);
  const [warehousesNearCapacity, setWarehousesNearCapacity] = useState<number | null>(null);
  const [loading, setLoading]             = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      // Fetch em paralelo — independentes, não bloquear um pelo outro
      const [ordersResult, driversResult, warehousesResult] = await Promise.allSettled([
        fetchApi<OrdersStatsResponse>('/orders/stats'),
        fetchApi<DriversStatsResponse>('/drivers/stats'),
        fetchApi<WarehousesStatsResponse>('/warehouses/stats'),
      ]);

      if (ordersResult.status === 'fulfilled') {
        setPendingOrders(ordersResult.value.pending);
        setFailedOrders(ordersResult.value.failed);
      }
      // graceful degradation: se falhar, mantém null — badge não exibido

      if (driversResult.status === 'fulfilled') {
        setOfflineDrivers(driversResult.value.offline);
      }

      if (warehousesResult.status === 'fulfilled' && typeof warehousesResult.value.nearCapacity === 'number') {
        setWarehousesNearCapacity(warehousesResult.value.nearCapacity);
      }
    } catch {
      // Silencioso no sidebar — não quebrar a UI por falha de stats
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    void fetchStats();

    intervalRef.current = setInterval(() => {
      void fetchStats();
    }, REFETCH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStats]);

  return { pendingOrders, offlineDrivers, failedOrders, warehousesNearCapacity, loading, refresh };
}
