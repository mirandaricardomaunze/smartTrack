/**
 * @file pickup.factory.ts
 * @description Test factory do levantamento ao balcão.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.23 (Levantamento no armazém)
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

export interface TestPickupInput {
  collector_name: string;
  collector_document: string;
  is_recipient?: boolean;
  relationship?: string;
  authorization?: string;
  otp?: string;
  cod_method?: string;
  notes?: string;
}

export class PickupFactory {
  /** O caso simples: é o próprio destinatário que vem buscar. */
  static recipient(overrides: Partial<TestPickupInput> = {}): TestPickupInput {
    return {
      collector_name: 'Ana Matola',
      collector_document: 'BI 110100234567A',
      is_recipient: true,
      ...overrides,
    };
  }

  /**
   * Terceiro autorizado — o caso mais comum na prática e o que gera reclamações
   * quando não fica registado quem levou e com que autorização.
   */
  static thirdParty(overrides: Partial<TestPickupInput> = {}): TestPickupInput {
    return {
      collector_name: 'João Sitoe',
      collector_document: 'BI 220200987654B',
      is_recipient: false,
      relationship: 'Irmão do destinatário',
      authorization: 'Autorização escrita entregue no balcão, com cópia do documento do destinatário.',
      ...overrides,
    };
  }

  /** Levantamento com valor a cobrar no balcão. */
  static withCod(overrides: Partial<TestPickupInput> = {}): TestPickupInput {
    return PickupFactory.recipient({ cod_method: 'CASH', ...overrides });
  }
}
