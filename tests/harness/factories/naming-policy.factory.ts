export interface NamingPolicyScenario {
  identifier: string;
  expected: 'compliant' | 'violation' | 'exempt';
}

/** Canonical cases for the code-language policy. */
export class NamingPolicyFactory {
  static build(overrides: Partial<NamingPolicyScenario> = {}): NamingPolicyScenario {
    return {
      identifier: 'calculateDeliveryPrice',
      expected: 'compliant',
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<NamingPolicyScenario> = {}): NamingPolicyScenario[] {
    return Array.from({ length: count }, (_, index) => this.build({
      identifier: `deliveryAttempt${index + 1}`,
      ...overrides,
    }));
  }

  static canonicalCases(): NamingPolicyScenario[] {
    return [
      this.build(),
      this.build({ identifier: 'pendingOrders', expected: 'compliant' }),
      this.build({ identifier: 'isDriverAvailable', expected: 'compliant' }),
      this.build({ identifier: 'calcularPrecoEntrega', expected: 'violation' }),
      this.build({ identifier: 'pedidosPendentes', expected: 'violation' }),
      this.build({ identifier: 'EventoRastreioFactory', expected: 'violation' }),
      this.build({ identifier: 'mapPII', expected: 'exempt' }),
    ];
  }

  static compliantSource(): string {
    return [
      "const pendingOrders = [];",
      "function calculateDeliveryPrice() { return 0; }",
      "const label = 'Pedidos pendentes';",
      "// A interface apresenta pedidos em português.",
    ].join('\n');
  }

  static nonCompliantSource(): string {
    return [
      "const pedidosPendentes = [];",
      "async function calcularPrecoEntrega() { return 0; }",
      "class EventoRastreioFactory {}",
    ].join('\n');
  }
}
