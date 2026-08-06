/**
 * @file driver.entity.ts
 * @description Entidade de domínio Motorista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Motorista)
 */

export type DriverStatus = 'DISPONIVEL' | 'EM_ROTA' | 'OFFLINE';

export type VehicleType = 'MOTO' | 'CARRO' | 'VAN' | 'CAMINHAO';

export interface DriverGps {
  lat:       number;
  lng:       number;
  heading:   number; // graus 0-359
  speed:     number; // m/s
  updatedAt: string; // ISO8601 UTC
}

export interface DriverMetrics {
  pontualidade:       number; // 0–100
  taxa_sucesso:       number; // 0–100
  nota_media_cliente: number; // 1–5
  total_entregas:     number;
}

export interface Driver {
  id:                  string;
  nome:                string;
  email:               string;
  telefone:            string;
  veiculo: {
    tipo:          VehicleType;
    placa:         string;
    capacidade_kg: number;
  };
  status_atual:        DriverStatus;
  metricas_desempenho: DriverMetrics;
  gps:                 DriverGps;
  criado_em:           string; // ISO8601 UTC
}

/** DTO de atualização GPS — único campo mutável via API do motorista */
export interface UpdateGpsDTO {
  lat:     number;
  lng:     number;
  heading: number;
  speed:   number;
}

export class DriverNotFoundError extends Error {
  constructor(id: string) {
    super(`Motorista não encontrado: ${id}`);
    this.name = 'DriverNotFoundError';
  }
}

/**
 * Aplica nova posição GPS ao motorista.
 * Retorna novo objeto (imutável) — não muta o original.
 */
export function applyGpsUpdate(driver: Driver, dto: UpdateGpsDTO): Driver {
  return {
    ...driver,
    gps: {
      lat:       dto.lat,
      lng:       dto.lng,
      heading:   dto.heading,
      speed:     dto.speed,
      updatedAt: new Date().toISOString(),
    },
  };
}
