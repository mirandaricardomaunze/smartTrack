/**
 * @file pod.factory.ts
 * @description Test factory para Comprovativo de Entrega (POD) e insucesso.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1, § 7
 *
 * Alinhado com backend/shared/types/src/pod.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { PodMethod, DeliveryFailureReason } from '../../../backend/shared/types/src/pod.types';

/** PNG 1x1 transparente, válido como data URL de assinatura/foto. */
export const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface TestProofOfDelivery {
  method: PodMethod;
  recipient_name: string;
  signature?: string;
  photo?: string;
  notes?: string;
  coords?: { lat: number; lng: number };
  captured_by?: string;
  captured_at: string;
}

export interface TestDeliveryFailure {
  reason: DeliveryFailureReason;
  notes?: string;
  captured_by?: string;
  captured_at: string;
}

let _counter = 1;

export class PodFactory {
  /** POD completo: nome + assinatura (default). */
  static build(overrides: Partial<TestProofOfDelivery> = {}): TestProofOfDelivery {
    const n = _counter++;
    return {
      method:        PodMethod.SIGNATURE,
      recipient_name: `Recebedor Teste ${n}`,
      signature:     TINY_PNG_DATA_URL,
      photo:         undefined,
      notes:         undefined,
      coords:        { lat: -25.9692, lng: 32.5732 },
      captured_by:   undefined,
      captured_at:   new Date().toISOString(),
      ...overrides,
    };
  }

  /** Só assinatura (sem foto). */
  static buildSignatureOnly(overrides: Partial<TestProofOfDelivery> = {}): TestProofOfDelivery {
    return this.build({ method: PodMethod.SIGNATURE, signature: TINY_PNG_DATA_URL, photo: undefined, ...overrides });
  }

  /** Assinatura + foto. */
  static buildWithPhoto(overrides: Partial<TestProofOfDelivery> = {}): TestProofOfDelivery {
    return this.build({ method: PodMethod.SIGNATURE_PHOTO, signature: TINY_PNG_DATA_URL, photo: TINY_PNG_DATA_URL, ...overrides });
  }
}

export class DeliveryFailureFactory {
  static build(overrides: Partial<TestDeliveryFailure> = {}): TestDeliveryFailure {
    return {
      reason:      DeliveryFailureReason.RECIPIENT_ABSENT,
      notes:       undefined,
      captured_by: undefined,
      captured_at: new Date().toISOString(),
      ...overrides,
    };
  }
}
