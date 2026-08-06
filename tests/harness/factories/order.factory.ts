/**
 * @file order.factory.ts
 * @description Test factory para criação de pedidos de teste (em Inglês).
 */
import { OrderStatus } from '../../../backend/shared/types/src/order-status.enum';

export interface TestOrder {
  id: string;
  client_id: string;
  tracking_code: string;
  current_status: OrderStatus;
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  carrier_intl_id?: string;
  driver_id?: string;
  route_id?: string;
  cod_amount?: number;
  cod_status?: string;
  client_phone?: string;
  client_email?: string;
  created_at: string;
  updated_at: string;
}

export interface TestOrderStatusUpdate {
  new_status: OrderStatus;
  location?: string;
  notes?: string;
}

let _counter = 1;

export class OrderFactory {
  static build(overrides: Partial<TestOrder> = {}): TestOrder {
    const n = _counter++;
    return {
      id:                `order-test-uuid-${n.toString().padStart(4, '0')}`,
      client_id:        `client-uuid-${n}`,
      tracking_code:   `TRK${String(n).padStart(8, '0')}BR`,
      current_status:      OrderStatus.CREATED,
      origin:            { city: 'São Paulo', state: 'SP', country: 'BR' },
      destination:           { city: 'Rio de Janeiro', state: 'RJ', country: 'BR' },
      driver_id:      undefined,
      route_id:           undefined,
      created_at:         new Date().toISOString(),
      updated_at:         new Date().toISOString(),
      ...overrides,
    };
  }

  static buildList(count: number, overrides: Partial<TestOrder> = {}): TestOrder[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  static buildInternational(overrides: Partial<TestOrder> = {}): TestOrder {
    return this.build({
      carrier_intl_id: '17TRACK',
      tracking_code: `LX${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}CN`,
      origin: { city: 'Shenzhen', state: 'GD', country: 'CN' },
      ...overrides,
    });
  }

  static buildAtWarehouse(): TestOrder {
    return this.build({ current_status: OrderStatus.AT_WAREHOUSE });
  }

  static buildOutForDelivery(overrides: Partial<TestOrder> = {}): TestOrder {
    return this.build({ current_status: OrderStatus.OUT_FOR_DELIVERY, ...overrides });
  }

  /** Pedido com valor a cobrar na entrega (COD), em centavos. */
  static buildWithCod(codAmountCents = 5000, overrides: Partial<TestOrder> = {}): TestOrder {
    return this.build({ cod_amount: codAmountCents, cod_status: 'pending', ...overrides });
  }

  /** Pedido com contactos do cliente (telefone + email) para SMS/email. */
  static buildWithContact(overrides: Partial<TestOrder> = {}): TestOrder {
    const n = _counter;
    return this.build({ client_phone: `+2588400000${String(n).padStart(2, '0')}`, client_email: `cliente${n}@exemplo.mz`, ...overrides });
  }

  static buildDelivered(): TestOrder {
    return this.build({ current_status: OrderStatus.DELIVERED });
  }

  /** DTO que tenta contornar o fluxo oficial de entrada no armazém. */
  static buildWarehouseStatusUpdate(overrides: Partial<TestOrderStatusUpdate> = {}): TestOrderStatusUpdate {
    return {
      new_status: OrderStatus.AT_WAREHOUSE,
      location: 'Armazém Teste',
      notes: 'Receção de teste',
      ...overrides,
    };
  }
}
