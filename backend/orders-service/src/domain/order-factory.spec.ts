import { describe, it, expect } from 'vitest';
import { OrderFactory } from '../../../../tests/harness/factories/order.factory';
import { OrderStatus } from '../../../shared/types/src/order-status.enum';

describe('OrderFactory (Harness Validation)', () => {
  it('deve construir um modelo de pedido de teste válido com os valores padrão', () => {
    const order = OrderFactory.build();
    
    expect(order.id).toBeDefined();
    expect(order.tracking_code).toMatch(/^TRK\d{8}BR$/);
    expect(order.current_status).toBe(OrderStatus.CREATED);
    expect(order.origin.country).toBe('BR');
  });

  it('deve aplicar overrides customizados corretamente', () => {
    const customOrder = OrderFactory.build({
      current_status: OrderStatus.DELIVERED,
      tracking_code: 'TRKCUSTOM999'
    });

    expect(customOrder.current_status).toBe(OrderStatus.DELIVERED);
    expect(customOrder.tracking_code).toBe('TRKCUSTOM999');
  });

  it('deve construir listas de pedidos com IDs sequenciais únicos', () => {
    const list = OrderFactory.buildList(3);
    
    expect(list).toHaveLength(3);
    expect(list[0].id).not.toBe(list[1].id);
    expect(list[1].id).not.toBe(list[2].id);
  });
});
