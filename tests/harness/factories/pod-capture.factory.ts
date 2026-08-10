/**
 * @file pod-capture.factory.ts
 * @description Test factory para a captura de imagem da prova de entrega no telemóvel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.28
 *
 * O jsdom não implementa canvas, e um teste que dependesse disso não estaria a
 * testar a decisão — estaria a testar o browser. Estas factories fornecem um
 * codec falso cujo tamanho de saída é uma função previsível das dimensões e da
 * qualidade, para o algoritmo de redução ser exercitado a sério.
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** Ficheiro de imagem falso, com o tamanho que interessa ao teste. */
export interface TestImageFile {
  name: string;
  type: string;
  size: number;
}

/** Fonte descodificada, no formato que o codec do driver-app consome. */
export interface TestDecodedImage {
  width: number;
  height: number;
  source: unknown;
}

export interface FakeCodecOptions {
  /** Dimensões que o `decode` devolve, independentemente do ficheiro. */
  width?: number;
  height?: number;
  /**
   * Bytes por pixel a qualidade 1.0. Subir força mais degraus de redução —
   * é o que distingue um teste do caminho feliz de um teste do algoritmo.
   *
   * MANTER MODESTO (≤ 8). O codec gera mesmo a string do tamanho que anuncia,
   * porque o algoritmo mede `length`; valores altos rebentam o alocador do
   * próprio teste. Para exercitar o caso impossível, apertar o orçamento
   * (`maxChars`) em vez de inflacionar a imagem.
   */
  bytesPerPixel?: number;
}

/** Registo de cada tentativa de codificação, para o teste inspecionar a estratégia. */
export interface EncodeAttempt {
  width: number;
  height: number;
  quality: number;
  length: number;
}

export class PodCaptureFactory {
  /** Fotografia como sai de uma câmara de telemóvel atual: 4000x3000, ~4,2 MB. */
  static buildPhonePhoto(overrides: Partial<TestImageFile> = {}): TestImageFile {
    return { name: 'entrega.jpg', type: 'image/jpeg', size: 4_200_000, ...overrides };
  }

  /** Assinatura desenhada: pequena, e não deve ser tocada pela redução. */
  static buildSignature(overrides: Partial<TestImageFile> = {}): TestImageFile {
    return { name: 'assinatura.png', type: 'image/png', size: 48_000, ...overrides };
  }

  /**
   * Codec falso e determinista. Devolve também `attempts`, para os testes
   * afirmarem sobre a ORDEM das tentativas — primeiro a qualidade, depois a
   * resolução — e não apenas sobre o resultado final.
   */
  static buildCodec(options: FakeCodecOptions = {}) {
    const width = options.width ?? 4000;
    const height = options.height ?? 3000;
    const bytesPerPixel = options.bytesPerPixel ?? 0.35;
    const attempts: EncodeAttempt[] = [];

    return {
      attempts,
      async decode(): Promise<TestDecodedImage> {
        return { width, height, source: { fake: true } };
      },
      encode(_image: TestDecodedImage, w: number, h: number, quality: number): string {
        const length = Math.round(w * h * bytesPerPixel * quality);
        attempts.push({ width: w, height: h, quality, length });
        return 'data:image/jpeg;base64,' + 'A'.repeat(Math.max(0, length - 23));
      },
    };
  }
}
