/**
 * @file warehouse.types.ts
 * @description Tipos compartilhados do domínio de Armazéns (gestão dinâmica).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 8.2 (fluxo de armazém)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Auditabilidade dos movimentos)
 *
 * Um Armazém é uma entidade de primeira classe (cadastro dinâmico) que agrega
 * encomendas fisicamente recebidas. A ocupação é sempre derivada das encomendas
 * cujo `warehouse_id` aponta para o armazém e cujo status é de armazém
 * (AT_WAREHOUSE ou AWAITING_DESTINATION) — nunca um contador mantido à mão.
 */

/** Estado operacional do armazém. */
export enum WarehouseStatus {
  ACTIVE   = 'active',
  INACTIVE = 'inactive',
}

/** Tipo de movimento auditável de encomenda num armazém. */
export enum MovementType {
  /** Entrada: encomenda recebida fisicamente no armazém. */
  INTAKE   = 'intake',
  /** Envio: encomenda expedida (saiu para entrega). */
  DISPATCH = 'dispatch',
  /** Levantado ao balcão pelo cliente (spec § 3.23). */
  PICKUP = 'pickup',
}

/** Endereço simplificado do armazém (alinhado com Order.origin/destination). */
export interface WarehouseAddress {
  city: string;
  state: string;
  country: string;
}

/** Ponto GPS opcional — origem para recálculo de rota na expedição. */
export interface WarehouseGeoPoint {
  lat: number;
  lng: number;
}

/** Entidade Armazém. */
export interface Warehouse {
  id: string;
  /** Código curto e único, ex.: 'WH-MPT'. */
  code: string;
  name: string;
  address: WarehouseAddress;
  /** Capacidade máxima de encomendas. 0 = ilimitada. */
  capacity: number;
  status: WarehouseStatus;
  gps?: WarehouseGeoPoint;
  created_at: string; // ISO8601 UTC
  updated_at: string; // ISO8601 UTC
}

/** Ocupação derivada de um armazém num dado instante. */
export interface WarehouseOccupancy {
  /** Encomendas atualmente dentro (status de armazém). */
  occupancy: number;
  capacity: number;
  /** Percentagem 0–100; 0 quando a capacidade é ilimitada. */
  utilization: number;
  /** true quando ocupação ≥ 90% da capacidade (capacidade finita). */
  near_capacity: boolean;
  /** true quando ocupação ≥ capacidade (capacidade finita). */
  full: boolean;
}

/** Armazém com a sua ocupação derivada — shape devolvido pela listagem. */
export type WarehouseWithOccupancy = Warehouse & WarehouseOccupancy;

/** Registo imutável de um movimento de encomenda (auditoria — spec § 4). */
export interface WarehouseMovement {
  id: string;
  warehouse_id: string;
  order_id: string;
  tracking_code?: string;
  type: MovementType;
  notes?: string;
  /** Utilizador que executou o movimento (operador/admin). */
  user_id?: string;
  created_at: string; // ISO8601 UTC
}

/** Resumo agregado para o painel/sidebar (GET /v1/warehouses/stats). */
export interface WarehouseStats {
  /** Total de armazéns cadastrados. */
  total: number;
  /** Armazéns com status ACTIVE. */
  active: number;
  /** Encomendas atualmente armazenadas (soma das ocupações). */
  storedOrders: number;
  /** Armazéns em lotação (ocupação ≥ 90% da capacidade). */
  nearCapacity: number;
}
