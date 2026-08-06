/**
 * @file client.factory.ts
 * @description Test factory para clientes/remetentes.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.12
 *
 * Alinhado com backend/shared/types/src/client.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { ClientType, ClientStatus } from '../../../backend/shared/types/src/client.types';

export interface TestClientInput {
  name: string;
  type?: ClientType;
  email?: string;
  phone?: string;
  tax_id?: string;
  address?: { street?: string; city?: string; state?: string; country?: string };
  notes?: string;
}

let _counter = 1;

export class ClientFactory {
  static build(overrides: Partial<TestClientInput> = {}): TestClientInput {
    const n = _counter++;
    return {
      name:    `Cliente Teste ${n}`,
      type:    ClientType.INDIVIDUAL,
      email:   `cliente${n}@exemplo.mz`,
      phone:   `+2588400000${String(n).padStart(2, '0')}`,
      tax_id:  undefined,
      address: { city: 'Maputo', state: 'MPM', country: 'MZ' },
      notes:   undefined,
      ...overrides,
    };
  }

  /** Remetente empresarial (B2B) com NUIT. */
  static buildBusiness(overrides: Partial<TestClientInput> = {}): TestClientInput {
    const n = _counter;
    return this.build({
      name:   `Loja Remetente ${n}`,
      type:   ClientType.BUSINESS,
      tax_id: `4000${String(n).padStart(6, '0')}`,
      ...overrides,
    });
  }
}

/** Estados reexportados para asserções nos testes. */
export { ClientType, ClientStatus };
