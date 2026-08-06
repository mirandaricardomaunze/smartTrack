/**
 * @file client.types.ts
 * @description Tipos de Cliente/Remetente (registo com contactos e histórico).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.12 (Clientes/Remetentes)
 *
 * Entidade de cliente para reaproveitar contactos, suportar remetentes B2B e
 * apresentar o histórico de encomendas. Um pedido pode referenciar um cliente
 * (`orders.client_ref_id`) mantendo os campos denormalizados para compatibilidade.
 */

/** Pessoa singular ou empresa (remetente B2B). */
export enum ClientType {
  INDIVIDUAL = 'individual',
  BUSINESS   = 'business',
}

export enum ClientStatus {
  ACTIVE   = 'active',
  INACTIVE = 'inactive',
}

/** Morada (recolha/faturação). País por default MZ. */
export interface ClientAddress {
  street?: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface Client {
  id: string;
  name: string;
  type: ClientType;
  email?: string;
  phone?: string;
  tax_id?: string;             // NUIT (Número Único de Identificação Tributária) — MZ
  address?: ClientAddress;
  notes?: string;
  status: ClientStatus;
  order_count?: number;        // agregado derivado (opcional)
  created_at: string;          // ISO8601 UTC
  updated_at: string;          // ISO8601 UTC
}

export interface ClientStats {
  total: number;
  active: number;
  business: number;
}
