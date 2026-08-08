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
  has_signature?: boolean;
  has_photo?: boolean;
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

/**
 * Data URL de tamanho controlado — para exercitar os limites da POD sem carregar
 * um ficheiro real para memória.
 *
 * @param chars comprimento total do data URL devolvido
 */
export function dataUrlOfSize(chars: number): string {
  const prefix = 'data:image/jpeg;base64,';
  const payload = Math.max(0, chars - prefix.length);
  return prefix + 'A'.repeat(payload);
}

/**
 * Fotografia de telemóvel realista: acima do tecto do backend, como sai de uma
 * câmara moderna. É este o caso que fazia o motorista ficar sem conseguir
 * fechar a entrega (spec § 3.28).
 */
export const PHONE_PHOTO_BYTES = 4_200_000;

/** Imagens devolvidas por `GET /v1/orders/:id/pod`. */
export interface TestPodImages {
  signature?: string;
  photo?: string;
}

export class PodImagesFactory {
  static build(overrides: Partial<TestPodImages> = {}): TestPodImages {
    return { signature: TINY_PNG_DATA_URL, photo: undefined, ...overrides };
  }

  static buildBoth(overrides: Partial<TestPodImages> = {}): TestPodImages {
    return { signature: TINY_PNG_DATA_URL, photo: TINY_PNG_DATA_URL, ...overrides };
  }

  /** Par de imagens pesadas — o cenário que motivou a tabela à parte. */
  static buildHeavy(chars = 1_000_000): TestPodImages {
    return { signature: dataUrlOfSize(chars), photo: dataUrlOfSize(chars) };
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
