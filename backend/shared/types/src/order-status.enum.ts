/**
 * @file order-status.enum.ts
 * @description Vocabulário canônico de status de pedido do SmartTrack.
 *
 * REGRA PARA AGENTES:
 * - Nunca usar strings literais de status no código de domínio.
 * - Status externos (transportadoras internacionais) SEMPRE mapeados via StatusMapper
 *   antes de persistir um EventoRastreio.
 * - Adicionar novos status aqui requer aprovação do tech lead + atualização do
 *   OpenAPI em docs/openapi/ + atualização do StatusMapper.
 */
export enum OrderStatus {
  CREATED               = 'created',
  COLLECTED             = 'collected',
  IN_TRANSIT            = 'in_transit',
  AT_WAREHOUSE          = 'at_warehouse',
  AWAITING_DESTINATION  = 'awaiting_destination', // cliente deve confirmar destino
  OUT_FOR_DELIVERY      = 'out_for_delivery',
  DELIVERED             = 'delivered',
  FAILED                = 'failed',
  CANCELLED             = 'cancelled',
}

/**
 * Transições válidas entre status.
 * Um agente/serviço NÃO deve fazer transição fora deste mapa.
 */
export const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.CREATED]:              [OrderStatus.COLLECTED, OrderStatus.CANCELLED],
  [OrderStatus.COLLECTED]:            [OrderStatus.IN_TRANSIT, OrderStatus.FAILED],
  [OrderStatus.IN_TRANSIT]:           [OrderStatus.AT_WAREHOUSE, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.FAILED],
  // DELIVERED a partir do armazém = levantamento ao balcão (spec § 3.23).
  [OrderStatus.AT_WAREHOUSE]:         [OrderStatus.AWAITING_DESTINATION, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED],
  [OrderStatus.AWAITING_DESTINATION]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.OUT_FOR_DELIVERY]:     [OrderStatus.DELIVERED, OrderStatus.FAILED],
  [OrderStatus.DELIVERED]:            [],
  [OrderStatus.FAILED]:               [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
  [OrderStatus.CANCELLED]:            [],
};

export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
