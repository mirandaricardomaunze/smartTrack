/**
 * @file code128.ts
 * @description Gerador de código de barras Code128 (subconjunto B) em SVG — sem dependências.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.15
 *
 * Code128B cobre ASCII imprimível (32–126), suficiente para códigos de rastreio
 * (ex.: TRK00000001BR, LX987654321CN). Leitores de mão de armazém leem Code128
 * como entrada de teclado. `encodeToCodes` é exposto para teste determinístico.
 */

// Padrões de largura (módulos) por valor 0..106. O índice 106 é o Stop (inclui a
// barra de terminação). Tabela canónica do Code128.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;

/** Mantém apenas caracteres representáveis em Code128B (32–126). */
function sanitize(text: string): string {
  return String(text).replace(/[^\x20-\x7e]/g, '');
}

/**
 * Codifica um texto na sequência numérica de símbolos Code128B
 * (Start B, dados, dígito de controlo mod 103, Stop). Exposto para teste.
 */
export function encodeToCodes(text: string): number[] {
  const clean = sanitize(text);
  const values = [...clean].map((ch) => ch.charCodeAt(0) - 32);
  let checksum = START_B;
  values.forEach((v, i) => { checksum += v * (i + 1); });
  checksum %= 103;
  return [START_B, ...values, checksum, STOP];
}

export interface Code128Options {
  /** Largura de um módulo em px (default 1.6). */
  module?: number;
  /** Altura das barras em px (default 56). */
  height?: number;
  /** Zona de silêncio em módulos de cada lado (default 10). */
  quiet?: number;
}

/**
 * Devolve um SVG (string) com o código de barras do texto.
 * As barras são pretas sobre fundo branco (para leitura fiável na impressão).
 */
export function toSvg(text: string, opts: Code128Options = {}): string {
  const module = opts.module ?? 1.6;
  const height = opts.height ?? 56;
  const quiet = opts.quiet ?? 10;

  const codes = encodeToCodes(text);
  let x = quiet;
  const bars: string[] = [];
  for (const code of codes) {
    const pattern = PATTERNS[code];
    for (let j = 0; j < pattern.length; j += 1) {
      const w = Number(pattern[j]);
      if (j % 2 === 0) bars.push(`<rect x="${(x * module).toFixed(2)}" y="0" width="${(w * module).toFixed(2)}" height="${height}" />`);
      x += w;
    }
  }
  const totalModules = x + quiet;
  const width = totalModules * module;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height}" width="${width.toFixed(2)}" height="${height}" role="img" aria-label="Código de barras ${sanitize(text)}"><rect x="0" y="0" width="${width.toFixed(2)}" height="${height}" fill="#fff"/><g fill="#000">${bars.join('')}</g></svg>`;
}
