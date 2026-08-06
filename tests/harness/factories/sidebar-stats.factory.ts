/**
 * @file sidebar-stats.factory.ts
 * @description Factory de dados de stats para o hook useSidebarStats (admin panel).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.4 (Painel Administrativo)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Pedido, Motorista)
 *
 * Os tipos são derivados dos contratos do backend:
 * - `pendingOrders`: pedidos com status_atual === OrderStatus.CREATED (spec §4 enum)
 * - `offlineDrivers`: motoristas com status_atual === 'OFFLINE' (spec §7 Motorista)
 * - `failedOrders`: pedidos com status_atual === OrderStatus.FAILED
 *
 * @example
 * import { SidebarStatsFactory } from 'tests/harness/factories/sidebar-stats.factory';
 * const stats = SidebarStatsFactory.build();
 * const alertStats = SidebarStatsFactory.buildWithAlerts();
 * const cleanStats = SidebarStatsFactory.buildClean();
 */

/** Contrato de resposta do endpoint GET /v1/orders/stats */
export interface OrdersStatsResponse {
  /** Pedidos com status_atual === 'criado' (OrderStatus.CREATED) */
  pending: number;
  /** Pedidos com status_atual === 'insucesso' (OrderStatus.FAILED) */
  failed: number;
  /** Total de pedidos ativos (não cancelados, não entregues) */
  active: number;
}

/** Contrato de resposta do endpoint GET /v1/drivers/stats */
export interface DriversStatsResponse {
  /** Motoristas com status_atual === 'OFFLINE' */
  offline: number;
  /** Motoristas com status_atual === 'EM_ROTA' */
  on_route: number;
  /** Motoristas com status_atual === 'DISPONIVEL' */
  available: number;
}

/** Contrato de resposta do endpoint GET /v1/warehouses/stats */
export interface WarehousesStatsResponse {
  /** Total de armazéns cadastrados */
  total: number;
  /** Armazéns com status ACTIVE */
  active: number;
  /** Encomendas atualmente armazenadas (soma das ocupações) */
  storedOrders: number;
  /** Armazéns em lotação (ocupação ≥ 90% da capacidade) */
  nearCapacity: number;
}

/** Shape retornado pelo hook useSidebarStats */
export interface SidebarStats {
  /** Pedidos aguardando processamento (OrderStatus.CREATED) */
  pendingOrders: number;
  /** Motoristas sem conexão (status_atual === 'OFFLINE') */
  offlineDrivers: number;
  /** Pedidos com insucesso na entrega (OrderStatus.FAILED) */
  failedOrders: number;
  /** Armazéns em lotação (ocupação ≥ 90% da capacidade) */
  warehousesNearCapacity: number;
}

export class SidebarStatsFactory {
  /**
   * Stats normais de operação — sem alertas críticos.
   * Usa dados realistas para demonstração do sidebar em dev.
   */
  static build(overrides: Partial<SidebarStats> = {}): SidebarStats {
    return {
      pendingOrders: 3,
      offlineDrivers: 1,
      failedOrders: 0,
      warehousesNearCapacity: 0,
      ...overrides,
    };
  }

  /**
   * Stats com volume alto — simula pico operacional.
   * Útil para testar exibição de badges com contagens grandes (ex: "99+").
   */
  static buildWithAlerts(): SidebarStats {
    return {
      pendingOrders: 47,
      offlineDrivers: 5,
      failedOrders: 8,
      warehousesNearCapacity: 2,
    };
  }

  /**
   * Stats zeradas — operação limpa, sem pendências.
   * Útil para testar que badges não aparecem quando count === 0.
   */
  static buildClean(): SidebarStats {
    return {
      pendingOrders: 0,
      offlineDrivers: 0,
      failedOrders: 0,
      warehousesNearCapacity: 0,
    };
  }

  /**
   * Stats com overflow de badge — valida que "99+" é exibido corretamente.
   */
  static buildOverflow(): SidebarStats {
    return {
      pendingOrders: 150,
      offlineDrivers: 12,
      failedOrders: 23,
      warehousesNearCapacity: 4,
    };
  }

  /** Converte as respostas dos endpoints de stats → SidebarStats */
  static fromApiResponses(
    orders: OrdersStatsResponse,
    drivers: DriversStatsResponse,
    warehouses?: WarehousesStatsResponse,
  ): SidebarStats {
    return {
      pendingOrders: orders.pending,
      offlineDrivers: drivers.offline,
      failedOrders: orders.failed,
      warehousesNearCapacity: warehouses?.nearCapacity ?? 0,
    };
  }
}
