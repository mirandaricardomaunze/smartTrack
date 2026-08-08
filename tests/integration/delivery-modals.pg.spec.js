/**
 * @file delivery-modals.pg.spec.js
 * @description Testes de integração das entregas de motociclo e mototriciclo.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.33
 *
 * Prova, contra a base real (`track`), o que o teste unitário do catálogo não
 * alcança: que o mototriciclo entra mesmo no cadastro de motoristas com o
 * código canónico e a capacidade limitada ao teto; que o despacho recusa uma
 * rota mais pesada do que o veículo do motorista **lendo o peso dos pedidos
 * gravados**; e que a tarifação cobra por modal sobre uma zona real.
 *
 * Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { OrderFactory } from '../harness/factories/order.factory';
import { PricingZoneFactory } from '../harness/factories/pricing.factory';
import {
  DeliveryModal,
  DriverVehicleFactory,
  ModalLoadFactory,
  MODAL_CAPACITY_KG,
} from '../harness/factories/delivery-modal.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const drivers  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/drivers.service`) : null;
const dispatch = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/dispatch.service`) : null;
const pricing  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/pricing.service`) : null;
const fleet    = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/fleet.service`) : null;
const repo     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY   = 'company-itest-modais';
const ZONE_CODE = 'ZONE_ITEST_MODAL';

/** Corre um caso de uso dentro do contexto da empresa (multiempresa, § 2.4). */
const inCompany = (fn) => tenant.runWithCompany(COMPANY, fn);

let sequencia = 0;

/**
 * Cria um pedido com peso conhecido — é o peso que o despacho vai somar.
 * @param {number} weightGrams
 * @returns {Promise<object>}
 */
async function seedOrder(weightGrams) {
  sequencia += 1;
  const base = OrderFactory.build({
    id:            `order-itest-modal-${String(sequencia).padStart(3, '0')}`,
    tracking_code: `TRK-ITESTMODAL-${String(sequencia).padStart(3, '0')}`,
  });
  // `value` é NOT NULL na tabela e a factory não o traz — aqui o preço é
  // irrelevante, o que está em teste é o peso.
  return inCompany(() => repo.OrderRepository.create({
    ...base, value: 1990, weight_grams: weightGrams, history: [],
  }));
}

async function cleanup() {
  await pool.query('DELETE FROM orders WHERE id LIKE $1', ['order-itest-modal-%']);
  await pool.query('DELETE FROM audit_events WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM drivers WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM fleet_vehicles WHERE company_id = $1', [COMPANY]);
  await pool.query('DELETE FROM pricing_zones WHERE code = $1', [ZONE_CODE]);
  await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}

describe.skipIf(!disponivel)('api-gateway · entregas de motociclo e mototriciclo · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY, name: 'Modais Lda', slug: COMPANY }));
    await inCompany(() => pricing.createZone(PricingZoneFactory.build({
      code: ZONE_CODE, name: 'Zona Modal', base_cents: 20000, per_kg_cents: 3000, included_kg: 1,
    })));
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  // ── Cadastro do motorista ──────────────────────────────────────────────────

  describe('cadastro de motoristas', () => {
    it('should register a mototriciclista with the canonical modal code', async () => {
      const vehicle = DriverVehicleFactory.mototriciclo({ plate: 'TRI-001-MP' });

      const created = await inCompany(() => drivers.createDriver({
        name: 'Mototriciclista Teste', email: 'mototriciclista@itest.mz', vehicle,
      }));

      expect(created.vehicle.type).toBe(DeliveryModal.MOTOTRICICLO);
      expect(created.vehicle.capacity_kg).toBe(MODAL_CAPACITY_KG[DeliveryModal.MOTOTRICICLO]);
      expect(created.vehicle.licence_category).toBe('A');

      const saved = await inCompany(() => repo.DriverRepository.findById(created.id));
      expect(saved.vehicle.type).toBe(DeliveryModal.MOTOTRICICLO);
    });

    it('should accept the words the operation actually writes ("triciclo")', async () => {
      const created = await inCompany(() => drivers.createDriver({
        name: 'Motorista Sinónimo', email: 'sinonimo@itest.mz',
        vehicle: DriverVehicleFactory.build({ type: 'triciclo', plate: 'TRI-002-MP' }),
      }));

      expect(created.vehicle.type).toBe(DeliveryModal.MOTOTRICICLO);
    });

    it('should cap a declared capacity above the modal ceiling', async () => {
      const created = await inCompany(() => drivers.createDriver({
        name: 'Motociclista Otimista', email: 'otimista@itest.mz',
        vehicle: DriverVehicleFactory.motociclo({ plate: 'MOT-900-MP', capacity_kg: 500 }),
      }));

      expect(created.vehicle.capacity_kg).toBe(MODAL_CAPACITY_KG[DeliveryModal.MOTO]);
    });

    it('should reject a licence that does not cover the modal', async () => {
      await expect(inCompany(() => drivers.createDriver({
        name: 'Carta Errada', email: 'carta@itest.mz',
        vehicle: DriverVehicleFactory.motociclo({ plate: 'MOT-901-MP', licence_category: 'B' }),
      }))).rejects.toThrow(/categoria B/i);
    });
  });

  // ── Despacho ───────────────────────────────────────────────────────────────

  describe('despacho por capacidade', () => {
    /** @type {object} motociclista com o teto do catálogo (25 kg) */
    let motociclista;
    /** @type {object} mototriciclista (350 kg) */
    let mototriciclista;

    beforeAll(async () => {
      motociclista = await inCompany(() => drivers.createDriver({
        name: 'Motociclista Rota', email: 'rota.moto@itest.mz',
        vehicle: DriverVehicleFactory.motociclo({ plate: 'MOT-500-MP' }),
      }));
      mototriciclista = await inCompany(() => drivers.createDriver({
        name: 'Mototriciclista Rota', email: 'rota.tri@itest.mz',
        vehicle: DriverVehicleFactory.mototriciclo({ plate: 'TRI-500-MP' }),
      }));
    });

    it('should allow a load within the motorcycle capacity', async () => {
      const order = await seedOrder(ModalLoadFactory.fits(DeliveryModal.MOTO).weight_grams);

      const resultado = await inCompany(() => dispatch.assertRouteFitsDriver(
        motociclista.id, [{ order_id: order.id }],
      ));

      expect(resultado.modal).toBe(DeliveryModal.MOTO);
      expect(resultado.capacity_kg).toBe(MODAL_CAPACITY_KG[DeliveryModal.MOTO]);
    });

    it('should reject a single parcel heavier than the motorcycle', async () => {
      const order = await seedOrder(ModalLoadFactory.justOverCapacity(DeliveryModal.MOTO).weight_grams);

      await expect(inCompany(() => dispatch.assertRouteFitsDriver(
        motociclista.id, [{ order_id: order.id }],
      ))).rejects.toMatchObject({ name: 'DispatchError', statusCode: 422, suggested_modal: DeliveryModal.MOTOTRICICLO });
    });

    it('should reject stops that fit one by one but exceed the capacity together', async () => {
      // 3 x 10 kg: nenhum volume é grande de mais, a viagem é.
      const stops = [];
      for (let i = 0; i < 3; i++) {
        const order = await seedOrder(10_000);
        stops.push({ order_id: order.id });
      }

      await expect(inCompany(() => dispatch.assertRouteFitsDriver(motociclista.id, stops)))
        .rejects.toThrow(/excede a capacidade/i);
    });

    it('should accept on the mototriciclo the load the motorcycle refused', async () => {
      const order = await seedOrder(ModalLoadFactory.justOverCapacity(DeliveryModal.MOTO).weight_grams);

      const resultado = await inCompany(() => dispatch.assertRouteFitsDriver(
        mototriciclista.id, [{ order_id: order.id }],
      ));

      expect(resultado.modal).toBe(DeliveryModal.MOTOTRICICLO);
    });

    it('should not block stops whose weight was never registered', async () => {
      const order = await seedOrder(null);

      const resultado = await inCompany(() => dispatch.assertRouteFitsDriver(
        motociclista.id, [{ order_id: order.id }],
      ));

      expect(resultado.unknown_weight).toBe(1);
      expect(resultado.load_kg).toBe(0);
    });
  });

  // ── Tarifação ──────────────────────────────────────────────────────────────

  describe('tarifação por modal', () => {
    it('should charge less by motorcycle than by van for the same parcel', async () => {
      const [moto, van] = await Promise.all([
        inCompany(() => pricing.quote({ zone_code: ZONE_CODE, weight_grams: 3000, vehicle_modal: DeliveryModal.MOTO })),
        inCompany(() => pricing.quote({ zone_code: ZONE_CODE, weight_grams: 3000, vehicle_modal: DeliveryModal.VAN })),
      ]);

      expect(moto.modal_cents).toBeLessThan(0);
      expect(van.modal_cents).toBeGreaterThan(0);
      expect(moto.total_cents).toBeLessThan(van.total_cents);
    });

    it('should keep the previous price when no modal is asked for', async () => {
      const semModal = await inCompany(() => pricing.quote({ zone_code: ZONE_CODE, weight_grams: 3000 }));

      expect(semModal.vehicle_modal).toBeNull();
      expect(semModal.modal_cents).toBe(0);
      expect(semModal.total_cents).toBe(26000); // 20000 base + 2 kg de excesso
    });

    it('should quote a load the motorcycle cannot carry but flag that it does not fit', async () => {
      const orcamento = await inCompany(() => pricing.quote({
        zone_code: ZONE_CODE,
        weight_grams: ModalLoadFactory.justOverCapacity(DeliveryModal.MOTO).weight_grams,
        vehicle_modal: DeliveryModal.MOTO,
      }));

      expect(orcamento.modal_fits).toBe(false);
      expect(orcamento.modal_reason).toMatch(/Motociclo/);
      expect(orcamento.suggested_modal).toBe(DeliveryModal.MOTOTRICICLO);
    });

    it('should reject an unknown modal instead of pricing it as a car', async () => {
      await expect(inCompany(() => pricing.quote({ zone_code: ZONE_CODE, vehicle_modal: 'motoo' })))
        .rejects.toMatchObject({ name: 'PricingValidationError', statusCode: 400 });
    });
  });

  // ── Frota ──────────────────────────────────────────────────────────────────

  describe('frota', () => {
    it('should normalize the vehicle type and default motorcycles to petrol', async () => {
      const criada = await inCompany(() => fleet.createVehicle({
        plate: 'MOT-700-MP', make: 'Haojue', model: 'HJ125', vehicle_type: 'mota',
      }));

      expect(criada.vehicle_type).toBe(DeliveryModal.MOTO);
      expect(criada.fuel_type).toBe('petrol');
    });

    it('should keep a free-text type that is not a modal, instead of refusing it', async () => {
      const criada = await inCompany(() => fleet.createVehicle({
        plate: 'PCK-700-MP', make: 'Toyota', model: 'Hilux', vehicle_type: 'pickup',
      }));

      expect(criada.vehicle_type).toBe('pickup');
    });

    it('should count two and three wheelers in the fleet stats', async () => {
      await inCompany(() => fleet.createVehicle({
        plate: 'TRI-700-MP', make: 'Bajaj', model: 'Maxima', vehicle_type: 'mototriciclo',
      }));

      const stats = await inCompany(() => fleet.getStats());

      expect(stats.two_three_wheelers).toBeGreaterThanOrEqual(2);
      expect(stats.by_modal.map((linha) => linha.modal)).toContain(DeliveryModal.MOTOTRICICLO);
    });
  });
});
