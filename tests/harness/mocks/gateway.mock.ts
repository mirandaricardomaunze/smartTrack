/**
 * @file gateway.mock.ts
 * @description Mock de respostas de gateway de pagamento para testes.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md
 *
 * @example
 * import { MockGatewayResponse } from 'tests/harness/mocks/gateway.mock';
 * jest.spyOn(gatewayClient, 'charge').mockResolvedValue(MockGatewayResponse.success());
 */

export interface GatewayChargeResponse {
  transaction_id: string;
  status: 'approved' | 'rejected' | 'pending';
  amount: number;           // em centavos
  gateway_code: string;
  message: string;
  processed_at: string;     // ISO8601 UTC
}

export interface GatewayErrorResponse {
  error_code: string;
  message: string;
  http_status: number;
  retryable: boolean;
}

export const MockGatewayResponse = {
  /** Resposta de cobrança aprovada */
  success(overrides: Partial<GatewayChargeResponse> = {}): GatewayChargeResponse {
    return {
      transaction_id: `gw-tx-test-${Date.now()}`,
      status:        'approved',
      amount:        2990,
      gateway_code:  'APPROVED',
      message:       'Pagamento aprovado',
      processed_at:  new Date().toISOString(),
      ...overrides,
    };
  },

  /** Resposta de cobrança rejeitada (4xx — não fazer retry) */
  rejected(overrides: Partial<GatewayErrorResponse> = {}): GatewayErrorResponse {
    return {
      error_code:  'CARD_DECLINED',
      message:     'Cartão recusado pela operadora',
      http_status: 422,
      retryable:   false,
      ...overrides,
    };
  },

  /** Erro de servidor do gateway (5xx — fazer retry) */
  serverError(overrides: Partial<GatewayErrorResponse> = {}): GatewayErrorResponse {
    return {
      error_code:  'GATEWAY_UNAVAILABLE',
      message:     'Gateway temporariamente indisponível',
      http_status: 503,
      retryable:   true,
      ...overrides,
    };
  },

  /** Timeout de rede (retryable) */
  timeout(): GatewayErrorResponse {
    return {
      error_code:  'NETWORK_TIMEOUT',
      message:     'Timeout na conexão com o gateway',
      http_status: 504,
      retryable:   true,
    };
  },

  /** Webhook de pagamento confirmado (para testes de idempotência) */
  webhookSuccess(transaction_id: string): Record<string, unknown> {
    return {
      event:          'payment.approved',
      transaction_id,
      amount:         2990,
      processed_at:   new Date().toISOString(),
      signature:      'mock-hmac-signature-for-testing',
    };
  },
};
