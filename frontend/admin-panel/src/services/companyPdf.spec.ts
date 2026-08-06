/**
 * @file companyPdf.spec.ts
 * @description Testes do papel timbrado — o que sai impresso em cada documento.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * Verifica o conteúdo do documento composto: cabeçalho da empresa, NUIT, tabela,
 * totais, paginação e rodapé. É o que impede uma regressão silenciosa em que o
 * PDF continua a abrir mas perde o NUIT ou a numeração de páginas.
 *
 * Os fluxos de conteúdo do PDF ficam por comprimir (ver `pdf.ts`), por isso os
 * operadores de desenho são legíveis a partir dos bytes — é assim que aqui se
 * verifica cor e corpo de letra, e não apenas a presença do texto.
 */
import { describe, expect, it } from 'vitest';
import { composeCompanyPdf, badgeColor, readableOn, fitOneLine } from './companyPdf';
import type { CompanyPdfInput } from './companyPdf';
import { A4, measureText, type PdfDocument } from './pdf';
import {
  CompanyPdfFactory, readPdfLayout, findOverlaps, findOutsideMargins, describeOverlap,
} from 'tests/harness';

function asText(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** A factory é estrutural; o `as` é só para o compilador, não muda dados. */
const input = (...args: Parameters<typeof CompanyPdfFactory.input>) =>
  CompanyPdfFactory.input(...args) as CompanyPdfInput;
const invoice = (...args: Parameters<typeof CompanyPdfFactory.invoice>) =>
  CompanyPdfFactory.invoice(...args) as CompanyPdfInput;
const report = (...args: Parameters<typeof CompanyPdfFactory.report>) =>
  CompanyPdfFactory.report(...args) as CompanyPdfInput;
const payslip = (...args: Parameters<typeof CompanyPdfFactory.payslip>) =>
  CompanyPdfFactory.payslip(...args) as CompanyPdfInput;
const stress = (...args: Parameters<typeof CompanyPdfFactory.stressInput>) =>
  CompanyPdfFactory.stressInput(...args) as CompanyPdfInput;

const layoutOf = (doc: PdfDocument) => readPdfLayout(doc.toBytes(), measureText);

/** Corpo de letra com que um texto foi impresso (lido do operador `Tf`). */
function fontSizeOf(stream: string, printedText: string): number | null {
  const line = stream.split('\n').find((row) => row.includes(`(${printedText})`));
  const match = line ? /\/F\d (\d+(?:\.\d+)?) Tf/.exec(line) : null;
  return match ? Number(match[1]) : null;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Papel timbrado · cabeçalho da empresa', () => {
  it('should print the company identity, not a generic header', async () => {
    const doc = await composeCompanyPdf(input());
    const text = asText(doc.toBytes());

    expect(text).toContain('Transportes Teste, Lda.');
    expect(text).toContain('NUIT: 400123456');
    expect(text).toContain('Av. 25 de Setembro, 1234');
    expect(text).toContain('Maputo, Mo');   // acentuada, gravada em Latin-1
  });

  it('should print the title, reference and badge', async () => {
    const doc = await composeCompanyPdf(invoice({
      title: 'Nota de crédito', reference: 'NC A2026/0004', badge: 'PAGA',
    }));
    const text = asText(doc.toBytes());

    expect(text).toContain('NOTA DE CR');      // título em maiúsculas
    expect(text).toContain('NC A2026/0004');
    expect(text).toContain('PAGA');
  });

  it('should print the document number larger than the document-type label', async () => {
    // Ao telefone e na contabilidade procura-se o NÚMERO, não a palavra "Fatura".
    const doc = await composeCompanyPdf(invoice({ title: 'Fatura', reference: 'FT A2026/0007' }));
    const text = asText(doc.toBytes());

    const numberSize = fontSizeOf(text, 'FT A2026/0007');
    const labelSize = fontSizeOf(text, 'FATURA');

    expect(numberSize).not.toBeNull();
    expect(labelSize).not.toBeNull();
    expect(numberSize!).toBeGreaterThan(labelSize!);
  });

  it('should print the subtitle in the body, where a long period still fits', async () => {
    const doc = await composeCompanyPdf(input({
      title: 'Mapa de IVA',
      subtitle: 'Período de 01/08/2026 a 31/08/2026',
    }));
    expect(asText(doc.toBytes())).toContain('01/08/2026 a 31/08/2026');
  });

  it('should survive a company without any brand filled in', async () => {
    const doc = await composeCompanyPdf(input({ profile: null, title: 'Relatório', reference: undefined }));
    const text = asText(doc.toBytes());

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('Empresa');   // marcador de omissão, sem rebentar
  });
});

describe('Papel timbrado · selo de estado', () => {
  // O selo era sempre da cor da marca: um documento ANULADO saía igual a um PAGO.
  it.each([
    ['PAGA', '#047857'],
    ['ATIVA', '#047857'],
    ['SEM VIOLAÇÕES', '#047857'],
    ['ANULADA', '#6B7280'],
    ['CANCELADA', '#6B7280'],
    ['PENDENTE', '#B45309'],
    ['VERIFICAR', '#B45309'],
    ['EM TRÂNSITO', '#1D4ED8'],   // sem significado próprio → cor da marca
  ])('should colour the badge %s by its meaning', (label, expected) => {
    expect(badgeColor(label, '#1D4ED8')).toBe(expected);
  });

  it('should not paint an annulled document with the same badge as a paid one', async () => {
    const paid = asText((await composeCompanyPdf(invoice({ badge: 'PAGA' }))).toBytes());
    const voided = asText((await composeCompanyPdf(invoice({ badge: 'ANULADA' }))).toBytes());

    expect(paid).toContain('0.02 0.47 0.34 rg');    // verde do selo resolvido
    expect(voided).not.toContain('0.02 0.47 0.34 rg');
    expect(voided).toContain('0.42 0.45 0.5 rg');   // neutro: já não conta
  });
});

describe('Papel timbrado · legibilidade da cor da marca', () => {
  it.each([
    ['#0F172A', '#FFFFFF'],   // marca escura → texto branco
    ['#1D4ED8', '#FFFFFF'],
    ['#FDE047', '#111827'],   // amarelo → texto escuro
    ['#FFFFFF', '#111827'],
    ['nao-e-cor', '#FFFFFF'],
  ])('should pick readable ink over %s', (background, expected) => {
    expect(readableOn(background)).toBe(expected);
  });

  it('should not print the grand total in white over a light brand colour', async () => {
    // Uma empresa pode escolher amarelo. O total a pagar não pode desaparecer.
    const light = asText((await composeCompanyPdf(input({
      profile: CompanyPdfFactory.lightBrandProfile() as CompanyPdfInput['profile'],
    }))).toBytes());
    const dark = asText((await composeCompanyPdf(input())).toBytes());

    expect(light).not.toContain('1 1 1 rg');
    expect(dark).toContain('1 1 1 rg');
  });
});

describe('Papel timbrado · corte de uma linha só', () => {
  it('should leave a text that already fits untouched', () => {
    expect(fitOneLine('Transportes Teste, Lda.', 400, 7)).toBe('Transportes Teste, Lda.');
  });

  it('should cut what does not fit and mark it as cut', () => {
    const cut = fitOneLine('Sociedade de Transportes e Distribuição de Moçambique, Limitada', 60, 7);

    expect(cut.endsWith('...')).toBe(true);
    expect(measureText(cut, 7)).toBeLessThanOrEqual(60);
  });

  it('should not use the ellipsis character, which WinAnsi would lose', () => {
    expect(fitOneLine('a'.repeat(200), 40, 7)).not.toContain('…');
  });

  it('should survive an empty text', () => {
    expect(fitOneLine('', 40, 7)).toBe('');
  });
});

describe('Papel timbrado · corpo do documento', () => {
  it('should print parties, metadata and table contents', async () => {
    const doc = await composeCompanyPdf(invoice());
    const text = asText(doc.toBytes());

    expect(text).toContain('CLIENTE');
    expect(text).toContain('Cliente Teste');
    expect(text).toContain('NUIT: 400999888');
    expect(text).toContain('Data de emiss');
    expect(text).toContain('Servi');           // linha da tabela
    expect(text).toContain('1 160,00 MZN');
  });

  it('should print the empty-table placeholder instead of a blank block', async () => {
    const doc = await composeCompanyPdf(input({
      title: 'Mapa de IVA',
      tables: [CompanyPdfFactory.emptyTable()],
    }));
    expect(asText(doc.toBytes())).toContain('Sem movimento no per');
  });

  it('should print bank details and the legal note when present', async () => {
    const doc = await composeCompanyPdf(invoice());
    const text = asText(doc.toBytes());

    expect(text).toContain('COORDENADAS BANC');
    expect(text).toContain('BCI');
    expect(text).toContain('Processado por computador');
  });
});

describe('Papel timbrado · assinaturas', () => {
  it('should draw a signature slot per label', async () => {
    const doc = await composeCompanyPdf(payslip());
    const text = asText(doc.toBytes());

    expect(text).toContain('Entidade empregadora');
    expect(text).toContain('Colaborador');
  });

  it('should draw nothing extra when there are no signatures', async () => {
    const withSignatures = await composeCompanyPdf(payslip());
    const without = await composeCompanyPdf(payslip({ signatures: undefined }));

    expect(withSignatures.toBytes().length).toBeGreaterThan(without.toBytes().length);
  });
});

describe('Papel timbrado · desenho da página', () => {
  // "Está profissional" não se verifica sem olhar; o que se verifica é o que
  // estraga um documento à distância — texto fora das margens e texto por cima
  // de texto. Ver `tests/harness/pdf-layout.ts`.
  const cases: Array<[string, () => CompanyPdfInput]> = [
    ['fatura', () => invoice()],
    ['relatório de várias páginas', () => report(90)],
    ['recibo com assinaturas', () => payslip()],
    ['documento com tudo longo', () => stress()],
  ];

  it.each(cases)('should keep every printed text inside the margins (%s)', async (_name, build) => {
    const layout = layoutOf(await composeCompanyPdf(build()));
    const escaping = findOutsideMargins(layout.runs, { margin: 48, pageWidth: A4.width });

    expect(escaping.map((run) => `${run.text} @ x ${run.x.toFixed(1)}`)).toEqual([]);
  });

  it.each(cases)('should never print one text over another (%s)', async (_name, build) => {
    const layout = layoutOf(await composeCompanyPdf(build()));
    const collisions = findOverlaps(layout.runs);

    expect(collisions.map(describeOverlap)).toEqual([]);
  });

  it('should wrap a long legal name instead of running it into the document number', async () => {
    const profile = CompanyPdfFactory.verboseProfile() as CompanyPdfInput['profile'];
    const layout = layoutOf(await composeCompanyPdf(stress({ profile })));
    // Pelo corpo de letra: o mesmo nome repete-se no bloco do emitente, a 9 pt.
    const nameLines = layout.onPage(0)
      .filter((run) => run.size > 11 && profile!.legal_name.includes(run.text));

    // A designação social saiu partida em linhas — inteira, não truncada.
    expect(nameLines.length).toBeGreaterThan(1);
    expect(nameLines.map((run) => run.text).join(' ')).toBe(profile!.legal_name);

    // E nenhuma delas chega à coluna reservada ao número do documento.
    const numberColumn = A4.width - 48 - 210;
    for (const run of nameLines) expect(run.x + run.width).toBeLessThanOrEqual(numberColumn);
  });

  it('should clip a generated tax label before it reaches the amount', async () => {
    // As etiquetas do IVA são construídas a partir dos valores e podem crescer.
    const layout = layoutOf(await composeCompanyPdf(stress()));
    const label = layout.runs.find((run) => run.text.startsWith('IVA 16% sobre'));
    const amount = layout.runs.find((run) => run.text === '9 600,00 MZN');

    expect(label?.text.endsWith('...')).toBe(true);
    expect(label!.x + label!.width).toBeLessThan(amount!.x);
  });

  it('should clip the footer line instead of letting it run off the page', async () => {
    const layout = layoutOf(await composeCompanyPdf(stress()));
    const footer = layout.onPage(0).filter((run) => run.y > A4.height - 60);

    expect(footer.some((run) => run.text.endsWith('...'))).toBe(true);
    expect(footer.some((run) => run.text.startsWith('Página 1 de'))).toBe(true);
  });
});

describe('Papel timbrado · paginação', () => {
  it('should break into more pages as rows overflow and number them all', async () => {
    const doc = await composeCompanyPdf(report(90));
    const text = asText(doc.toBytes());

    expect(doc.pageCount).toBeGreaterThan(1);
    expect(text).toContain(`/Count ${doc.pageCount}`);
    expect(text).toContain(`gina 1 de ${doc.pageCount}`);
    expect(text).toContain(`gina ${doc.pageCount} de ${doc.pageCount}`);
    // A última linha não se perdeu na quebra de página.
    expect(text).toContain('entrega n');
  });

  it('should repeat the company name on every page footer', async () => {
    const doc = await composeCompanyPdf(report(90));
    const text = asText(doc.toBytes());

    // Cabeçalho de cada página + rodapé de cada página.
    expect(occurrences(text, 'Transportes Teste, Lda.')).toBeGreaterThanOrEqual(doc.pageCount * 2);
  });

  it('should repeat the column headers when a table continues on the next page', async () => {
    // Sem isto, a segunda página de uma tabela é uma lista de números sem nome.
    const doc = await composeCompanyPdf(report(90));
    const text = asText(doc.toBytes());

    expect(doc.pageCount).toBeGreaterThan(1);
    expect(occurrences(text, 'DESCRI')).toBeGreaterThanOrEqual(doc.pageCount);
    expect(occurrences(text, 'TOTAL')).toBeGreaterThanOrEqual(doc.pageCount);
    expect(text).toContain('continua');   // marca a tabela como continuação
  });

  it('should not mark the first page of a table as a continuation', async () => {
    const doc = await composeCompanyPdf(input());

    expect(doc.pageCount).toBe(1);
    expect(asText(doc.toBytes())).not.toContain('continua');
  });
});
