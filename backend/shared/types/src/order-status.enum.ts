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
  // Devolvida ao remetente (spec § 3.37). Estado próprio e não `failed` — isso
  // é uma tentativa — nem `cancelled`, que é uma encomenda que nunca chegou a
  // seguir. Confundi-los tirava a única forma de contar quantas voltaram.
  RETURNED              = 'returned',
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
  // IN_TRANSIT a partir do armazém = transferência entre filiais (spec § 3.36):
  // a encomenda sai de uma unidade para outra da mesma empresa e, durante o
  // percurso, não está em armazém nenhum. Faltava porque o modelo assumia um
  // único armazém; sem esta transição, mover carga entre filiais só era possível
  // fingindo uma expedição para entrega.
  [OrderStatus.AT_WAREHOUSE]:         [OrderStatus.AWAITING_DESTINATION, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.IN_TRANSIT],
  [OrderStatus.AWAITING_DESTINATION]: [OrderStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.OUT_FOR_DELIVERY]:     [OrderStatus.DELIVERED, OrderStatus.FAILED],
  [OrderStatus.DELIVERED]:            [],
  [OrderStatus.FAILED]:               [OrderStatus.IN_TRANSIT, OrderStatus.CANCELLED],
  [OrderStatus.CANCELLED]:            [],
  // A encomenda chega de volta ao remetente — de viagem ou parada no armazém
  // (spec § 3.37). Terminal, como DELIVERED: acabou, mas do outro lado.
  [OrderStatus.RETURNED]:             [],
};

export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
