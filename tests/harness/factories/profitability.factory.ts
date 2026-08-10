/**
 * @file profitability.factory.ts
 * @description Factory da rentabilidade por pedido, rota, cliente e viatura.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.40
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** Um abastecimento, como fica em `fleet_fuel_entries`. */
export interface TestFuelFill {
  vehicle_id: string;
  fuel_date: string;
  odometer_km: number;
  volume_ml: number;
  cost_cents: number;
  full_tank: boolean;
}

/** Custo por km de uma viatura, com a origem declarada. */
export interface TestVehicleCost {
  vehicle_id: string;
  fuel_cents_per_km: number | null;
  source: 'measured' | 'configured' | 'unknown';
  km_measured?: number;
}

export interface TestCostModel {
  upkeep_cents_per_km: number;
  driver_cost_per_route_cents: number;
}

let contador = 1;

export class ProfitabilityFactory {
  /**
   * Dois abastecimentos de depósito cheio a 400 km de distância, 20.000 no
   * total — dá exatamente 50 centavos/km, um número que se confirma de cabeça.
   */
  static fuelFills(vehicleId = 'vehicle-test-0001'): TestFuelFill[] {
    return [
      { vehicle_id: vehicleId, fuel_date: '2026-08-01', odometer_km: 10_000, volume_ml: 40_000, cost_cents: 8_000, full_tank: true },
      { vehicle_id: vehicleId, fuel_date: '2026-08-10', odometer_km: 10_400, volume_ml: 45_000, cost_cents: 20_000, full_tank: true },
    ];
  }

  /** Um só abastecimento: não há distância entre dois pontos, logo não há custo medido. */
  static singleFill(vehicleId = 'vehicle-test-0002'): TestFuelFill[] {
    return [
      { vehicle_id: vehicleId, fuel_date: '2026-08-01', odometer_km: 5_000, volume_ml: 30_000, cost_cents: 6_000, full_tank: true },
    ];
  }

  /**
   * Conta-quilómetros que anda para trás entre registos — acontece quando
   * alguém escreve o valor errado, e não pode produzir um custo negativo.
   */
  static fillsWithBadOdometer(vehicleId = 'vehicle-test-0003'): TestFuelFill[] {
    return [
      { vehicle_id: vehicleId, fuel_date: '2026-08-01', odometer_km: 20_000, volume_ml: 40_000, cost_cents: 8_000, full_tank: true },
      { vehicle_id: vehicleId, fuel_date: '2026-08-10', odometer_km: 19_500, volume_ml: 40_000, cost_cents: 8_000, full_tank: true },
    ];
  }

  /** Modelo de custo com tudo a zero — o estado de uma empresa que ainda não configurou nada. */
  static emptyCostModel(): TestCostModel {
    return { upkeep_cents_per_km: 0, driver_cost_per_route_cents: 0 };
  }

  /** Modelo configurado: 20 centavos/km de desgaste e 500,00 de motorista por rota. */
  static configuredCostModel(): TestCostModel {
    return { upkeep_cents_per_km: 20, driver_cost_per_route_cents: 50_000 };
  }

  static vehicleCost(overrides: Partial<TestVehicleCost> = {}): TestVehicleCost {
    return {
      vehicle_id: `vehicle-test-${String(contador++).padStart(4, '0')}`,
      fuel_cents_per_km: 50,
      source: 'measured',
      km_measured: 400,
      ...overrides,
    };
  }

  /** Rota de 100 km com quatro paradas — o custo reparte-se em quatro partes iguais. */
  static route(stops = 4) {
    return {
      id: `route-test-${String(contador++).padStart(4, '0')}`,
      distance_km: 100,
      stops: Array.from({ length: stops }, (_, i) => ({ order_id: `order-prof-${i + 1}` })),
    };
  }
}
