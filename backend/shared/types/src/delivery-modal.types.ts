/**
 * @file delivery-modal.types.ts
 * @description Tipos dos modais de entrega (motociclo, mototriciclo e viaturas).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.33
 *
 * O modal é o mesmo vocabulário em toda a plataforma: é o `vehicle.type` do
 * motorista (§ 3.32), o `vehicle_type` da frota (§ 3.18), o multiplicador da
 * tarifação (§ 3.13) e o limite que o despacho verifica antes de montar a rota
 * (§ 3.2). Uma tabela só evita que "MOTA" no cadastro e "moto" na frota sejam
 * dois veículos diferentes para o sistema.
 */

/** Modal de entrega. Os dois primeiros são as entregas de duas e três rodas. */
export enum DeliveryModal {
  MOTO         = 'MOTO',          // motociclo — motociclista
  MOTOTRICICLO = 'MOTOTRICICLO',  // triciclo de carga — mototriciclista
  CARRO        = 'CARRO',
  VAN          = 'VAN',
  CAMINHAO     = 'CAMINHAO',
}

/** Categoria de carta de condução exigida (Moçambique). */
export type LicenceCategory = 'A' | 'B' | 'C';

/** Ficha técnica de um modal — os limites que o despacho e a tarifação usam. */
export interface DeliveryModalSpec {
  code: DeliveryModal;
  label: string;                        // rótulo em português para os ecrãs
  operator_label: string;               // como se chama quem conduz
  capacity_kg: number;                  // teto de carga por viagem
  volume_l: number;                     // volume útil do baú/caixa
  max_dimension_cm: number;             // maior lado admissível de um volume
  licence_categories: LicenceCategory[]; // cartas que habilitam a conduzir
  default_fuel: string;
  wheels: number;
  /** Duas/três rodas: sem proteção do compartimento contra chuva e furto. */
  weather_exposed: boolean;
  /** Multiplicador de tarifa por default (§ 3.13), sobreponível por ambiente. */
  price_multiplier: number;
  sort_order: number;
}

/** Resultado da verificação de aptidão de um modal para uma carga. */
export interface ModalFitResult {
  ok: boolean;
  reason?: string;
  /** Modal mais barato que aguenta a carga — sugestão quando `ok` é falso. */
  suggested_modal?: DeliveryModal;
}

/** Carga a verificar contra um modal. Campos ausentes não são verificados. */
export interface ModalLoad {
  weight_grams?: number;
  volume_l?: number;
  longest_side_cm?: number;
}
