/**
 * @file delivery-modal.factory.ts
 * @description Test factories para entregas de motociclo e mototriciclo.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.33
 *
 * Alinhado com backend/shared/types/src/delivery-modal.types.ts e com o
 * catálogo em backend/api-gateway/src/domain/delivery-modals.js.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * Os pesos abaixo não são números redondos por acaso: são os limites do
 * catálogo (motociclo 25 kg, mototriciclo 350 kg) e os valores imediatamente
 * de um lado e do outro, que é onde as regras de capacidade partem.
 */
import { DeliveryModal } from '../../../backend/shared/types/src/delivery-modal.types';

/** Capacidades do catálogo, em kg — espelham o domínio. */
export const MODAL_CAPACITY_KG = {
  [DeliveryModal.MOTO]:         25,
  [DeliveryModal.MOTOTRICICLO]: 350,
  [DeliveryModal.CARRO]:        400,
  [DeliveryModal.VAN]:          1500,
  [DeliveryModal.CAMINHAO]:     8000,
} as const;

export interface TestDriverVehicle {
  type: DeliveryModal;
  plate: string;
  capacity_kg?: number;
  licence_category?: string;
}

export interface TestModalLoad {
  weight_grams?: number;
  volume_l?: number;
  longest_side_cm?: number;
}

let _counter = 1;

/** Veículo de motorista por modal — o que o cadastro (§ 3.32) recebe. */
export class DriverVehicleFactory {
  static build(overrides: Partial<TestDriverVehicle> = {}): TestDriverVehicle {
    const n = _counter++;
    return {
      type:  DeliveryModal.MOTO,
      plate: `MOT-${String(n).padStart(3, '0')}-MP`,
      ...overrides,
    };
  }

  /** Motociclista — o modal de última milha mais comum. */
  static motociclo(overrides: Partial<TestDriverVehicle> = {}): TestDriverVehicle {
    return this.build({ type: DeliveryModal.MOTO, licence_category: 'A', ...overrides });
  }

  /** Mototriciclista — triciclo de carga. */
  static mototriciclo(overrides: Partial<TestDriverVehicle> = {}): TestDriverVehicle {
    return this.build({
      type:  DeliveryModal.MOTOTRICICLO,
      plate: `TRI-${String(_counter).padStart(3, '0')}-MP`,
      licence_category: 'A',
      ...overrides,
    });
  }

  static van(overrides: Partial<TestDriverVehicle> = {}): TestDriverVehicle {
    return this.build({ type: DeliveryModal.VAN, plate: `VAN-${String(_counter).padStart(3, '0')}-MP`, ...overrides });
  }
}

/** Cargas construídas em relação ao teto de um modal. */
export class ModalLoadFactory {
  static build(overrides: Partial<TestModalLoad> = {}): TestModalLoad {
    return { weight_grams: 2_500, ...overrides };
  }

  /** Carga que cabe folgadamente no modal. */
  static fits(modal: DeliveryModal = DeliveryModal.MOTO): TestModalLoad {
    return { weight_grams: Math.round(MODAL_CAPACITY_KG[modal] * 1000 * 0.5) };
  }

  /** Carga exatamente no teto — tem de ser aceite. */
  static atCapacity(modal: DeliveryModal = DeliveryModal.MOTO): TestModalLoad {
    return { weight_grams: MODAL_CAPACITY_KG[modal] * 1000 };
  }

  /** Um grama acima do teto — tem de ser recusada. */
  static justOverCapacity(modal: DeliveryModal = DeliveryModal.MOTO): TestModalLoad {
    return { weight_grams: MODAL_CAPACITY_KG[modal] * 1000 + 1 };
  }

  /** Carga que nenhum modal de duas/três rodas leva. */
  static tooHeavyForTwoWheels(): TestModalLoad {
    return { weight_grams: (MODAL_CAPACITY_KG[DeliveryModal.MOTOTRICICLO] + 1) * 1000 };
  }

  /** Volume comprido de mais para a moto, dentro do peso. */
  static oversizedForMoto(): TestModalLoad {
    return { weight_grams: 3_000, longest_side_cm: 120 };
  }
}

/** Sinónimos que a operação escreve e o catálogo tem de reconhecer. */
export const MODAL_SYNONYM_CASES: ReadonlyArray<{ input: string; expected: DeliveryModal }> = [
  { input: 'mota',           expected: DeliveryModal.MOTO },
  { input: 'Motocicleta',    expected: DeliveryModal.MOTO },
  { input: ' moto ',         expected: DeliveryModal.MOTO },
  { input: 'mototriciclo',   expected: DeliveryModal.MOTOTRICICLO },
  { input: 'Moto-Triciclo',  expected: DeliveryModal.MOTOTRICICLO },
  { input: 'triciclo',       expected: DeliveryModal.MOTOTRICICLO },
  { input: 'txopela',        expected: DeliveryModal.MOTOTRICICLO },
  { input: 'camião',         expected: DeliveryModal.CAMINHAO },
];

export { DeliveryModal };
