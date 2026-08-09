/**
 * @file pricing.pg.spec.js
 * @description Testes de integração da tarifação contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.13
 *
 * Prova, contra a base real (`track`): a função pura `computeQuote` produz o
 * detalhe exato; o caso de uso `quote` carrega a zona e calcula (e rejeita zona
 * inexistente/inativa); as zonas por default de MZ estão presentes; a criação de
 * zona valida o código duplicado; e um pedido criado com peso/pricing persiste
 * esses campos. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona pricing_zones + colunas)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { PricingZoneFactory, QuoteInputFactory, ServiceLevel, BULKY_BOX_CM } from '../harness/factories/pricing.factory';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/pricing.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const ZONE_CODE = 'ZONE_ITEST_PRICE';
const ORDER_ID = 'order-itest-price-0001';

async function cleanup() {
  await pool.query('DELETE FROM orders WHERE id = $1', [ORDER_ID]);
  await pool.query('DELETE FROM pricing_zones WHERE code = ANY($1::text[])', [[ZONE_CODE, `${ZONE_CODE}_KM`]]);
}

describe.skipIf(!disponivel)('api-gateway · tarifação · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await svc.createZone(PricingZoneFactory.build({ code: ZONE_CODE, name: 'Zona ITEST', base_cents: 20000, per_kg_cents: 3000, included_kg: 1 }));
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should compute a quote purely (base + weight)', () => {
    const zone = { code: ZONE_CODE, name: 'Zona ITEST', base_cents: 20000, per_kg_cents: 3000, included_kg: 1 };
    // 3kg: excesso 2kg -> 3000*2 = 6000; total 26000
    const q = svc.computeQuote({ weight_grams: 3000, service: ServiceLevel.NORMAL }, zone);
    expect(q.base_cents).toBe(20000);
    expect(q.weight_cents).toBe(6000);
    expect(q.service_cents).toBe(0);
    expect(q.total_cents).toBe(26000);
    expect(q.currency).toBe('MZN');
  });

  it('should apply the express multiplier', () => {
    const zone = { code: ZONE_CODE, name: 'Zona ITEST', base_cents: 20000, per_kg_cents: 3000, included_kg: 1 };
    // preService 26000; express +50% -> service 13000; total 39000 (multiplicador default 1.5)
    const q = svc.computeQuote({ weight_grams: 3000, service: ServiceLevel.EXPRESS }, zone);
    expect(q.service_cents).toBe(13000);
    expect(q.total_cents).toBe(39000);
  });

  it('should not charge weight under the included allowance', () => {
    const zone = { code: ZONE_CODE, name: 'Zona ITEST', base_cents: 20000, per_kg_cents: 3000, included_kg: 1 };
    const q = svc.computeQuote({ weight_grams: 800 }, zone);
    expect(q.weight_cents).toBe(0);
    expect(q.total_cents).toBe(20000);
  });

  it('should quote via the use case loading the zone', async () => {
    const q = await svc.quote(QuoteInputFactory.build(ZONE_CODE, { weight_grams: 3000 }));
    expect(q.zone_code).toBe(ZONE_CODE);
    expect(q.total_cents).toBe(26000);
  });

  it('should reject a quote for an unknown zone', async () => {
    await expect(svc.quote({ zone_code: 'NAO_EXISTE', weight_grams: 1000 }))
      .rejects.toMatchObject({ name: 'ZoneNotFoundError', statusCode: 404 });
  });

  it('should ship default Mozambique zones', async () => {
    const zones = await svc.listZones({ activeOnly: true });
    const codes = zones.map((z) => z.code);
    expect(codes).toContain('MAPUTO_CITY');
    expect(codes).toContain('GRANDE_MAPUTO');
    expect(codes).toContain('INTERNACIONAL');
  });

  it('should reject a duplicate zone code', async () => {
    await expect(svc.createZone(PricingZoneFactory.build({ code: ZONE_CODE, name: 'Dup' })))
      .rejects.toMatchObject({ name: 'DuplicateZoneCodeError', statusCode: 409 });
  });

  it('should persist weight and pricing on an order', async () => {
    const zone = { code: ZONE_CODE, name: 'Zona ITEST', base_cents: 20000, per_kg_cents: 3000, included_kg: 1 };
    const breakdown = svc.computeQuote({ weight_grams: 3000 }, zone);
    const base = OrderFactory.build({ id: ORDER_ID, tracking_code: 'TRK-ITESTPRICE-01' });
    await repo.OrderRepository.create({ ...base, value: breakdown.total_cents, weight_grams: 3000, pricing: breakdown, history: [] });

    const saved = await repo.OrderRepository.findById(ORDER_ID);
    expect(saved.weight_grams).toBe(3000);
    expect(saved.value).toBe(26000);
    expect(saved.pricing.total_cents).toBe(26000);
    expect(saved.pricing.zone_code).toBe(ZONE_CODE);
  });

  // ── Volume e distância (§ 3.13) ────────────────────────────────────────────

  it('should persist the per-km price on a zone', async () => {
    const zona = await svc.createZone(PricingZoneFactory.withDistance({
      code: `${ZONE_CODE}_KM`, name: 'Zona ITEST km',
    }));

    expect(zona.per_km_cents).toBe(1500);
    expect(zona.included_km).toBe(5);

    // E volta a sair da base com os mesmos valores — é o round-trip que prova
    // que as colunas novas são lidas e escritas, e não só aceites na entrada.
    const relida = (await svc.listZones()).find((z) => z.code === `${ZONE_CODE}_KM`);
    expect(relida.per_km_cents).toBe(1500);
    expect(relida.included_km).toBe(5);
  });

  it('should quote distance through the use case, loading the zone from the database', async () => {
    const orcamento = await svc.quote({ zone_code: `${ZONE_CODE}_KM`, weight_grams: 500, distance_km: 20 });

    // 20 km − 5 incluídos = 15 × 15,00 = 225,00
    expect(orcamento.distance_cents).toBe(15 * 1500);
    expect(orcamento.total_cents).toBe(orcamento.base_cents + orcamento.weight_cents + orcamento.distance_cents);
  });

  it('should leave existing zones charging exactly what they charged before', async () => {
    // A migração pôs os campos a zero de propósito: uma base já em uso não pode
    // começar a cobrar distância por causa de um deploy.
    const antes = await svc.quote({ zone_code: ZONE_CODE, weight_grams: 3000 });
    const comKm = await svc.quote({ zone_code: ZONE_CODE, weight_grams: 3000, distance_km: 100 });

    expect(comKm.distance_cents).toBe(0);
    expect(comKm.total_cents).toBe(antes.total_cents);
  });

  it('should charge a bulky box by its volumetric weight end to end', async () => {
    const orcamento = await svc.quote({
      zone_code: ZONE_CODE,
      weight_grams: 8000,
      dimensions_cm: BULKY_BOX_CM,
    });

    expect(orcamento.charged_by_volume).toBe(true);
    expect(orcamento.chargeable_grams).toBe(24000);
    // 24 kg − 1 incluído = 23 × 30,00
    expect(orcamento.weight_cents).toBe(23 * 3000);
  });
});
