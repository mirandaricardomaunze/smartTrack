/**
 * @file image.spec.ts
 * @description Redução da imagem da prova de entrega antes do envio.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.28
 *
 * O que estes testes protegem: o motorista tem de conseguir fechar a entrega com
 * a fotografia que o telemóvel dele tira. Antes, uma foto de 4 MB era recusada e
 * a entrega ficava por registar no terreno.
 */
import { describe, expect, it } from 'vitest';
import { PodCaptureFactory } from 'tests/harness';
import {
  compressPodImage,
  dataUrlBytes,
  scaledDimensions,
  PodImageTooLargeError,
  MAX_POD_EDGE_PX,
  TARGET_POD_DATA_URL_CHARS,
  QUALITY_STEPS,
} from './image';

describe('scaledDimensions', () => {
  it('should keep the aspect ratio when shrinking to the maximum edge', () => {
    const { width, height } = scaledDimensions(4000, 3000, MAX_POD_EDGE_PX);
    expect(Math.max(width, height)).toBe(MAX_POD_EDGE_PX);
    expect(width / height).toBeCloseTo(4000 / 3000, 2);
  });

  it('should shrink by the tallest side on a portrait photo', () => {
    const { width, height } = scaledDimensions(3000, 4000, MAX_POD_EDGE_PX);
    expect(height).toBe(MAX_POD_EDGE_PX);
    expect(width).toBeLessThan(height);
  });

  it('should leave a small image untouched — enlarging adds no information', () => {
    expect(scaledDimensions(320, 240, MAX_POD_EDGE_PX)).toEqual({ width: 320, height: 240 });
  });
});

describe('dataUrlBytes', () => {
  it('should discount base64 padding instead of reporting the string length', () => {
    // "AAAA" em base64 são 3 bytes; com "==" o último grupo vale 1.
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/jpeg;base64,AAA=')).toBe(2);
    expect(dataUrlBytes('data:image/jpeg;base64,AA==')).toBe(1);
  });

  it('should return zero for something that is not a data URL', () => {
    expect(dataUrlBytes('nada disto é uma imagem')).toBe(0);
  });
});

describe('compressPodImage', () => {
  it('should accept a 4 MB phone photo instead of rejecting it', async () => {
    const file = PodCaptureFactory.buildPhonePhoto();
    const codec = PodCaptureFactory.buildCodec();

    const result = await compressPodImage(file as unknown as File, codec as never);

    expect(result.length).toBeLessThanOrEqual(TARGET_POD_DATA_URL_CHARS);
    expect(result.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('should never encode above the maximum edge, however large the original', async () => {
    const codec = PodCaptureFactory.buildCodec({ width: 8000, height: 6000 });

    await compressPodImage(PodCaptureFactory.buildPhonePhoto() as unknown as File, codec as never);

    for (const attempt of codec.attempts) {
      expect(Math.max(attempt.width, attempt.height)).toBeLessThanOrEqual(MAX_POD_EDGE_PX);
    }
  });

  it('should lower quality before resolution — a signature survives grain, not shrinking', async () => {
    // Pesada o suficiente para o primeiro degrau de qualidade não chegar.
    const codec = PodCaptureFactory.buildCodec({ bytesPerPixel: 1.6 });

    await compressPodImage(PodCaptureFactory.buildPhonePhoto() as unknown as File, codec as never);

    const firstEdge = Math.max(codec.attempts[0].width, codec.attempts[0].height);
    const sameEdge = codec.attempts.filter((a) => Math.max(a.width, a.height) === firstEdge);
    expect(sameEdge.length).toBeGreaterThan(1);
    // Enquanto o tamanho não muda, a qualidade só desce.
    for (let i = 1; i < sameEdge.length; i += 1) {
      expect(sameEdge[i].quality).toBeLessThan(sameEdge[i - 1].quality);
    }
  });

  it('should fall back to shrinking once the lowest quality is not enough', async () => {
    const codec = PodCaptureFactory.buildCodec({ bytesPerPixel: 4 });

    await compressPodImage(PodCaptureFactory.buildPhonePhoto() as unknown as File, codec as never);

    const edges = codec.attempts.map((a) => Math.max(a.width, a.height));
    expect(Math.min(...edges)).toBeLessThan(Math.max(...edges));
    expect(codec.attempts.length).toBeGreaterThan(QUALITY_STEPS.length);
  });

  it('should not touch an image that already fits', async () => {
    const codec = PodCaptureFactory.buildCodec({ width: 600, height: 400, bytesPerPixel: 0.1 });

    const result = await compressPodImage(PodCaptureFactory.buildSignature() as unknown as File, codec as never);

    expect(codec.attempts).toHaveLength(1);
    expect(codec.attempts[0]).toMatchObject({ width: 600, height: 400, quality: QUALITY_STEPS[0] });
    expect(result.length).toBeLessThanOrEqual(TARGET_POD_DATA_URL_CHARS);
  });

  it('should give up with a typed error when no step is enough', async () => {
    // Orçamento impossível em vez de um codec absurdo: uma imagem que exigisse
    // gigabytes rebentaria o alocador do próprio teste antes de chegar ao código.
    const codec = PodCaptureFactory.buildCodec();

    await expect(
      compressPodImage(PodCaptureFactory.buildPhonePhoto() as unknown as File, codec as never, { maxChars: 64 }),
    ).rejects.toBeInstanceOf(PodImageTooLargeError);
  });
});
