/**
 * @file companyPdf.ts
 * @description Modelo único dos documentos PDF da empresa (papel timbrado).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * Um só modelo para tudo o que a empresa entrega a terceiros — fatura, nota de
 * crédito, mapa de IVA, relatório, acerto de motorista. Assim o logótipo, o NUIT
 * e o rodapé legal ficam definidos **uma vez** e qualquer página nova ganha um
 * PDF profissional com meia dúzia de linhas.
 *
 * Estrutura fixa: cabeçalho com marca → título e metadados → blocos de partes →
 * tabelas → totais → notas → rodapé com paginação e identificação do emissor.
 * Sem emojis — apenas texto e filetes.
 */

import { PdfDocument, loadImageAsJpeg, measureText, wrapText, type PdfAlign } from './pdf';
import type { CompanyProfile } from './api';

/** Cor neutra do corpo do documento (a da marca fica para títulos e filetes). */
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D1D5DB';

export interface PdfMeta {
  label: string;
  value: string;
  /** Destaca o valor (ex.: total, estado). */
  strong?: boolean;
}

export interface PdfParty {
  title: string;
  lines: string[];
}

export interface PdfColumn {
  header: string;
  /** Largura relativa (peso). */
  width: number;
  align?: PdfAlign;
}

export interface PdfTable {
  title?: string;
  columns: PdfColumn[];
  rows: string[][];
  /** Linhas de resumo por baixo da tabela (etiqueta → valor). */
  totals?: PdfMeta[];
  emptyLabel?: string;
}

export interface CompanyPdfInput {
  profile: CompanyProfile | null;
  /** Designação do documento: "Fatura", "Mapa de IVA", "Acerto de motorista"… */
  title: string;
  /** Número/identificador em destaque, se existir. */
  reference?: string;
  subtitle?: string;
  /** Selo no canto superior direito (ex.: "PAGA", "ANULADA"). */
  badge?: string;
  meta?: PdfMeta[];
  parties?: PdfParty[];
  tables?: PdfTable[];
  notes?: string[];
  /** Linhas de assinatura manuscrita (recibos, guias, acertos). */
  signatures?: string[];
  /** Linha final antes do rodapé (assinatura fiscal, aviso legal). */
  legalNote?: string;
  filename: string;
}

function issuerLines(profile: CompanyProfile | null): string[] {
  if (!profile) return [];
  return [
    profile.tax_id ? `NUIT: ${profile.tax_id}` : '',
    profile.address ?? '',
    [profile.city, profile.country].filter(Boolean).join(', '),
    [profile.phone, profile.email].filter(Boolean).join(' · '),
    profile.website ?? '',
  ].filter(Boolean);
}

/**
 * Preto ou branco por cima de uma cor de fundo, pelo contraste.
 * PURA.
 *
 * PORQUE EXISTE: a cor da marca é escolhida por cada empresa. Escrever sempre a
 * branco por cima dela apagaria o total a pagar de quem escolheu um amarelo ou
 * um verde-claro. A fórmula é a luminância relativa do WCAG.
 */
export function readableOn(background: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(background ?? ''));
  if (!match) return '#FFFFFF';
  const value = parseInt(match[1], 16);
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel((value >> 16) & 255)
    + 0.7152 * channel((value >> 8) & 255)
    + 0.0722 * channel(value & 255);
  return luminance > 0.45 ? INK : '#FFFFFF';
}

/**
 * Corta um texto para caber numa largura, numa só linha. PURA.
 *
 * Só para o rodapé, que é a única linha que não pode crescer: tudo o resto usa
 * `textBlock` e desce de linha. Termina em "..." para se ver que foi cortado —
 * não usa o carácter de reticências porque WinAnsi o perderia.
 */
export function fitOneLine(text: string, maxWidth: number, size: number): string {
  const value = String(text ?? '');
  if (!value || measureText(value, size) <= maxWidth) return value;

  let cut = value;
  while (cut.length > 1 && measureText(`${cut}...`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

/**
 * Cor do selo de estado pelo SEU SIGNIFICADO. PURA.
 *
 * PORQUE EXISTE: o selo era sempre da cor da marca, o que faz um documento
 * ANULADO parecer igual a um documento PAGO. Num documento fiscal isso não é
 * uma questão de gosto — é ler o estado errado.
 */
export function badgeColor(label: string, brand: string): string {
  const text = String(label ?? '').toUpperCase();
  if (/ANULAD|CANCELAD|ESTORNAD/.test(text)) return '#6B7280';                    // neutro: já não conta
  if (/PAGA|PAGO|LIQUIDAD|ATIVA|CONCLU|SEM VIOLA|ENTREGUE/.test(text)) return '#047857'; // resolvido
  if (/PENDENTE|POR PAGAR|ATRASO|VENCID|VERIFICAR|RASCUNHO|SUSPENS/.test(text)) return '#B45309'; // exige ação
  return brand;
}

/**
 * Compõe o documento e devolve-o por montar em ficheiro.
 * Separado de `buildCompanyPdf` para que a composição — que é onde vivem as
 * tabelas, as quebras de página e o rodapé — possa ser testada sem browser.
 *
 * Assíncrono por causa do logótipo (convertido em JPEG via canvas).
 */
export async function composeCompanyPdf(input: CompanyPdfInput): Promise<PdfDocument> {
  const { profile } = input;
  const brand = profile?.brand_color || '#0F172A';
  const doc = new PdfDocument({ title: `${input.title}${input.reference ? ` ${input.reference}` : ''}`, author: profile?.legal_name ?? '' });

  const left = doc.margin;
  const right = doc.margin + doc.contentWidth;
  const bottomLimit = doc.height - doc.margin - 40;

  const logo = profile?.logo ? await loadImageAsJpeg(profile.logo, 400) : null;

  // Escala de espaçamento: um documento lê-se como desenhado quando os espaços
  // são múltiplos de uma unidade, em vez de valores escolhidos um a um.
  const UNIT = 6;
  const gap = (n: number) => UNIT * n;

  let y = doc.margin;

  // Duas colunas fixas no cabeçalho: a marca à esquerda, a identidade do
  // documento à direita. As larguras são calculadas e NÃO se sobrepõem — uma
  // designação social longa entraria por cima do número do documento.
  const idWidth = 210;
  const idX = right - idWidth;
  const brandWidth = doc.contentWidth - idWidth - gap(2);

  /**
   * Cabeçalho da página, repetido em versão reduzida nas seguintes.
   *
   * O NÚMERO do documento é o que o leitor procura primeiro (ao telefone, na
   * contabilidade, numa reclamação) — por isso é o maior elemento da direita, e
   * o tipo de documento fica como etiqueta por cima dele.
   *
   * Filete duplo em vez de barra a sangrar no topo: uma barra colada ao bordo
   * sai cortada em qualquer impressora de escritório.
   */
  const drawHeader = (compact: boolean) => {
    const top = doc.margin;

    // ── Direita: identidade do documento ────────────────────────────────────
    doc.text(input.title.toUpperCase(), idX, top + 9, {
      size: 8, font: 'bold', color: MUTED, align: 'right', width: idWidth,
    });

    let rightY = top + 13;
    if (input.reference) {
      doc.text(input.reference, idX, top + (compact ? 22 : 28), {
        size: compact ? 11 : 17, font: 'bold', color: brand, align: 'right', width: idWidth,
      });
      rightY = top + (compact ? 26 : 34);
    }

    if (input.badge && !compact) {
      const fill = badgeColor(input.badge, brand);
      const badgeWidth = measureText(input.badge, 8, 'bold') + gap(3);
      doc.rect(right - badgeWidth, rightY, badgeWidth, 15, { fill });
      doc.text(input.badge, right - badgeWidth, rightY + 10.5, {
        size: 8, font: 'bold', color: readableOn(fill), align: 'center', width: badgeWidth,
      });
      rightY += 17;
    }

    // ── Esquerda: marca. O logótipo fica ACIMA do texto e não ao lado — ao
    // lado, sobrariam ~110 pt para a designação social, e ela transbordava.
    let leftY = top;
    if (logo) {
      const maxHeight = compact ? 18 : 38;
      const width = Math.min(maxHeight * (logo.width / logo.height), brandWidth);
      doc.image(logo, left, leftY, width, maxHeight);
      leftY += maxHeight + gap(1);
    }

    const nameSize = compact ? 9.5 : 12.5;
    let baseline = leftY + nameSize;
    baseline += doc.textBlock(profile?.legal_name ?? 'Empresa', left, baseline, brandWidth, {
      size: nameSize, font: 'bold', color: INK, lineHeight: nameSize + 2.5,
    });

    if (!compact) {
      baseline += 2;
      if (profile?.trade_name) {
        baseline += doc.textBlock(profile.trade_name, left, baseline, brandWidth, { size: 8, color: MUTED, lineHeight: 10 });
      }
      for (const line of issuerLines(profile)) {
        baseline += doc.textBlock(line, left, baseline, brandWidth, { size: 8, color: MUTED, lineHeight: 10 });
      }
    }

    const floor = top + (compact ? 20 : 34);
    const bottom = Math.max(baseline - 3, rightY, floor);
    doc.line(left, bottom, right, bottom, { color: brand, width: compact ? 0.9 : 1.4 });
    if (!compact) doc.line(left, bottom + 2.6, right, bottom + 2.6, { color: brand, width: 0.4 });
    return bottom + gap(compact ? 2 : 3.5);
  };

  y = drawHeader(false);

  if (input.subtitle) {
    // No corpo e não no cabeçalho: um subtítulo longo encostado à direita
    // invadiria o bloco do emissor.
    y += doc.textBlock(input.subtitle, left, y + 4, doc.contentWidth, { size: 9, color: MUTED, lineHeight: 11 }) + gap(1.5);
  }

  // ── Metadados, em duas colunas ──────────────────────────────────────────────
  if (input.meta?.length) {
    const half = doc.contentWidth / 2;
    input.meta.forEach((item, index) => {
      const column = index % 2;
      const rowY = y + Math.floor(index / 2) * 13 + 8;
      const x = left + column * half;
      doc.text(`${item.label}:`, x, rowY, { size: 8, color: MUTED });
      const labelWidth = measureText(`${item.label}:`, 8) + 4;
      // Cortado à coluna: um valor longo entraria na coluna do lado.
      doc.text(fitOneLine(item.value, half - labelWidth - gap(2), 8.5), x + labelWidth, rowY, {
        size: 8.5, font: item.strong ? 'bold' : 'regular', color: INK,
      });
    });
    y += Math.ceil(input.meta.length / 2) * 13 + gap(2.5);
  }

  // ── Partes, em caixa própria ────────────────────────────────────────────────
  // A caixa não é decoração: separa "a quem se destina" do resto num documento
  // que muitas vezes é lido em papel e com pressa.
  if (input.parties?.length) {
    const columnWidth = doc.contentWidth / input.parties.length;
    const innerWidth = columnWidth - gap(3);
    const lineHeight = 11;

    // Envolver ANTES de medir a caixa: o nome de um cliente longo tem de descer
    // de linha, não de invadir a coluna ao lado. A 1.ª linha é a negrito e o
    // negrito é mais largo — por isso é medida com as suas próprias métricas.
    const wrapped = input.parties.map((party) => party.lines
      .filter(Boolean)
      .flatMap((line, lineIndex) => wrapText(line, innerWidth, 9, lineIndex === 0 ? 'bold' : 'regular')
        .map((text) => ({ text, strong: lineIndex === 0 }))));

    const tallest = Math.max(...wrapped.map((lines) => lines.length));
    const boxHeight = gap(2) + 12 + tallest * lineHeight + gap(0.5);

    doc.rect(left, y, doc.contentWidth, boxHeight, { fill: '#F9FAFB', stroke: '#E5E7EB', lineWidth: 0.5 });

    input.parties.forEach((party, index) => {
      const x = left + index * columnWidth + gap(1.5);
      doc.text(party.title.toUpperCase(), x, y + gap(2), { size: 7.5, font: 'bold', color: brand });
      let lineY = y + gap(2) + 13;
      for (const line of wrapped[index]) {
        doc.text(line.text, x, lineY, { size: 9, font: line.strong ? 'bold' : 'regular', color: INK });
        lineY += lineHeight;
      }
    });

    y += boxHeight + gap(3);
  }

  // ── Tabelas ─────────────────────────────────────────────────────────────────
  /** Redesenha os títulos das colunas quando a tabela corrente muda de página. */
  let repeatTableHeader: ((atY: number, continued: boolean) => number) | null = null;

  const ensureSpace = (needed: number) => {
    if (y + needed <= bottomLimit) return;
    doc.addPage();
    y = drawHeader(true);
    // Uma tabela que continua na página seguinte SEM os títulos das colunas
    // deixa o leitor a adivinhar o que é cada número.
    if (repeatTableHeader) y = repeatTableHeader(y, true);
  };

  for (const table of input.tables ?? []) {
    ensureSpace(gap(13));

    if (table.title) {
      doc.text(table.title.toUpperCase(), left, y + 8, { size: 8.5, font: 'bold', color: brand });
      y += gap(3);
    }

    const totalWeight = table.columns.reduce((sum, column) => sum + column.width, 0) || 1;
    const widths = table.columns.map((column) => (column.width / totalWeight) * doc.contentWidth);
    const xs: number[] = [];
    let cursor = left;
    for (const width of widths) { xs.push(cursor); cursor += width; }

    const drawColumns = (atY: number, continued: boolean) => {
      doc.rect(left, atY, doc.contentWidth, 18, { fill: '#F3F4F6' });
      table.columns.forEach((column, index) => {
        doc.text(column.header.toUpperCase(), xs[index] + gap(1), atY + 12, {
          size: 7.5, font: 'bold', color: INK,
          align: column.align, width: widths[index] - gap(2),
        });
      });
      let next = atY + 18;
      if (continued) {
        doc.text('(continuação)', left, next + 9, { size: 7, font: 'italic', color: MUTED });
        next += 12;
      }
      doc.line(left, next, right, next, { color: RULE, width: 0.7 });
      return next;
    };

    y = drawColumns(y, false);
    repeatTableHeader = drawColumns;

    if (table.rows.length === 0) {
      doc.text(table.emptyLabel ?? 'Sem movimento no período.', left + gap(1), y + 15, { size: 9, color: MUTED });
      y += gap(4.5);
    }

    table.rows.forEach((row, rowIndex) => {
      const heights = row.map((cell, index) => {
        const text = String(cell ?? '');
        const lines = text.length
          ? Math.max(1, Math.ceil(measureText(text, 9) / Math.max(widths[index] - gap(2), 1)))
          : 1;
        return lines * 11;
      });
      const rowHeight = Math.max(15, ...heights) + gap(1);
      ensureSpace(rowHeight + gap(1));

      // Faixas alternadas em vez de um filete por linha: um filete debaixo de
      // cada linha faz a tabela parecer uma folha de cálculo exportada.
      if (rowIndex % 2 === 1) doc.rect(left, y, doc.contentWidth, rowHeight, { fill: '#FAFAFA' });

      row.forEach((cell, index) => {
        doc.textBlock(String(cell ?? ''), xs[index] + gap(1), y + 11, widths[index] - gap(2), {
          size: 9, color: INK, align: table.columns[index]?.align, lineHeight: 11,
        });
      });
      y += rowHeight;
    });

    doc.line(left, y, right, y, { color: RULE, width: 0.7 });
    repeatTableHeader = null;

    // ── Totais ────────────────────────────────────────────────────────────────
    if (table.totals?.length) {
      const strongCount = table.totals.filter((total) => total.strong).length;
      ensureSpace(table.totals.length * 15 + strongCount * 12 + gap(3));
      y += gap(1.5);

      const boxWidth = 235;
      const boxX = right - boxWidth;

      /**
       * Etiqueta cortada ao espaço que o valor deixa. As etiquetas do IVA são
       * geradas ("IVA 16% sobre 1 234 567,00 MZN") e podem crescer até chegar
       * ao valor — e um total ilegível é o pior sítio para ter esse problema.
       */
      const labelRoom = (value: string, valueSize: number, valueFont: 'bold' | 'regular') =>
        boxWidth - gap(3) - measureText(value, valueSize, valueFont) - gap(1);

      for (const total of table.totals) {
        if (total.strong) {
          // O total a pagar tem de ser encontrado sem ser procurado.
          const bandHeight = 25;
          doc.rect(boxX, y, boxWidth, bandHeight, { fill: brand });
          const onBrand = readableOn(brand);
          doc.text(fitOneLine(total.label.toUpperCase(), labelRoom(total.value, 12, 'bold'), 9), boxX + gap(1.5), y + 16.5, {
            size: 9, font: 'bold', color: onBrand,
          });
          doc.text(total.value, boxX, y + 16.5, {
            size: 12, font: 'bold', color: onBrand, align: 'right', width: boxWidth - gap(1.5),
          });
          y += bandHeight + gap(0.5);
        } else {
          doc.text(fitOneLine(total.label, labelRoom(total.value, 8.5, 'regular'), 8.5), boxX + gap(1.5), y + 10, {
            size: 8.5, color: MUTED,
          });
          doc.text(total.value, boxX, y + 10, {
            size: 8.5, color: INK, align: 'right', width: boxWidth - gap(1.5),
          });
          y += 14;
        }
      }
      y += gap(1);
    }

    y += gap(2.5);
  }

  // ── Notas ───────────────────────────────────────────────────────────────────
  for (const note of input.notes ?? []) {
    ensureSpace(gap(5));
    y += doc.textBlock(note, left, y + 6, doc.contentWidth, { size: 8.5, color: MUTED, lineHeight: 11 }) + gap(1.5);
  }

  if (profile?.bank_details) {
    ensureSpace(gap(9));
    y += gap(1.5);
    doc.text('COORDENADAS BANCÁRIAS', left, y + 8, { size: 7.5, font: 'bold', color: brand });
    y += gap(2);
    doc.line(left, y, left + 120, y, { color: RULE, width: 0.5 });
    y += doc.textBlock(profile.bank_details, left, y + 12, doc.contentWidth, { size: 8.5, color: INK, lineHeight: 11 }) + gap(2);
  }

  // ── Assinaturas ─────────────────────────────────────────────────────────────
  if (input.signatures?.length) {
    ensureSpace(gap(12));
    y += gap(7);
    const slot = doc.contentWidth / input.signatures.length;
    input.signatures.forEach((label, index) => {
      const x = left + index * slot + gap(2);
      const lineWidth = slot - gap(4);
      doc.line(x, y, x + lineWidth, y, { color: '#9CA3AF', width: 0.7 });
      doc.text(label, x, y + 12, { size: 8, color: MUTED, align: 'center', width: lineWidth });
    });
    y += gap(4.5);
  }

  if (input.legalNote) {
    ensureSpace(gap(5));
    y += doc.textBlock(input.legalNote, left, y + 6, doc.contentWidth, { size: 7.5, color: MUTED, lineHeight: 10 }) + gap(1);
  }

  // ── Rodapé, em todas as páginas ─────────────────────────────────────────────
  const footerY = doc.height - doc.margin + 6;
  // O rodapé é UMA linha e leva a designação social, o NUIT e a nota legal —
  // que numa empresa com matrícula por extenso dá mais de uma largura de página.
  // Sem corte, transbordava para fora do papel e passava por cima do "Página X
  // de Y". Reserva-se o espaço do contador e corta-se o resto.
  const counterSpace = measureText('Página 99 de 99', 7) + gap(3);
  const footerText = fitOneLine(
    [profile?.legal_name, profile?.tax_id ? `NUIT ${profile.tax_id}` : '', profile?.footer_note]
      .filter(Boolean).join('  ·  '),
    doc.contentWidth - counterSpace,
    7,
  );

  for (let index = 0; index < doc.pageCount; index += 1) {
    doc.onPage(index, () => {
      doc.line(left, footerY - 13, right, footerY - 13, { color: '#E5E7EB', width: 0.5 });
      doc.text(footerText, left, footerY, { size: 7, color: MUTED });
      doc.text(`Página ${index + 1} de ${doc.pageCount}`, left, footerY, {
        size: 7, color: MUTED, align: 'right', width: doc.contentWidth,
      });
    });
  }

  return doc;
}

/** Compõe e descarrega o documento no browser. */
export async function buildCompanyPdf(input: CompanyPdfInput): Promise<void> {
  const doc = await composeCompanyPdf(input);
  doc.save(input.filename);
}
