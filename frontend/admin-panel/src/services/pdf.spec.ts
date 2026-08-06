/**
 * @file pdf.spec.ts
 * @description Testes do escritor de PDF (medição, quebra e estrutura do ficheiro).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * O ficheiro produzido tem de ser abrível por qualquer leitor: o que aqui se
 * verifica é o contrato do formato — cabeçalho, objetos, tabela de referências
 * cruzadas com os desvios certos e `startxref` a apontar para ela. Um erro de um
 * byte nos desvios dá um PDF corrompido, e é isso que estes testes protegem.
 */
import { describe, expect, it } from 'vitest';
import { PdfDocument, measureText, wrapText, escapePdfText, A4 } from './pdf';

/** Lê os bytes como Latin-1 para poder inspecionar a estrutura do ficheiro. */
function asText(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

describe('PDF · métricas de texto', () => {
  it('should measure width proportional to the font size', () => {
    const small = measureText('SmartTrack', 10);
    const large = measureText('SmartTrack', 20);
    expect(large).toBeCloseTo(small * 2, 5);
  });

  it('should measure bold wider than regular for the same text', () => {
    expect(measureText('Fatura', 10, 'bold')).toBeGreaterThan(measureText('Fatura', 10));
  });

  it('should give accented letters the same width as their base letter', () => {
    // Em Helvetica o avanço de "á" é o de "a" — é o que permite alinhar em português.
    expect(measureText('Endereço', 10)).toBeCloseTo(measureText('Endereco', 10), 5);
  });

  it('should measure an empty string as zero', () => {
    expect(measureText('', 12)).toBe(0);
  });
});

describe('PDF · quebra de linhas', () => {
  it('should keep a short text on a single line', () => {
    expect(wrapText('Serviço de entrega', 400, 10)).toEqual(['Serviço de entrega']);
  });

  it('should break a long text into lines that fit', () => {
    const text = 'Serviço de entrega expresso entre Maputo Cidade e a Matola com recolha ao domicílio';
    const lines = wrapText(text, 120, 9);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, 9)).toBeLessThanOrEqual(120);
  });

  it('should honour explicit line breaks', () => {
    expect(wrapText('Linha 1\nLinha 2', 400, 10)).toEqual(['Linha 1', 'Linha 2']);
  });

  it('should never drop a word that is wider than the box', () => {
    const lines = wrapText('inqualificavelmentesupercalifragilistico', 30, 10);
    expect(lines.join('')).toContain('inqualificavelmentesupercalifragilistico');
  });
});

describe('PDF · escape', () => {
  it.each([
    ['Empresa (Lda)', 'Empresa \\(Lda\\)'],
    ['C:\\arquivo', 'C:\\\\arquivo'],
  ])('should escape %s', (input, expected) => {
    expect(escapePdfText(input)).toBe(expected);
  });

  it('should flatten newlines that would break the text operator', () => {
    expect(escapePdfText('linha1\nlinha2')).toBe('linha1 linha2');
  });
});

describe('PDF · estrutura do ficheiro', () => {
  function sample(): PdfDocument {
    const doc = new PdfDocument({ title: 'Fatura FT A2026/0001' });
    doc.text('Transportes ITEST, Lda.', 48, 60, { size: 13, font: 'bold', color: '#0F172A' });
    doc.text('116,00 MZN', 48, 80, { align: 'right', width: doc.contentWidth });
    doc.line(48, 90, 548, 90);
    doc.rect(48, 100, 200, 18, { fill: '#F3F4F6' });
    return doc;
  }

  it('should start with the PDF header and end with EOF', () => {
    const text = asText(sample().toBytes());
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('should point startxref at the actual xref table', () => {
    const text = asText(sample().toBytes());
    const declared = Number(/startxref\n(\d+)/.exec(text)?.[1]);

    expect(Number.isFinite(declared)).toBe(true);
    expect(text.slice(declared, declared + 4)).toBe('xref');
  });

  it('should list every object in the xref table with a correct offset', () => {
    const bytes = sample().toBytes();
    const text = asText(bytes);
    const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
    const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));

    // Size conta o objeto 0 (livre), que não tem entrada "n".
    expect(entries).toHaveLength(size - 1);
    entries.forEach((offset, index) => {
      expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
  });

  it('should declare the A4 media box', () => {
    expect(asText(sample().toBytes())).toContain(`/MediaBox [0 0 ${A4.width} ${A4.height}]`);
  });

  it('should embed the standard fonts with WinAnsi encoding for Portuguese', () => {
    const text = asText(sample().toBytes());
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
  });

  it('should grow the page count when a page is added', () => {
    const doc = sample();
    expect(doc.pageCount).toBe(1);
    doc.addPage();
    doc.text('Continuação', 48, 60);
    expect(doc.pageCount).toBe(2);
    expect(asText(doc.toBytes())).toContain('/Count 2');
  });

  it('should draw on an earlier page without losing the current one', () => {
    const doc = new PdfDocument();
    doc.text('Pagina um', 48, 60);
    doc.addPage();
    doc.text('Pagina dois', 48, 60);
    doc.onPage(0, () => doc.text('Rodape da pagina um', 48, 800));
    doc.text('Ainda na pagina dois', 48, 80);

    const text = asText(doc.toBytes());
    expect(text).toContain('Rodape da pagina um');
    expect(text).toContain('Ainda na pagina dois');
    expect(doc.pageCount).toBe(2);
  });

  it('should encode accented characters as single Latin-1 bytes', () => {
    const doc = new PdfDocument();
    doc.text('Emissão', 48, 60);
    const text = asText(doc.toBytes());
    // "ã" = 0xE3 em WinAnsi/Latin-1; se saísse em UTF-8 seriam dois bytes.
    expect(text).toContain(`Emiss${String.fromCharCode(0xe3)}o`);
  });

  it('should ignore a missing image instead of corrupting the document', () => {
    const doc = new PdfDocument();
    doc.image(null, 48, 48, 100, 40);
    expect(asText(doc.toBytes())).not.toContain('/XObject');
  });
});
