/**
 * @file xlsx.js
 * @description Escritor de ficheiros .xlsx, sem dependências externas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * PORQUÊ ESCREVER ISTO EM VEZ DE INSTALAR UMA BIBLIOTECA: é o mesmo caminho que
 * o projeto já seguiu no motor de PDF (§ 3.20) e no gerador de Code128 (§ 3.15).
 * Um .xlsx é um ZIP com meia dúzia de ficheiros XML; as bibliotecas do costume
 * trazem dezenas de MB e uma superfície de manutenção grande para produzir uma
 * grelha de células. Acresce que o registo npm não está acessível a partir desta
 * máquina — mas mesmo que estivesse, a decisão seria a mesma.
 *
 * O QUE ISTO FAZ, e chega: várias folhas, cabeçalho a negrito, larguras de
 * coluna, e — o que distingue mesmo do CSV — **números que chegam ao Excel como
 * números**. Num CSV, 1.234,56 MZN chega como texto e não soma; é essa a razão
 * de quem trabalha com estes relatórios pedir Excel e não CSV.
 *
 * O QUE NÃO FAZ: fórmulas, gráficos, cores condicionais, datas como serial do
 * Excel. As datas vão como texto ISO — legível, ordenável e sem a ambiguidade do
 * calendário de 1900 que o formato arrasta desde os anos 80.
 */
'use strict';

const zlib = require('zlib');

// ─── CRC-32 (exigido pelo formato ZIP) ───────────────────────────────────────

/** Tabela pré-calculada — o cálculo byte a byte sem ela é ordens de grandeza mais lento. */
const CRC_TABLE = (() => {
  const tabela = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c;
  }
  return tabela;
})();

/**
 * @param {Buffer} buf
 * @returns {number} CRC-32 sem sinal.
 */
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  }
  return (c ^ -1) >>> 0;
}

// ─── Contentor ZIP ───────────────────────────────────────────────────────────

/**
 * Empacota entradas num ZIP.
 *
 * Sem data real nos cabeçalhos (0) de propósito: um ficheiro gerado do mesmo
 * relatório duas vezes fica byte a byte igual, o que torna os testes afirmáveis
 * e as comparações possíveis.
 *
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const locais = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nome = Buffer.from(entry.name, 'utf8');
    const cru = entry.data;
    const comprimido = zlib.deflateRawSync(cru);
    const crc = crc32(cru);

    const cabecalho = Buffer.alloc(30);
    cabecalho.writeUInt32LE(0x04034b50, 0);   // assinatura
    cabecalho.writeUInt16LE(20, 4);           // versão necessária
    cabecalho.writeUInt16LE(0, 6);            // flags
    cabecalho.writeUInt16LE(8, 8);            // método: deflate
    cabecalho.writeUInt16LE(0, 10);           // hora
    cabecalho.writeUInt16LE(0, 12);           // data
    cabecalho.writeUInt32LE(crc, 14);
    cabecalho.writeUInt32LE(comprimido.length, 18);
    cabecalho.writeUInt32LE(cru.length, 22);
    cabecalho.writeUInt16LE(nome.length, 26);
    cabecalho.writeUInt16LE(0, 28);           // extra

    locais.push(cabecalho, nome, comprimido);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);                 // versão de criação
    dir.writeUInt16LE(20, 6);                 // versão necessária
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(comprimido.length, 20);
    dir.writeUInt32LE(cru.length, 24);
    dir.writeUInt16LE(nome.length, 28);
    dir.writeUInt16LE(0, 30);                 // extra
    dir.writeUInt16LE(0, 32);                 // comentário
    dir.writeUInt16LE(0, 34);                 // disco
    dir.writeUInt16LE(0, 36);                 // atributos internos
    dir.writeUInt32LE(0, 38);                 // atributos externos
    dir.writeUInt32LE(offset, 42);            // posição do cabeçalho local

    central.push(dir, nome);
    offset += cabecalho.length + nome.length + comprimido.length;
  }

  const corpoCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(entries.length, 8);
  fim.writeUInt16LE(entries.length, 10);
  fim.writeUInt32LE(corpoCentral.length, 12);
  fim.writeUInt32LE(offset, 16);
  fim.writeUInt16LE(0, 20);

  return Buffer.concat([...locais, corpoCentral, fim]);
}

// ─── XML ─────────────────────────────────────────────────────────────────────

/**
 * Escapa texto para XML. PURA.
 *
 * Um nome de cliente com `&` ou `<` — "Silva & Filhos" — produziria um ficheiro
 * que o Excel recusa abrir, com uma mensagem que não diz porquê.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Caracteres de controlo são inválidos em XML 1.0 e chegam por vezes de
    // campos colados pelo utilizador.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Referência de célula a partir dos índices. PURA.
 * @param {number} col 0-based
 * @param {number} row 0-based
 * @returns {string} Ex.: 'AA3'
 */
function cellRef(col, row) {
  let letras = '';
  let n = col;
  do {
    letras = String.fromCharCode(65 + (n % 26)) + letras;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${letras}${row + 1}`;
}

/**
 * Uma célula. PURA.
 *
 * Números vão como número: é a diferença que faz alguém pedir Excel em vez de
 * CSV, onde 1234.56 chega como texto e não soma.
 *
 * @param {number} col
 * @param {number} row
 * @param {unknown} valor
 * @param {number} estilo Índice em styles.xml (0 = normal, 1 = cabeçalho).
 * @returns {string}
 */
function cellXml(col, row, valor, estilo = 0) {
  const ref = cellRef(col, row);
  const s = estilo ? ` s="${estilo}"` : '';

  if (valor === null || valor === undefined || valor === '') {
    return `<c r="${ref}"${s}/>`;
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return `<c r="${ref}"${s}><v>${valor}</v></c>`;
  }
  if (typeof valor === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${valor ? 1 : 0}</v></c>`;
  }
  // `inlineStr` evita a tabela de cadeias partilhadas — menos um ficheiro no
  // pacote e menos um sítio onde os índices podem sair trocados.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(valor)}</t></is></c>`;
}

/**
 * Uma folha completa. PURA.
 * @param {{ columns: Array<{ header: string, width?: number }>, rows: unknown[][] }} sheet
 * @returns {string}
 */
function sheetXml(sheet) {
  const colunas = sheet.columns ?? [];
  const linhas = sheet.rows ?? [];

  const larguras = colunas.length
    ? `<cols>${colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const cabecalho = colunas.length
    ? `<row r="1">${colunas.map((c, i) => cellXml(i, 0, c.header, 1)).join('')}</row>`
    : '';

  const corpo = linhas.map((linha, r) => {
    const rowIndex = r + (colunas.length ? 1 : 0);
    return `<row r="${rowIndex + 1}">${linha.map((v, c) => cellXml(c, rowIndex, v)).join('')}</row>`;
  }).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + larguras
    + `<sheetData>${cabecalho}${corpo}</sheetData>`
    + '</worksheet>';
}

/**
 * Nome de folha aceite pelo Excel. PURA.
 *
 * O Excel recusa `: \ / ? * [ ]` e nomes acima de 31 caracteres, e a mensagem de
 * erro que dá não menciona o nome da folha — daí sanear aqui.
 *
 * @param {string} nome
 * @param {number} indice
 * @returns {string}
 */
function safeSheetName(nome, indice) {
  const limpo = String(nome ?? '').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return limpo || `Folha${indice + 1}`;
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Constrói um .xlsx com uma ou mais folhas.
 *
 * @param {Array<{ name: string, columns: Array<{ header: string, width?: number }>, rows: unknown[][] }>} sheets
 * @returns {Buffer}
 */
function buildXlsx(sheets) {
  const folhas = (sheets ?? []).length ? sheets : [{ name: 'Folha1', columns: [], rows: [] }];

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + folhas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets>'
    + folhas.map((f, i) => `<sheet name="${escapeXml(safeSheetName(f.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>';

  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + folhas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${folhas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>';

  // Dois estilos: normal e cabeçalho a negrito. Chega — o resto é decoração que
  // não muda o que se faz com o ficheiro.
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    + '<borders count="1"><border/></borders>'
    + '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
    + '<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>'
    + '</styleSheet>';

  const entradas = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    ...folhas.map((f, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(f), 'utf8'),
    })),
  ];

  return zip(entradas);
}

module.exports = {
  buildXlsx,
  // Puros — exportados para teste
  crc32,
  zip,
  escapeXml,
  cellRef,
  cellXml,
  sheetXml,
  safeSheetName,
};
