/**
 * @file pod.types.ts
 * @description Tipos do Comprovativo de Entrega (Proof of Delivery) e insucesso.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1, § 7 (EventoRastreio/entrega)
 *
 * O POD é a prova de quem recebeu, com assinatura/foto, hora e local — anexado ao
 * evento `delivered` na cadeia de histórico auditável do pedido. O insucesso
 * (tentativa falhada) regista um motivo e transiciona para `failed`.
 */

/** Forma de captura do comprovativo. */
export enum PodMethod {
  SIGNATURE       = 'signature',        // apenas assinatura
  PHOTO           = 'photo',            // apenas foto
  SIGNATURE_PHOTO = 'signature_photo',  // assinatura + foto
}

/** Motivos de insucesso de entrega. */
export enum DeliveryFailureReason {
  RECIPIENT_ABSENT = 'RECIPIENT_ABSENT', // destinatário ausente
  WRONG_ADDRESS    = 'WRONG_ADDRESS',    // morada incorreta
  REFUSED          = 'REFUSED',          // recusou a encomenda
  OTHER            = 'OTHER',            // outro (ver notas)
}

/** Ponto GPS opcional capturado no momento da entrega. */
export interface PodGeoPoint {
  lat: number;
  lng: number;
}

/**
 * Comprovativo de entrega.
 *
 * As imagens NÃO viajam aqui (spec § 3.28). O que fica guardado no pedido são os
 * metadados mais os sinalizadores; a assinatura e a foto vivem em
 * `order_pod_images` e leem-se por `GET /v1/orders/:id/pod`. `signature` e
 * `photo` continuam a existir no tipo porque são o que o motorista ENVIA ao
 * registar a entrega — só não é o que a leitura devolve.
 */
export interface ProofOfDelivery {
  method: PodMethod;
  /** Nome de quem recebeu (obrigatório). */
  recipient_name: string;
  /** Assinatura desenhada, como data URL PNG. Só na ESCRITA. */
  signature?: string;
  /** Foto da entrega, como data URL. Só na ESCRITA. */
  photo?: string;
  /** Há assinatura guardada? Substitui a imagem na LEITURA. */
  has_signature?: boolean;
  /** Há foto guardada? Substitui a imagem na LEITURA. */
  has_photo?: boolean;
  notes?: string;
  coords?: PodGeoPoint;
  /** Utilizador que registou a entrega (motorista/admin). */
  captured_by?: string;
  captured_at: string; // ISO8601 UTC
}

/** Imagens do comprovativo, carregadas sob pedido (spec § 3.28). */
export interface PodImages {
  signature?: string;
  photo?: string;
}

/** Payload de registo de insucesso de entrega. */
export interface DeliveryFailure {
  reason: DeliveryFailureReason;
  notes?: string;
  captured_by?: string;
  captured_at: string; // ISO8601 UTC
}
