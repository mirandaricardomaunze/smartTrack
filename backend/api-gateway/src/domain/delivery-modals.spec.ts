/**
 * @file delivery-modals.spec.ts
 * @description Testes do catálogo de modais — motociclo e mototriciclo.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.33
 *
 * O módulo é puro, por isso é aqui que as regras se provam sem base de dados:
 * normalização do vocabulário da operação, teto de capacidade que a declaração
 * do cadastro não pode furar, e a carta que cada modal exige. Dados via
 * factories do harness (nada inline).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  DeliveryModal,
  DriverVehicleFactory,
  ModalLoadFactory,
  MODAL_CAPACITY_KG,
  MODAL_SYNONYM_CASES,
} from '../../../../tests/harness';

const require = createRequire(import.meta.url);
const modals = require('./delivery-modals');

describe('catálogo de modais · § 3.33', () => {
  describe('vocabulário', () => {
    it.each(MODAL_SYNONYM_CASES)('reconhece "$input" como $expected', ({ input, expected }) => {
      expect(modals.normalizeModalCode(input)).toBe(expected);
    });

    it('devolve null para o que não é modal, sem inventar um', () => {
      expect(modals.normalizeModalCode('pickup')).toBeNull();
      expect(modals.normalizeModalCode('')).toBeNull();
      expect(modals.normalizeModalCode(undefined)).toBeNull();
    });

    it('expõe motociclo e mototriciclo como veículos de duas/três rodas', () => {
      expect(modals.isTwoOrThreeWheeler(DeliveryModal.MOTO)).toBe(true);
      expect(modals.isTwoOrThreeWheeler(DeliveryModal.MOTOTRICICLO)).toBe(true);
      expect(modals.isTwoOrThreeWheeler(DeliveryModal.CARRO)).toBe(false);
    });
  });

  describe('capacidade', () => {
    it('assume o teto do modal quando o cadastro não declara capacidade', () => {
      const vehicle = DriverVehicleFactory.motociclo();
      expect(modals.capacityKgFor(vehicle.type, vehicle.capacity_kg))
        .toBe(MODAL_CAPACITY_KG[DeliveryModal.MOTO]);
    });

    it('aceita uma capacidade declarada abaixo do teto (baú mais pequeno)', () => {
      const vehicle = DriverVehicleFactory.motociclo({ capacity_kg: 10 });
      expect(modals.capacityKgFor(vehicle.type, vehicle.capacity_kg)).toBe(10);
    });

    it('reduz ao teto do modal uma capacidade declarada acima — o cadastro não contorna o limite', () => {
      const vehicle = DriverVehicleFactory.motociclo({ capacity_kg: 500 });
      expect(modals.capacityKgFor(vehicle.type, vehicle.capacity_kg))
        .toBe(MODAL_CAPACITY_KG[DeliveryModal.MOTO]);
    });

    it('aceita carga exatamente no teto', () => {
      const load = ModalLoadFactory.atCapacity(DeliveryModal.MOTO);
      expect(modals.fitsModal(load, DeliveryModal.MOTO).ok).toBe(true);
    });

    it('recusa um grama acima do teto e sugere o modal seguinte', () => {
      const load = ModalLoadFactory.justOverCapacity(DeliveryModal.MOTO);
      const fit  = modals.fitsModal(load, DeliveryModal.MOTO);

      expect(fit.ok).toBe(false);
      expect(fit.suggested_modal).toBe(DeliveryModal.MOTOTRICICLO);
    });

    it('recusa volume comprido de mais para a moto mesmo com peso admissível', () => {
      const fit = modals.fitsModal(ModalLoadFactory.oversizedForMoto(), DeliveryModal.MOTO);
      expect(fit.ok).toBe(false);
      expect(fit.reason).toMatch(/cm de lado/);
    });

    it('não recusa pedido sem peso registado — não inventa um valor para bloquear', () => {
      expect(modals.fitsModal({}, DeliveryModal.MOTO).ok).toBe(true);
      expect(modals.fitsModal({ weight_grams: 0 }, DeliveryModal.MOTO).ok).toBe(true);
    });

    it('sugere o modal mais pequeno que aguenta a carga', () => {
      expect(modals.smallestModalFor(ModalLoadFactory.fits(DeliveryModal.MOTO))).toBe(DeliveryModal.MOTO);
      expect(modals.smallestModalFor(ModalLoadFactory.justOverCapacity(DeliveryModal.MOTO)))
        .toBe(DeliveryModal.MOTOTRICICLO);
      expect(modals.smallestModalFor(ModalLoadFactory.tooHeavyForTwoWheels()))
        .toBe(DeliveryModal.CARRO);
    });

    it('devolve null quando nem o maior modal serve, em vez de sugerir o maior', () => {
      expect(modals.smallestModalFor({ weight_grams: 99_999_000 })).toBeNull();
    });

    it('assertFitsModal lança com o motivo e a sugestão', () => {
      const load = ModalLoadFactory.justOverCapacity(DeliveryModal.MOTO);
      expect(() => modals.assertFitsModal(load, DeliveryModal.MOTO))
        .toThrow(/Mototriciclo/);
    });
  });

  describe('carta de condução', () => {
    it('exige categoria A para motociclo e mototriciclo', () => {
      expect(modals.getModal(DeliveryModal.MOTO).licence_categories).toContain('A');
      expect(modals.getModal(DeliveryModal.MOTOTRICICLO).licence_categories).toContain('A');
    });

    it('assume a categoria principal quando não é declarada', () => {
      expect(modals.resolveLicenceCategory(DeliveryModal.MOTO)).toBe('A');
    });

    it('aceita categoria B no mototriciclo, que admite as duas', () => {
      expect(modals.resolveLicenceCategory(DeliveryModal.MOTOTRICICLO, 'b')).toBe('B');
    });

    it('recusa carta que não habilita o modal', () => {
      expect(() => modals.resolveLicenceCategory(DeliveryModal.MOTO, 'B'))
        .toThrow(modals.ModalCapacityError);
    });
  });

  it('recusa modal desconhecido em vez de o tratar como carro', () => {
    expect(() => modals.requireModal('pickup')).toThrow(modals.UnknownDeliveryModalError);
  });
});
