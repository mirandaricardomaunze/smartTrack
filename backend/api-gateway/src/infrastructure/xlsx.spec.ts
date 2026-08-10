/**
 * @file xlsx.spec.ts
 * @description Testes do escritor de .xlsx.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * Um ficheiro Excel corrompido falha com uma mensagem que não diz porquê, e quem
 * o recebe não tem como diagnosticar. Por isso os testes abrem o ZIP produzido e
 * leem-no de volta, em vez de se contentarem com "não rebentou".
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const zlib = require('node:zlib');
const { buildXlsx, escapeXml, cellRef, cellXml, sheetXml, safeSheetName, crc32 } = require('./xlsx.js');

/**
 * Lê as entradas de um ZIP a partir do diretório central — é como um leitor real
 * o faz, e por isso é o que prova que o ficheiro é válido.
 */
function readZip(buf: Buffer): Map<string, string> {
  // Fim do diretório central: assinatura 0x06054b50 nos últimos 22 bytes.
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);

  const entradas = buf.readUInt16LE(eocd + 10);
  let ponteiro = buf.readUInt32LE(eocd + 16);

  const saida = new Map<string, string>();
  for (let i = 0; i < entradas; i += 1) {
    expect(buf.readUInt32LE(ponteiro)).toBe(0x02014b50);
    const compSize = buf.readUInt32LE(ponteiro + 20);
    const nomeLen = buf.readUInt16LE(ponteiro + 28);
    const extraLen = buf.readUInt16LE(ponteiro + 30);
    const comentLen = buf.readUInt16LE(ponteiro + 32);
    const localOffset = buf.readUInt32LE(ponteiro + 42);
    const nome = buf.subarray(ponteiro + 46, ponteiro + 46 + nomeLen).toString('utf8');

    const localNomeLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const inicio = localOffset + 30 + localNomeLen + localExtraLen;
    const dados = zlib.inflateRawSync(buf.subarray(inicio, inicio + compSize));

    saida.set(nome, dados.toString('utf8'));
    ponteiro += 46 + nomeLen + extraLen + comentLen;
  }
  return saida;
}

describe('XLSX · contentor ZIP', () => {
  it('should produce an archive a reader can open', () => {
    const buf = buildXlsx([{ name: 'Teste', columns: [{ header: 'A' }], rows: [['x']] }]);
    const entradas = readZip(buf);

    // As peças sem as quais o Excel recusa o ficheiro.
    expect([...entradas.keys()]).toEqual(expect.arrayContaining([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ]));
  });

  it('should compute a CRC that matches the data', () => {
    // Um CRC errado faz o leitor recusar o ficheiro como corrompido.
    expect(crc32(Buffer.from('123456789'))).toBe(0xCBF43926);
  });

  it('should be byte-identical for the same input', () => {
    // Sem data nos cabeçalhos: torna os testes afirmáveis e permite comparar
    // duas exportações do mesmo relatório.
    const folha = [{ name: 'A', columns: [{ header: 'H' }], rows: [[1]] }];
    expect(buildXlsx(folha).equals(buildXlsx(folha))).toBe(true);
  });

  it('should survive being asked for nothing', () => {
    expect(() => readZip(buildXlsx([]))).not.toThrow();
  });
});

describe('XLSX · células', () => {
  it('should write a number as a number, not as text', () => {
    // É a diferença que faz alguém pedir Excel em vez de CSV: em CSV, 1234.56
    // chega como texto e não soma.
    expect(cellXml(0, 0, 1234.56)).toBe('<c r="A1"><v>1234.56</v></c>');
  });

  it('should write text as an inline string', () => {
    expect(cellXml(0, 0, 'Maputo')).toContain('t="inlineStr"');
  });

  it('should leave an empty cell empty instead of writing zero', () => {
    // Um zero onde não há dado é uma afirmação falsa — a mesma regra do resto
    // do sistema.
    expect(cellXml(0, 0, null)).toBe('<c r="A1"/>');
    expect(cellXml(0, 0, undefined)).toBe('<c r="A1"/>');
    expect(cellXml(0, 0, '')).toBe('<c r="A1"/>');
  });

  it('should not write NaN or Infinity as numbers', () => {
    // Ambos são XML inválido no lugar de um número e corrompem o ficheiro.
    expect(cellXml(0, 0, NaN)).toContain('inlineStr');
    expect(cellXml(0, 0, Infinity)).toContain('inlineStr');
  });

  it.each([
    [0, 0, 'A1'],
    [25, 0, 'Z1'],
    [26, 0, 'AA1'],
    [51, 2, 'AZ3'],
    [702, 0, 'AAA1'],
  ])('should reference column %i row %i as %s', (col, row, ref) => {
    expect(cellRef(col, row)).toBe(ref);
  });
});

describe('XLSX · escapes', () => {
  it('should escape a client name with an ampersand', () => {
    // "Silva & Filhos" produziria um ficheiro que o Excel recusa abrir, com uma
    // mensagem que não diz porquê.
    expect(escapeXml('Silva & Filhos')).toBe('Silva &amp; Filhos');
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
  });

  it('should drop control characters that XML forbids', () => {
    expect(escapeXml('a\x00b\x07c')).toBe('abc');
  });

  it('should keep accents and currency symbols intact', () => {
    expect(escapeXml('Endereço · 1.234,56 MZN')).toBe('Endereço · 1.234,56 MZN');
  });
});

describe('XLSX · nomes de folha', () => {
  it('should strip the characters Excel refuses', () => {
    expect(safeSheetName('Vendas/2026:Q1', 0)).toBe('Vendas 2026 Q1');
  });

  it('should cut a name longer than 31 characters', () => {
    expect(safeSheetName('x'.repeat(50), 0)).toHaveLength(31);
  });

  it('should fall back to a numbered name when nothing usable is left', () => {
    expect(safeSheetName('///', 2)).toBe('Folha3');
  });
});

describe('XLSX · folha', () => {
  it('should put the header in the first row, in bold', () => {
    const xml = sheetXml({ columns: [{ header: 'Cliente' }, { header: 'Valor' }], rows: [['Ana', 10]] });

    expect(xml).toContain('<row r="1">');
    expect(xml).toContain('s="1"');       // estilo de cabeçalho
    expect(xml).toContain('<row r="2">'); // primeira linha de dados
  });

  it('should set the column widths so nothing is shown as hashes', () => {
    const xml = sheetXml({ columns: [{ header: 'A', width: 40 }], rows: [] });
    expect(xml).toContain('width="40"');
  });

  it('should produce a valid sheet with no data at all', () => {
    expect(sheetXml({ columns: [], rows: [] })).toContain('<sheetData></sheetData>');
  });
});

describe('XLSX · livro com várias folhas', () => {
  it('should declare every sheet in the workbook and its relationships', () => {
    // Várias folhas num só ficheiro é a outra razão para não usar CSV: um
    // relatório por ficheiro obriga a abrir seis e a colá-los à mão.
    const buf = buildXlsx([
      { name: 'Clientes', columns: [{ header: 'Nome' }], rows: [['Ana']] },
      { name: 'Rotas', columns: [{ header: 'Km' }], rows: [[12.5]] },
    ]);
    const entradas = readZip(buf);

    expect(entradas.get('xl/workbook.xml')).toContain('name="Clientes"');
    expect(entradas.get('xl/workbook.xml')).toContain('name="Rotas"');
    expect(entradas.has('xl/worksheets/sheet2.xml')).toBe(true);
    expect(entradas.get('xl/worksheets/sheet2.xml')).toContain('<v>12.5</v>');
  });
});
