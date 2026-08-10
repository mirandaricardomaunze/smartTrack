/**
 * @file image.ts
 * @description Redimensiona e comprime imagens da prova de entrega no telemóvel,
 *              antes de saírem para a rede.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.28
 *
 * PORQUÊ: o backend recusa data URLs acima de MAX_POD_IMAGE_CHARS (~2,2 MB) e uma
 * foto de telemóvel atual tem 3 a 5 MB — em base64, ainda mais 33%. Rejeitar era
 * deixar o motorista sem conseguir fechar a entrega no terreno. Reduzimos em vez
 * de recusar; só falha o que não couber nem na qualidade mínima.
 *
 * O núcleo de decisão é PURO e testável: `scaledDimensions` escolhe o tamanho e
 * `compressPodImage` percorre os degraus de qualidade através de um `ImageCodec`
 * injetável, para os testes não precisarem de canvas.
 */

/** Tecto do backend (orders.service.js MAX_POD_IMAGE_CHARS). Não subir sem o alterar lá. */
export const MAX_POD_DATA_URL_CHARS = 3_000_000;

/**
 * Alvo com margem: ficar colado ao tecto é convidar um 413 quando o data URL
 * cresce uns bytes no transporte.
 */
export const TARGET_POD_DATA_URL_CHARS = 2_400_000;

/** Lado maior da imagem. 1600px chega para ler uma assinatura ou uma porta. */
export const MAX_POD_EDGE_PX = 1600;

/** Degraus de qualidade JPEG, do melhor ao pior aceitável. */
export const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4] as const;

/** Quantas vezes se reduz o lado maior a 70% quando a qualidade mínima não chega. */
const MAX_DOWNSCALE_ROUNDS = 3;

export class PodImageTooLargeError extends Error {
  constructor() {
    super('Não foi possível reduzir a imagem o suficiente. Tente uma fotografia mais simples.');
    this.name = 'PodImageTooLargeError';
  }
}

/**
 * Dimensões cabendo num quadrado de `maxEdge`, mantendo a proporção.
 * Imagens já pequenas passam intactas — ampliar não acrescenta informação.
 * PURA.
 */
export function scaledDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_POD_EDGE_PX,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h };
  const ratio = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

/**
 * Bytes reais representados por um data URL base64 (o payload cresce ~33%).
 * PURA.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Fonte já descodificada, pronta a desenhar. */
export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
}

/**
 * Costura de IO: descodificar e voltar a codificar. O browser traz a sua
 * implementação; os testes injetam uma falsa e exercitam a mesma lógica.
 */
export interface ImageCodec {
  decode(file: File): Promise<DecodedImage>;
  encode(image: DecodedImage, width: number, height: number, quality: number): string;
}

/** Codec real do browser: `<img>` + canvas → JPEG. */
export function browserImageCodec(): ImageCodec {
  return {
    async decode(file: File): Promise<DecodedImage> {
      const url = URL.createObjectURL(file);
      try {
        const element = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
          img.src = url;
        });
        return { width: element.naturalWidth, height: element.naturalHeight, source: element };
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    encode(image: DecodedImage, width: number, height: number, quality: number): string {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Não foi possível processar a imagem neste dispositivo.');
      // Fundo branco antes de desenhar: uma assinatura PNG com transparência
      // ficaria preta sobre preto ao passar a JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image.source, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', quality);
    },
  };
}

/**
 * Reduz a imagem até caber no orçamento, devolvendo o data URL a enviar.
 *
 * Primeiro baixa a qualidade (mantendo a resolução legível); só depois, se ainda
 * não couber, encolhe o lado maior. É esta ordem que preserva a legibilidade de
 * uma assinatura, onde o que importa é o traço e não o grão.
 *
 * @throws {PodImageTooLargeError} quando nem o degrau mais agressivo chega.
 */
export async function compressPodImage(
  file: File,
  codec: ImageCodec = browserImageCodec(),
  opts: { maxChars?: number; maxEdge?: number } = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? TARGET_POD_DATA_URL_CHARS;
  const decoded = await codec.decode(file);

  let edge = opts.maxEdge ?? MAX_POD_EDGE_PX;
  for (let round = 0; round <= MAX_DOWNSCALE_ROUNDS; round += 1) {
    const { width, height } = scaledDimensions(decoded.width, decoded.height, edge);
    for (const quality of QUALITY_STEPS) {
      const encoded = codec.encode(decoded, width, height, quality);
      if (encoded.length <= maxChars) return encoded;
    }
    edge = Math.max(320, Math.round(edge * 0.7));
  }
  throw new PodImageTooLargeError();
}
