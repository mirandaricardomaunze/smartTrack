/**
 * @file code128.spec.ts
 * @description Testes do gerador Code128B.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.15
 *
 * Vetores verificáveis à mão: em Code128B o valor de um caractere é
 * `charCode - 32` e o dígito de controlo é `(104 + Σ valor_i·posição_i) mod 103`.
 */
import { describe, it, expect } from 'vitest';
import { encodeToCodes, toSvg } from './code128';

describe('code128', () => {
  it('encodes "A" with Start B, value and checksum', () => {
    // 'A' = 65 -> valor 33; checksum = (104 + 33*1) % 103 = 137 % 103 = 34
    expect(encodeToCodes('A')).toEqual([104, 33, 34, 106]);
  });

  it('encodes "AB" with the positional checksum', () => {
    // 'A'->33, 'B'->34; checksum = (104 + 33*1 + 34*2) % 103 = 205 % 103 = 102
    expect(encodeToCodes('AB')).toEqual([104, 33, 34, 102, 106]);
  });

  it('always starts with Start B (104) and ends with Stop (106)', () => {
    const codes = encodeToCodes('TRK00000001BR');
    expect(codes[0]).toBe(104);
    expect(codes[codes.length - 1]).toBe(106);
  });

  it('drops characters outside the Code128B range', () => {
    // Acentos/emoji são removidos; fica "AB".
    expect(encodeToCodes('AéB')).toEqual(encodeToCodes('AB'));
  });

  it('renders an SVG barcode with black bars', () => {
    const svg = toSvg('TRK00000001BR');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<rect');
    expect(svg).toContain('viewBox');
  });
});
