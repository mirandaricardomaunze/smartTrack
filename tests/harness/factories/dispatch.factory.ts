/**
 * @file dispatch.factory.ts
 * @description Factory do despacho automático.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.38
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** O que o planeador precisa de saber de uma encomenda. */
export interface TestDispatchOrder {
  id: string;
  tracking_code: string;
  current_status: string;
  destination: { city: string };
  weight_grams?: number;
  /** Coordenadas do destino, quando conhecidas. Sem elas não há agrupamento. */
  coords?: { lat: number; lng: number };
  /** Data marcada de nova tentativa (§ 3.37). No futuro = não entra hoje. */
  next_attempt_on?: string;
}

/** O que o planeador precisa de saber de um motorista. */
export interface TestDispatchDriver {
  id: string;
  name: string;
  current_status: 'available' | 'on_route' | 'offline';
  vehicle: { type: string; plate: string; capacity_kg: number };
}

/**
 * Maputo e arredores — coordenadas reais para os agrupamentos fazerem sentido
 * geográfico em vez de saírem de números inventados.
 */
export const MAPUTO_PONTOS = {
  baixa:      { lat: -25.9692, lng: 32.5732 },
  polana:     { lat: -25.9550, lng: 32.5920 },
  sommerchild:{ lat: -25.9480, lng: 32.6010 },
  matola:     { lat: -25.9622, lng: 32.4589 },  // ~12 km a oeste
  marracuene: { lat: -25.7392, lng: 32.6750 },  // ~28 km a norte
};

function amanha(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

let contador = 1;

export class DispatchFactory {
  /** Encomenda pronta a sair, na baixa de Maputo, 5 kg. */
  static order(overrides: Partial<TestDispatchOrder> = {}): TestDispatchOrder {
    const n = contador++;
    return {
      id:             `order-dispatch-${String(n).padStart(4, '0')}`,
      tracking_code:  `TRK94${String(n).padStart(7, '0')}BR`,
      current_status: 'at_warehouse',
      destination:    { city: 'Maputo' },
      weight_grams:   5_000,
      coords:         MAPUTO_PONTOS.baixa,
      ...overrides,
    };
  }

  /** Encomendas espalhadas: três perto umas das outras, uma longe. */
  static clusteredOrders(): TestDispatchOrder[] {
    return [
      DispatchFactory.order({ coords: MAPUTO_PONTOS.baixa }),
      DispatchFactory.order({ coords: MAPUTO_PONTOS.polana }),
      DispatchFactory.order({ coords: MAPUTO_PONTOS.sommerchild }),
      DispatchFactory.order({ coords: MAPUTO_PONTOS.marracuene }),
    ];
  }

  /** Encomenda reagendada para amanhã — não pode entrar na rota de hoje. */
  static scheduledForTomorrow(): TestDispatchOrder {
    return DispatchFactory.order({ next_attempt_on: amanha() });
  }

  /** Encomenda sem peso registado: não consome capacidade nem é recusada. */
  static withoutWeight(): TestDispatchOrder {
    return DispatchFactory.order({ weight_grams: undefined });
  }

  /** Encomenda sem coordenadas: entra por capacidade, fora do agrupamento. */
  static withoutCoords(): TestDispatchOrder {
    return DispatchFactory.order({ coords: undefined });
  }

  /** Motociclista disponível — 25 kg de teto. */
  static driver(overrides: Partial<TestDispatchDriver> = {}): TestDispatchDriver {
    const n = contador++;
    return {
      id:             `driver-dispatch-${String(n).padStart(4, '0')}`,
      name:           `Motorista ${n}`,
      current_status: 'available',
      vehicle:        { type: 'MOTO', plate: `DSP${String(n).padStart(4, '0')}`, capacity_kg: 25 },
      ...overrides,
    };
  }

  /** Motorista de van — 1500 kg, para o caso em que tudo cabe num só. */
  static vanDriver(overrides: Partial<TestDispatchDriver> = {}): TestDispatchDriver {
    return DispatchFactory.driver({ vehicle: { type: 'VAN', plate: 'VAN0001', capacity_kg: 1500 }, ...overrides });
  }

  /** Já em rota: leva carga que o sistema não sabe medir. */
  static busyDriver(): TestDispatchDriver {
    return DispatchFactory.driver({ current_status: 'on_route' });
  }

  static offlineDriver(): TestDispatchDriver {
    return DispatchFactory.driver({ current_status: 'offline' });
  }
}
