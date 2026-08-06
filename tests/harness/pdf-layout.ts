/**
 * @file pdf-layout.ts
 * @description Sonda de leitura do desenho de um PDF gerado (ferramenta de teste).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * PORQUE EXISTE: "o documento está profissional" só se verifica olhando — e um
 * teste não olha. O que um teste PODE verificar é o que estraga um documento
 * mesmo sem se ver o resultado: texto a sair fora das margens e texto escrito
 * por cima de outro texto (uma designação social longa a entrar no número da
 * fatura, o nome de um cliente a invadir a coluna ao lado). Esta sonda lê os
 * fluxos de conteúdo — que `pdf.ts` deixa por comprimir de propósito — e devolve
 * a posição de cada texto para se poder afirmar essas duas invariantes.
 *
 * A medição do texto é INJETADA (`measure`) para o harness não depender do
 * frontend: quem chama passa o `measureText` do próprio motor de PDF.
 */

export type PdfProbeFont = 'regular' | 'bold' | 'italic';

export interface PdfTextRun {
  /** Índice da página, a começar em 0. */
  page: number;
  /** Canto esquerdo do texto, em pontos. */
  x: number;
  /** Linha de base, medida a partir do TOPO da página. */
  y: number;
  size: number;
  font: PdfProbeFont;
  text: string;
  /** Largura ocupada, pela medição injetada. */
  width: number;
}

export interface PdfLayout {
  pageCount: number;
  runs: PdfTextRun[];
  /** Textos de uma página. */
  onPage(index: number): PdfTextRun[];
}

export type MeasureFn = (text: string, size: number, font: PdfProbeFont) => number;

const FONT_BY_REF: Record<string, PdfProbeFont> = { '/F1': 'regular', '/F2': 'bold', '/F3': 'italic' };

/** Altura da página A4 em pontos — usada para reconverter `y` para o topo. */
const PAGE_HEIGHT = 841.89;

function asLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Desfaz o escape de `escapePdfText`. */
function unescapePdf(text: string): string {
  return text.replace(/\\([\\()])/g, '$1');
}

/**
 * Lê os textos desenhados num PDF produzido por `services/pdf.ts`.
 * Ignora fluxos de imagem (binários) — só interessa o que é legível.
 */
export function readPdfLayout(bytes: Uint8Array, measure: MeasureFn, pageHeight = PAGE_HEIGHT): PdfLayout {
  const raw = asLatin1(bytes);
  const streams: string[] = [];

  const pattern = /stream\n([\s\S]*?)\nendstream/g;
  let match = pattern.exec(raw);
  while (match) {
    const content = match[1];
    if (content.includes(' Tm ') || content.includes(' re ')) streams.push(content);
    match = pattern.exec(raw);
  }

  const runs: PdfTextRun[] = [];
  streams.forEach((stream, page) => {
    for (const line of stream.split('\n')) {
      const text = /Tm \((.*)\) Tj/.exec(line);
      if (!text) continue;
      const font = /(\/F\d) (\d+(?:\.\d+)?) Tf/.exec(line);
      const position = /1 0 0 1 (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Tm/.exec(line);
      if (!font || !position) continue;

      const value = unescapePdf(text[1]);
      const size = Number(font[2]);
      const kind = FONT_BY_REF[font[1]] ?? 'regular';
      runs.push({
        page,
        x: Number(position[1]),
        y: pageHeight - Number(position[2]),
        size,
        font: kind,
        text: value,
        width: measure(value, size, kind),
      });
    }
  });

  return {
    pageCount: streams.length,
    runs,
    onPage: (index: number) => runs.filter((run) => run.page === index),
  };
}

/** Texto que começa antes da margem esquerda ou termina depois da direita. */
export function findOutsideMargins(
  runs: PdfTextRun[],
  options: { margin: number; pageWidth: number; tolerance?: number },
): PdfTextRun[] {
  const tolerance = options.tolerance ?? 0.5;
  const rightEdge = options.pageWidth - options.margin;
  return runs.filter((run) => (
    run.x < options.margin - tolerance || run.x + run.width > rightEdge + tolerance
  ));
}

/**
 * Pares de textos que se pisam.
 *
 * Considera-se a MESMA faixa quando as linhas de base estão a menos de 70% do
 * corpo de letra mais pequeno — abaixo disso, dois textos na mesma faixa com
 * intervalos horizontais sobrepostos ficam ilegíveis um por cima do outro.
 */
export function findOverlaps(runs: PdfTextRun[], tolerance = 0.5): Array<[PdfTextRun, PdfTextRun]> {
  const collisions: Array<[PdfTextRun, PdfTextRun]> = [];

  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i];
      const b = runs[j];
      if (a.page !== b.page) continue;
      if (!a.text.trim() || !b.text.trim()) continue;

      const sameBand = Math.abs(a.y - b.y) < Math.min(a.size, b.size) * 0.7;
      if (!sameBand) continue;

      const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      if (overlap > tolerance) collisions.push([a, b]);
    }
  }

  return collisions;
}

/** Descrição legível de uma colisão, para a mensagem de falha do teste. */
export function describeOverlap([a, b]: [PdfTextRun, PdfTextRun]): string {
  return `p.${a.page + 1}: "${a.text}" (x ${a.x.toFixed(1)}–${(a.x + a.width).toFixed(1)}) `
    + `sobre "${b.text}" (x ${b.x.toFixed(1)}–${(b.x + b.width).toFixed(1)}) em y ${a.y.toFixed(1)}`;
}
