/**
 * @file pricing.service.spec.ts
 * @description Testes unitários do motor de preços.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * `computeQuote` é pura, e é aqui que se afirma o que ela cobra: peso cobrável
 * (o maior entre real e volumétrico), distância acima da incluída, e a ordem em
 * que os multiplicadores incidem. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { PricingZoneFactory, BULKY_BOX_CM, DENSE_BOX_CM } from '../../../../tests/harness';

const {
  computeQuote, normalizeDimensions, volumetricGrams, loadFromDimensions,
  distanceCents, VOLUMETRIC_DIVISOR,
} = require('./pricing.service');

/** Zona sem distância — a mesma de sempre, para provar que nada mudou. */
const ZONA = PricingZoneFactory.build({ code: 'Z', name: 'Zona', base_cents: 20_000, per_kg_cents: 3_000, included_kg: 1 });

describe('Tarifação · dimensões', () => {
  it('should ignore a partial set of dimensions', () => {
    // Com duas medidas não se calcula volume nenhum, e assumir a terceira
    // produziria um preço inventado.
    expect(normalizeDimensions({ length_cm: 30, width_cm: 20 })).toBeNull();
    expect(normalizeDimensions({})).toBeNull();
    expect(normalizeDimensions(undefined)).toBeNull();
  });

  it('should reject a zero or negative side', () => {
    expect(normalizeDimensions({ length_cm: 30, width_cm: 0, height_cm: 10 })).toBeNull();
    expect(normalizeDimensions({ length_cm: 30, width_cm: -5, height_cm: 10 })).toBeNull();
  });

  it('should convert volume into chargeable grams with the configured divisor', () => {
    // 60×40×50 = 120.000 cm³ ÷ 5000 = 24 kg
    expect(volumetricGrams(normalizeDimensions(BULKY_BOX_CM), 5000)).toBe(24_000);
  });

  it('should be zero without dimensions', () => {
    expect(volumetricGrams(null)).toBe(0);
  });

  it('should fall back to the default divisor when given a nonsense one', () => {
    // Um divisor a 0 dividia por zero e devolvia Infinity como peso cobrável.
    expect(volumetricGrams(normalizeDimensions(DENSE_BOX_CM), 0))
      .toBe(volumetricGrams(normalizeDimensions(DENSE_BOX_CM), VOLUMETRIC_DIVISOR));
  });

  it('should derive the physical load the modal check needs', () => {
    const carga = loadFromDimensions(normalizeDimensions(BULKY_BOX_CM));
    expect(carga.volume_l).toBe(120);          // 120.000 cm³ = 120 L
    expect(carga.longest_side_cm).toBe(60);
  });
});

describe('Tarifação · peso cobrável', () => {
  it('should charge the real weight when the box is dense', () => {
    // 20×20×10 = 0,8 kg volumétricos contra 5 kg reais: manda o real.
    const q = computeQuote({ weight_grams: 5_000, dimensions_cm: DENSE_BOX_CM }, ZONA);

    expect(q.chargeable_grams).toBe(5_000);
    expect(q.charged_by_volume).toBe(false);
  });

  it('should charge the volumetric weight when the box is bulky', () => {
    // Um colchão pesa pouco e ocupa a carrinha inteira: o custo é o espaço.
    const q = computeQuote({ weight_grams: 8_000, dimensions_cm: BULKY_BOX_CM }, ZONA);

    expect(q.volumetric_grams).toBe(24_000);
    expect(q.chargeable_grams).toBe(24_000);
    expect(q.charged_by_volume).toBe(true);
  });

  it('should show both weights so the invoice can justify itself', () => {
    // "Porque é que pago 24 kg se a caixa pesa 8?" é a pergunta mais frequente
    // de quem recebe a fatura; sem os dois números não tem resposta.
    const q = computeQuote({ weight_grams: 8_000, dimensions_cm: BULKY_BOX_CM }, ZONA);

    expect(q.weight_grams).toBe(8_000);
    expect(q.volumetric_grams).toBe(24_000);
  });

  it('should price the excess over the included weight, using the chargeable one', () => {
    // 24 kg cobráveis − 1 kg incluído = 23 kg × 30,00 = 690,00
    const q = computeQuote({ weight_grams: 8_000, dimensions_cm: BULKY_BOX_CM }, ZONA);
    expect(q.weight_cents).toBe(23 * 3_000);
  });

  it('should behave exactly as before when no dimensions are given', () => {
    const q = computeQuote({ weight_grams: 5_000 }, ZONA);

    expect(q.volumetric_grams).toBe(0);
    expect(q.chargeable_grams).toBe(5_000);
    expect(q.charged_by_volume).toBe(false);
    expect(q.weight_cents).toBe(4 * 3_000);
    expect(q.total_cents).toBe(20_000 + 12_000);
  });
});

describe('Tarifação · distância', () => {
  const COM_KM = PricingZoneFactory.withDistance({ code: 'ZKM', name: 'Zona km', base_cents: 20_000, per_kg_cents: 3_000, included_kg: 1 });

  it('should charge nothing when the zone has no per-km price', () => {
    expect(distanceCents(80, ZONA)).toBe(0);
  });

  it('should charge only the kilometres above the included ones', () => {
    // 5 km incluídos — cobrar desde o primeiro metro faria a entrega ao lado do
    // armazém sair mais cara do que a concorrência.
    expect(distanceCents(5, COM_KM)).toBe(0);
    expect(distanceCents(12, COM_KM)).toBe(7 * 1_500);
  });

  it('should ignore a missing or nonsensical distance', () => {
    expect(distanceCents(undefined, COM_KM)).toBe(0);
    expect(distanceCents(-10, COM_KM)).toBe(0);
    expect(distanceCents('perto' as unknown as number, COM_KM)).toBe(0);
  });

  it('should add distance as its own line on the breakdown', () => {
    const q = computeQuote({ weight_grams: 1_000, distance_km: 25 }, COM_KM);

    expect(q.distance_km).toBe(25);
    expect(q.distance_cents).toBe(20 * 1_500);
    expect(q.total_cents).toBe(20_000 + 0 + 30_000);
  });

  it('should let the express multiplier reach the distance component', () => {
    // Um expresso a 60 km custa mais do que um normal a 60 km. Deixar a
    // distância fora do multiplicador dava o mesmo acréscimo aos dois.
    const normal   = computeQuote({ weight_grams: 1_000, distance_km: 25 }, COM_KM);
    const expresso = computeQuote({ weight_grams: 1_000, distance_km: 25, service: 'express' }, COM_KM);

    expect(normal.service_cents).toBe(0);
    expect(expresso.service_cents).toBe(Math.round((20_000 + 30_000) * 0.5));
  });
});

describe('Tarifação · verificação de modal com volume', () => {
  it('should refuse a bulky box on a motorcycle even when it is light', () => {
    // 8 kg cabem no peso da moto; 120 L não cabem no baú. Era este o caso que
    // passava e chegava ao armazém com o cliente já notificado.
    const q = computeQuote({ weight_grams: 8_000, dimensions_cm: BULKY_BOX_CM, vehicle_modal: 'MOTO' }, ZONA);

    expect(q.modal_fits).toBe(false);
    expect(q.modal_reason).toMatch(/L|cm/);
  });

  it('should accept a small dense box on a motorcycle', () => {
    const q = computeQuote({ weight_grams: 5_000, dimensions_cm: DENSE_BOX_CM, vehicle_modal: 'MOTO' }, ZONA);
    expect(q.modal_fits).toBe(true);
  });

  it('should check capacity against the REAL weight, not the chargeable one', () => {
    // O veículo carrega quilos, não unidades de faturação. Recusar a moto por
    // causa de 24 kg volumétricos numa caixa de 8 kg seria recusar uma entrega
    // que ela faz perfeitamente — se coubesse em volume.
    const q = computeQuote({ weight_grams: 8_000, dimensions_cm: DENSE_BOX_CM, vehicle_modal: 'MOTO' }, ZONA);

    expect(q.chargeable_grams).toBe(8_000);
    expect(q.modal_fits).toBe(true);
  });
});
