/**
 * @file pdf.ts
 * @description Escritor de PDF mínimo, sem dependências externas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * PORQUÊ ESCREVER UM: o projeto já recusou dependências para o Code128 (ver
 * `code128.ts`) e a alternativa era arrastar ~300 KB de biblioteca para produzir
 * documentos que são texto, filetes e um logótipo. Aqui só existe o subconjunto
 * do formato PDF de que precisamos, escrito à mão e testável:
 *
 *   - páginas A4 (retrato), margens configuráveis;
 *   - texto com as fontes base Helvetica/Bold/Oblique (sem incorporar ficheiros
 *     de fonte — as 14 fontes-padrão estão garantidas em qualquer leitor);
 *   - acentuação portuguesa via WinAnsiEncoding (Latin-1);
 *   - medição real do texto pelas métricas AFM → alinhamento e quebra corretos;
 *   - filetes, retângulos preenchidos e imagens JPEG (logótipo).
 *
 * O que NÃO faz (deliberadamente): compressão de streams, tipografia avançada,
 * transparência, formulários. Um documento típico fica em poucos KB.
 */

// ─── Constantes de página ─────────────────────────────────────────────────────

/** A4 em pontos tipográficos (1 pt = 1/72"). */
export const A4 = { width: 595.28, height: 841.89 };

export type PdfFont = 'regular' | 'bold' | 'italic';
export type PdfAlign = 'left' | 'center' | 'right';

export interface PdfTextOptions {
  size?: number;
  font?: PdfFont;
  /** Cor em hexadecimal (#RRGGBB). */
  color?: string;
  align?: PdfAlign;
  /** Largura disponível — obrigatória para `center`/`right`. */
  width?: number;
}

// ─── Métricas das fontes-padrão ───────────────────────────────────────────────
// Larguras AFM (por 1000 unidades de em) das fontes-base Helvetica. Só ASCII
// imprimível: em Helvetica as letras acentuadas têm o MESMO avanço da letra
// base, por isso `charWidth` reduz o acento à base antes de medir.

const HELVETICA_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

/**
 * Pontuação de Latin-1 e do bloco tipográfico do WinAnsi (0x80–0x9F).
 *
 * PORQUE EXISTE: sem estas larguras, o travessão, o ponto médio e o "n.º" — que
 * aparecem em quase todos os documentos deste sistema — eram medidos como '?'
 * (556). Meia dúzia de separadores numa linha chegava para desalinhar um total
 * encostado à direita. Valores do AFM da Helvetica.
 */
const HELVETICA_PUNCTUATION: Record<string, number> = {
  '¡': 333, '¢': 556, '£': 556, '¤': 556, '¥': 556, '¦': 260, '§': 556, '¨': 333,
  '©': 737, 'ª': 370, '«': 556, '¬': 584, '®': 737, '¯': 333,
  '°': 400, '±': 584, '²': 333, '³': 333, '´': 333, 'µ': 556, '¶': 537, '·': 278,
  '¸': 333, '¹': 333, 'º': 365, '»': 556, '¼': 834, '½': 834, '¾': 834, '¿': 611,
  '×': 584, '÷': 584, 'ß': 611, 'æ': 889, 'ø': 611, 'Æ': 1000, 'Ø': 778, 'Þ': 667, 'þ': 556,
  '€': 556, '‚': 222, 'ƒ': 556, '„': 333, '…': 1000, '†': 556, '‡': 556, 'ˆ': 333,
  '‰': 1000, 'Š': 667, '‹': 333, 'Œ': 1000, 'Ž': 611,
  '‘': 222, '’': 222, '“': 333, '”': 333,
  '•': 350, '–': 556, '—': 1000, '˜': 333, '™': 1000, 'š': 500, '›': 333, 'œ': 944,
  'ž': 500, 'Ÿ': 667,
};

Object.assign(HELVETICA_WIDTHS, HELVETICA_PUNCTUATION);

const HELVETICA_BOLD_WIDTHS: Record<string, number> = {
  ...HELVETICA_WIDTHS,
  '¦': 280, 'µ': 611, '¶': 556, 'ß': 611, 'æ': 889, 'ø': 611, 'Æ': 1000, 'Ø': 778,
  '‘': 278, '’': 278, '“': 500, '”': 500, 'œ': 944, 'Š': 722,
  '!': 333, '"': 474, '&': 722, "'": 238, ':': 333, ';': 333, '?': 611, '@': 975,
  A: 722, C: 722, E: 667, J: 556, L: 611, '[': 333, ']': 333, '^': 584,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500, '{': 389, '|': 280, '}': 389,
};

/** Acentuadas → base, para reaproveitar a largura (idêntica em Helvetica). */
const DEACCENT: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', é: 'e', ê: 'e', è: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i', ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u', ç: 'c', ñ: 'n',
  Á: 'A', À: 'A', Â: 'A', Ã: 'A', Ä: 'A', É: 'E', Ê: 'E', È: 'E', Ë: 'E',
  Í: 'I', Ì: 'I', Î: 'I', Ï: 'I', Ó: 'O', Ò: 'O', Ô: 'O', Õ: 'O', Ö: 'O',
  Ú: 'U', Ù: 'U', Û: 'U', Ü: 'U', Ç: 'C', Ñ: 'N',
};

function charWidth(char: string, font: PdfFont): number {
  const table = font === 'bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const key = table[char] !== undefined ? char : (DEACCENT[char] ?? '?');
  return table[key] ?? 556;
}

/**
 * Largura de um texto em pontos. PURA — é o que permite alinhar à direita e
 * quebrar linhas sem depender do leitor de PDF.
 */
export function measureText(text: string, size: number, font: PdfFont = 'regular'): number {
  let total = 0;
  for (const char of String(text ?? '')) total += charWidth(char, font);
  return (total * size) / 1000;
}

/** Parte o texto em linhas que cabem em `maxWidth`. PURA. */
export function wrapText(text: string, maxWidth: number, size: number, font: PdfFont = 'regular'): string[] {
  const paragraphs = String(text ?? '').split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(''); continue; }

    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, size, font) <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// ─── Codificação ──────────────────────────────────────────────────────────────

/** Escapa os caracteres que terminariam a string literal do PDF. */
export function escapePdfText(text: string): string {
  return String(text ?? '').replace(/[\\()]/g, (c) => `\\${c}`).replace(/[\r\n]/g, ' ');
}

/**
 * Caracteres tipográficos que o WinAnsi tem em 0x80–0x9F mas o Latin-1 não.
 *
 * PORQUE EXISTE: o travessão (—) e as aspas curvas são Unicode acima de 0xFF e
 * saíam impressos como '?' em todos os documentos gerados. A codificação da
 * fonte é WinAnsiEncoding (ver `toBytes`), que os tem — só faltava mapeá-los.
 */
const WINANSI_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
};

/** Texto → bytes WinAnsi. Fora do intervalo cai na letra base, ou em '?'. */
function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const winansi = WINANSI_HIGH[char];
    if (winansi !== undefined) { bytes.push(winansi); continue; }
    const code = char.charCodeAt(0);
    bytes.push(code <= 0xff ? code : (DEACCENT[char] ?? '?').charCodeAt(0));
  }
  return bytes;
}

/** #RRGGBB → componentes 0..1 para o operador `rg`/`RG`. */
function hexToRgb(hex?: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!match) return [0, 0, 0];
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

// ─── Imagens ──────────────────────────────────────────────────────────────────

export interface PdfImage {
  /** JPEG cru — incorporado com DCTDecode, sem recodificar. */
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Converte qualquer data URL de imagem em JPEG, via canvas.
 *
 * PORQUÊ PASSAR TUDO POR JPEG: o PDF incorpora JPEG diretamente (DCTDecode) sem
 * precisar de compressor. PNG exigiria tratar zlib e canais alfa — o canvas
 * resolve os dois problemas de uma vez, achatando a transparência sobre branco.
 *
 * @returns null quando a imagem não carrega (nunca lança: um logótipo partido
 *          não pode impedir a emissão de um documento).
 */
export async function loadImageAsJpeg(dataUrl: string, maxSize = 600): Promise<PdfImage | null> {
  if (!dataUrl || typeof document === 'undefined') return null;

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('imagem inválida'));
      img.src = dataUrl;
    });

    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Fundo branco: o JPEG não tem canal alfa e o preto ficaria feio no papel.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1] ?? '';
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);

    return { data, width, height };
  } catch {
    return null;
  }
}

// ─── Documento ────────────────────────────────────────────────────────────────

interface PdfPage {
  content: string[];
  images: Array<{ name: string; image: PdfImage }>;
}

export interface PdfDocumentOptions {
  margin?: number;
  title?: string;
  author?: string;
}

/**
 * Documento PDF em construção. As coordenadas são as do PDF (origem no canto
 * inferior esquerdo), mas a API expõe `y` a contar do TOPO — é como se pensa um
 * documento, e evita erros de sinal em todo o código que a usa.
 */
export class PdfDocument {
  readonly margin: number;
  readonly width = A4.width;
  readonly height = A4.height;

  private pages: PdfPage[] = [];
  private page!: PdfPage;
  private imageCounter = 0;
  private readonly title: string;
  private readonly author: string;

  constructor(options: PdfDocumentOptions = {}) {
    this.margin = options.margin ?? 48;
    this.title = options.title ?? 'Documento';
    this.author = options.author ?? '';
    this.addPage();
  }

  /** Largura útil entre margens. */
  get contentWidth(): number {
    return this.width - this.margin * 2;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.page = { content: [], images: [] };
    this.pages.push(this.page);
  }

  /**
   * Desenha numa página já criada e volta à corrente. É o que permite escrever
   * rodapés com "Página X de Y" — o total só se conhece no fim.
   */
  onPage(index: number, draw: () => void): void {
    const previous = this.page;
    this.page = this.pages[index] ?? previous;
    try { draw(); } finally { this.page = previous; }
  }

  /** Escreve uma linha de texto. `y` mede-se a partir do topo da página. */
  text(value: string, x: number, y: number, options: PdfTextOptions = {}): void {
    const size = options.size ?? 10;
    const font = options.font ?? 'regular';
    const raw = String(value ?? '');
    if (!raw) return;

    let drawX = x;
    if (options.align && options.align !== 'left' && options.width) {
      const textWidth = measureText(raw, size, font);
      drawX = options.align === 'right'
        ? x + options.width - textWidth
        : x + (options.width - textWidth) / 2;
    }

    const [r, g, b] = hexToRgb(options.color ?? '#111111');
    const fontRef = font === 'bold' ? '/F2' : font === 'italic' ? '/F3' : '/F1';

    this.page.content.push(
      `BT ${fontRef} ${fmt(size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 1 0 0 1 ${fmt(drawX)} ${fmt(this.height - y)} Tm (${escapePdfText(raw)}) Tj ET`,
    );
  }

  /**
   * Escreve texto com quebra automática.
   * @returns a altura ocupada, para o chamador continuar a seguir.
   */
  textBlock(value: string, x: number, y: number, width: number, options: PdfTextOptions & { lineHeight?: number } = {}): number {
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const lines = wrapText(value, width, size, options.font ?? 'regular');

    lines.forEach((line, index) => {
      this.text(line, x, y + index * lineHeight, { ...options, width });
    });
    return lines.length * lineHeight;
  }

  line(x1: number, y1: number, x2: number, y2: number, options: { color?: string; width?: number } = {}): void {
    const [r, g, b] = hexToRgb(options.color ?? '#d4d4d8');
    this.page.content.push(
      `${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(options.width ?? 0.6)} w ${fmt(x1)} ${fmt(this.height - y1)} m ${fmt(x2)} ${fmt(this.height - y2)} l S`,
    );
  }

  rect(x: number, y: number, width: number, height: number, options: { fill?: string; stroke?: string; lineWidth?: number } = {}): void {
    const ops: string[] = [];
    if (options.fill) {
      const [r, g, b] = hexToRgb(options.fill);
      ops.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg`);
    }
    if (options.stroke) {
      const [r, g, b] = hexToRgb(options.stroke);
      ops.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(options.lineWidth ?? 0.6)} w`);
    }
    const painter = options.fill && options.stroke ? 'B' : options.fill ? 'f' : 'S';
    ops.push(`${fmt(x)} ${fmt(this.height - y - height)} ${fmt(width)} ${fmt(height)} re ${painter}`);
    this.page.content.push(ops.join(' '));
  }

  /** Desenha uma imagem já convertida por `loadImageAsJpeg`. */
  image(image: PdfImage | null, x: number, y: number, width: number, height: number): void {
    if (!image) return;
    this.imageCounter += 1;
    const name = `Im${this.imageCounter}`;
    this.page.images.push({ name, image });
    this.page.content.push(
      `q ${fmt(width)} 0 0 ${fmt(height)} ${fmt(x)} ${fmt(this.height - y - height)} cm /${name} Do Q`,
    );
  }

  /** Serializa o documento. É aqui que se monta a tabela de referências cruzadas. */
  toBytes(): Uint8Array {
    const chunks: number[] = [];
    const offsets: number[] = [];
    let position = 0;

    const push = (text: string) => {
      const bytes = encodeWinAnsi(text);
      chunks.push(...bytes);
      position += bytes.length;
    };
    const pushRaw = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i += 1) chunks.push(bytes[i]);
      position += bytes.length;
    };
    const startObject = (id: number) => { offsets[id] = position; push(`${id} 0 obj\n`); };
    const endObject = () => push('endobj\n');

    // Layout dos objetos: 1 catálogo · 2 páginas · 3 info · 4-6 fontes · depois,
    // por página, o objeto Page + o stream de conteúdo + as imagens.
    const firstPageObject = 7;
    const objectsPerPage = 2;
    const imageIds = new Map<string, number>();
    let nextId = firstPageObject + this.pages.length * objectsPerPage;
    for (const page of this.pages) {
      for (const { name } of page.images) {
        imageIds.set(name, nextId);
        nextId += 1;
      }
    }
    const totalObjects = nextId - 1;

    push('%PDF-1.4\n%âãÏÓ\n');

    startObject(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\n');
    endObject();

    startObject(2);
    const kids = this.pages.map((_, i) => `${firstPageObject + i * objectsPerPage} 0 R`).join(' ');
    push(`<< /Type /Pages /Count ${this.pages.length} /Kids [${kids}] >>\n`);
    endObject();

    startObject(3);
    push(`<< /Title (${escapePdfText(this.title)}) /Author (${escapePdfText(this.author)}) /Producer (SmartTrack) >>\n`);
    endObject();

    const fonts: Array<[number, string]> = [[4, 'Helvetica'], [5, 'Helvetica-Bold'], [6, 'Helvetica-Oblique']];
    for (const [id, name] of fonts) {
      startObject(id);
      push(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>\n`);
      endObject();
    }

    this.pages.forEach((page, index) => {
      const pageId = firstPageObject + index * objectsPerPage;
      const contentId = pageId + 1;
      const xobjects = page.images
        .map(({ name }) => `/${name} ${imageIds.get(name)} 0 R`)
        .join(' ');

      startObject(pageId);
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(this.width)} ${fmt(this.height)}] `
        + `/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >>`
        + `${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${contentId} 0 R >>\n`,
      );
      endObject();

      const stream = page.content.join('\n');
      startObject(contentId);
      push(`<< /Length ${encodeWinAnsi(stream).length} >>\nstream\n${stream}\nendstream\n`);
      endObject();
    });

    for (const page of this.pages) {
      for (const { name, image } of page.images) {
        const id = imageIds.get(name)!;
        startObject(id);
        push(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `
          + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>\nstream\n`,
        );
        pushRaw(image.data);
        push('\nendstream\n');
        endObject();
      }
    }

    const xrefOffset = position;
    push(`xref\n0 ${totalObjects + 1}\n`);
    push('0000000000 65535 f \n');
    for (let id = 1; id <= totalObjects; id += 1) {
      push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return new Uint8Array(chunks);
  }

  toBlob(): Blob {
    // `slice()` devolve um ArrayBuffer concreto — o tipo genérico de Uint8Array
    // não satisfaz BlobPart em TypeScript recente.
    return new Blob([this.toBytes().slice().buffer as ArrayBuffer], { type: 'application/pdf' });
  }

  /** Descarrega o ficheiro no browser. */
  save(filename: string): void {
    const url = URL.createObjectURL(this.toBlob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
    link.click();
    // Revogar de imediato cancelaria o download em alguns browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
