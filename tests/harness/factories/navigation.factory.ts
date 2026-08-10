/**
 * @file navigation.factory.ts
 * @description Test factory para a navegação até à morada de entrega.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.2, § 3.6
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** Paragem de rota, na forma em que a app do motorista a recebe. */
export interface TestNavigationStop {
  order_id: string;
  address: string;
  sequence: number;
  status: 'pending' | 'delivered' | 'failed';
  lat: number | null;
  lng: number | null;
}

let _counter = 1;

/** Maputo, Baixa — ponto real, para as asserções serem legíveis. */
export const MAPUTO_COORDS = { lat: -25.9692, lng: 32.5732 };

export class NavigationFactory {
  /** Paragem com coordenadas: o caso normal de uma rota despachada. */
  static build(overrides: Partial<TestNavigationStop> = {}): TestNavigationStop {
    const n = _counter++;
    return {
      order_id:  `ord-nav-${n}`,
      address:   'Av. 25 de Setembro, Maputo',
      sequence:  n,
      status:    'pending',
      lat:       MAPUTO_COORDS.lat,
      lng:       MAPUTO_COORDS.lng,
      ...overrides,
    };
  }

  /** Paragem sem GPS — o que sobra é o texto da morada. */
  static buildWithoutCoords(overrides: Partial<TestNavigationStop> = {}): TestNavigationStop {
    return this.build({ lat: null, lng: null, ...overrides });
  }

  /** Paragem sem nada de útil: nem coordenadas nem morada. */
  static buildUnnavigable(overrides: Partial<TestNavigationStop> = {}): TestNavigationStop {
    return this.build({ lat: null, lng: null, address: '', ...overrides });
  }

  /**
   * Morada em JSONB, como vem no `destination` do pedido. Inclui lat/lng como
   * números para provar que não são arrastados para o texto do endereço.
   */
  static buildDestination(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      street:  'Av. 25 de Setembro, 1234',
      city:    'Maputo',
      state:   'Maputo Cidade',
      country: 'MZ',
      ...overrides,
    };
  }

  /**
   * Coordenadas que têm de ser recusadas: fora de alcance, não numéricas, e o
   * (0,0) — que na prática é sempre campo por preencher.
   */
  static invalidCoordCases(): Array<{ label: string; value: Record<string, unknown> }> {
    return [
      { label: 'ilha nula (0,0)',      value: { lat: 0, lng: 0 } },
      { label: 'latitude fora de alcance',  value: { lat: 120, lng: 32 } },
      { label: 'longitude fora de alcance', value: { lat: -25, lng: 210 } },
      { label: 'texto em vez de número',    value: { lat: 'x', lng: 'y' } },
      { label: 'campos ausentes',           value: {} },
    ];
  }
}
