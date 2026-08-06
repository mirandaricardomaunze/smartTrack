/**
 * @file payments.service.spec.js
 * @description Testes do fluxo de cobrança e do handler de webhook.
 *
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md § Required Tests
 *
 * O repositório é substituído por um fake em memória — os testes exercitam a
 * lógica de idempotência e retentativa sem precisar de PostgreSQL. O gateway
 * simulado já é determinístico por construção (o desfecho depende dos dois
 * últimos dígitos do valor), por isso não precisa de mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Fake do repositório ──────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const store = new Map();

/** Contador de chamadas ao gateway, para verificar retentativas. */
const gatewayCalls = [];

const fakeRepo = {
  async findAll() {
    return [...store.values()];
  },
  async findById(id) {
    return store.get(id);
  },
  async findByOrder(orderId) {
    return [...store.values()].filter((p) => p.order_id === orderId);
  },
  async findByIdempotencyKey(key) {
    return [...store.values()].find((p) => p.idempotency_key === key);
  },
  async findByGatewayTxId(txId) {
    return [...store.values()].find((p) => p.gateway_transaction_id === txId);
  },
  async findLatestByOrder(orderId) {
    const lista = [...store.values()]
      .filter((p) => p.order_id === orderId)
      .sort((a, b) => b.attempt_number - a.attempt_number);
    return lista[0];
  },
  async create(payment) {
    store.set(payment.id, { ...payment });
    return { ...payment };
  },
  async update(payment) {
    if (!store.has(payment.id)) return undefined;
    store.set(payment.id, { ...payment });
    return { ...payment };
  },
  async getStats() {
    return {};
  },
  async findSucceededSince() {
    return [...store.values()].filter((p) => p.status === 'succeeded');
  },
};

import gatewayClient from '../infrastructure/gateway.client.js';
import service from './payments.service.js';

const { SimulatedGateway } = gatewayClient;

const {
  chargeOrder,
  handleWebhook,
  verifyWebhookSignature,
  reconcile,
  configurePorts,
  resetPorts,
  InvalidWebhookSignatureError,
  InvalidAmountError,
  MissingRequiredFieldError,
} = service;

/** Gateway simulado, envolvido para contar chamadas sem alterar o comportamento. */
const spyGateway = {
  ...SimulatedGateway,
  async charge(req) {
    gatewayCalls.push(req);
    return SimulatedGateway.charge(req);
  },
};

beforeEach(() => {
  store.clear();
  gatewayCalls.length = 0;
  process.env.PAYMENTS_WEBHOOK_SECRET = 'segredo-de-teste';

  resetPorts();
  configurePorts({
    repo:       fakeRepo,
    getGateway: () => spyGateway,
    // Não dormir de verdade — os atrasos reais são de 2s a 30s.
    sleep:      async () => {},
  });
});

// ─── Cobrança ─────────────────────────────────────────────────────────────────

describe('chargeOrder — caminho feliz', () => {
  it('should succeed and store the gateway transaction id', async () => {
    const p = await chargeOrder({ order_id: 'ord_ok', value: 2990 });

    expect(p.status).toBe('succeeded');
    expect(p.gateway_transaction_id).toBeTruthy();
    expect(p.attempt_number).toBe(1);
  });

  it('should always send an idempotency key to the gateway', () => {
    // Regra 1 da skill — verificada em cada chamada registada
    return chargeOrder({ order_id: 'ord_ok2', value: 2990 }).then(() => {
      expect(gatewayCalls.length).toBeGreaterThan(0);
      for (const call of gatewayCalls) {
        expect(call.idempotencyKey).toBe('ord_ok2:charge:1');
      }
    });
  });

  it('should reject a float amount before touching the gateway', async () => {
    await expect(chargeOrder({ order_id: 'ord_x', value: 29.9 }))
      .rejects.toThrow(InvalidAmountError);

    expect(gatewayCalls).toHaveLength(0);
  });

  it('should require an order_id', async () => {
    await expect(chargeOrder({ value: 2990 }))
      .rejects.toThrow(MissingRequiredFieldError);
  });
});

describe('chargeOrder — idempotência', () => {
  // Exigido pela skill: "should not create duplicate charge when webhook received twice"
  // (versão para a cobrança: repetir o pedido não cobra outra vez)
  it('should not charge twice for the same order', async () => {
    const primeira = await chargeOrder({ order_id: 'ord_dup', value: 2990 });
    const chamadasApos1 = gatewayCalls.length;

    const segunda = await chargeOrder({ order_id: 'ord_dup', value: 2990 });

    expect(segunda.id).toBe(primeira.id);
    expect(segunda.gateway_transaction_id).toBe(primeira.gateway_transaction_id);
    // O gateway não foi chamado de novo
    expect(gatewayCalls.length).toBe(chamadasApos1);
    expect(store.size).toBe(1);
  });

  it('should return the same transaction id for the same idempotency key', async () => {
    const a = await chargeOrder({ order_id: 'ord_same', value: 2990 });
    store.clear(); // força nova cobrança com a mesma chave
    const b = await chargeOrder({ order_id: 'ord_same', value: 2990 });

    // O gateway simulado deriva o tx da chave — mesma chave, mesmo tx
    expect(b.gateway_transaction_id).toBe(a.gateway_transaction_id);
  });
});

describe('chargeOrder — falhas definitivas', () => {
  // Exigido pela skill: "should not retry on 422 Unprocessable Entity from gateway"
  it('should not retry on 422', async () => {
    // valor terminado em 22 → o simulado devolve 422
    const p = await chargeOrder({ order_id: 'ord_422', value: 2922 });

    expect(p.status).toBe('failed');
    expect(p.attempt_number).toBe(1);
    expect(gatewayCalls).toHaveLength(1);
  });

  it('should not retry on 402', async () => {
    const p = await chargeOrder({ order_id: 'ord_402', value: 2902 });

    expect(p.status).toBe('failed');
    expect(gatewayCalls).toHaveLength(1);
    expect(p.failure_reason).toMatch(/Fundos insuficientes/);
  });
});

describe('chargeOrder — retentativas', () => {
  // Exigido pela skill: "should retry up to 3 times on 503 from gateway"
  it('should retry up to the max attempts on 503', async () => {
    // valor terminado em 03 → o simulado devolve sempre 503
    const p = await chargeOrder({ order_id: 'ord_503', value: 2903 });

    expect(p.status).toBe('failed');
    expect(p.attempt_number).toBe(3);
    expect(gatewayCalls).toHaveLength(3);
  });

  it('should use a distinct idempotency key per attempt', async () => {
    await chargeOrder({ order_id: 'ord_keys', value: 2903 });

    const chaves = gatewayCalls.map((c) => c.idempotencyKey);
    expect(chaves).toEqual([
      'ord_keys:charge:1',
      'ord_keys:charge:2',
      'ord_keys:charge:3',
    ]);
  });

  it('should retry on a network error (null http code)', async () => {
    // valor terminado em 99 → o simulado devolve erro de rede
    const p = await chargeOrder({ order_id: 'ord_net', value: 2999 });

    expect(p.status).toBe('failed');
    expect(gatewayCalls).toHaveLength(3);
  });

  // Exigido pela skill: "should emit PaymentFailedEvent after maxAttempts exceeded"
  it('should emit PAYMENT_FAILED after exhausting the attempts', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    await chargeOrder({ order_id: 'ord_evt', value: 2903 });
    spy.mockRestore();

    const evento = logs.find((l) => l.includes('PAYMENT_FAILED'));
    expect(evento).toBeTruthy();

    const envelope = JSON.parse(evento.replace('[event] ', ''));
    // Regra 5 da skill: o evento carrega os campos financeiros
    expect(envelope.payload.orderId).toBe('ord_evt');
    expect(envelope.payload.value).toBe(2903);
    expect(envelope.payload.gateway).toBeTruthy();
    // Regra 3 do backend/README: envelope sempre com estes três
    expect(envelope.correlationId).toBeTruthy();
    expect(envelope.timestamp).toBeTruthy();
    expect(envelope.schemaVersion).toBe('1.0');
  });

  it('should emit PAYMENT_SUCCEEDED on approval', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    await chargeOrder({ order_id: 'ord_ok_evt', value: 2990 });
    spy.mockRestore();

    expect(logs.some((l) => l.includes('PAYMENT_SUCCEEDED'))).toBe(true);
  });
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  it('should reject when no secret is configured', () => {
    delete process.env.PAYMENTS_WEBHOOK_SECRET;
    // Falha fechada: sem segredo, nada passa
    expect(verifyWebhookSignature('qualquer')).toBe(false);
  });

  it('should reject a missing or wrong signature', () => {
    expect(verifyWebhookSignature(undefined)).toBe(false);
    expect(verifyWebhookSignature('errada')).toBe(false);
  });

  it('should accept the configured secret', () => {
    expect(verifyWebhookSignature('segredo-de-teste')).toBe(true);
  });
});

describe('handleWebhook', () => {
  it('should refuse an unsigned webhook before doing anything', async () => {
    await expect(handleWebhook({ transaction_id: 'tx', status: 'succeeded' }, undefined))
      .rejects.toThrow(InvalidWebhookSignatureError);
  });

  // Exigido pela skill: "should not create duplicate charge when webhook received twice"
  it('should be idempotent when the same webhook arrives twice', async () => {
    const pago = await chargeOrder({ order_id: 'ord_wh', value: 2990 });
    const tx   = pago.gateway_transaction_id;

    const primeira = await handleWebhook(
      { transaction_id: tx, status: 'succeeded' }, 'segredo-de-teste',
    );
    const segunda = await handleWebhook(
      { transaction_id: tx, status: 'succeeded' }, 'segredo-de-teste',
    );

    // Já estava SUCCEEDED pela cobrança — ambas são no-op
    expect(primeira.processed).toBe(false);
    expect(segunda.processed).toBe(false);
    expect(segunda.reason).toBe('já processado');
    expect(store.size).toBe(1);
  });

  it('should acknowledge an unknown transaction without failing', async () => {
    const r = await handleWebhook(
      { transaction_id: 'tx-desconhecida', status: 'succeeded' }, 'segredo-de-teste',
    );

    expect(r.processed).toBe(false);
    expect(r.reason).toBe('transação desconhecida');
    expect(r.payment).toBeNull();
  });

  it('should apply a refund notification', async () => {
    const pago = await chargeOrder({ order_id: 'ord_ref', value: 2990 });

    const r = await handleWebhook(
      { transaction_id: pago.gateway_transaction_id, status: 'refunded' }, 'segredo-de-teste',
    );

    expect(r.processed).toBe(true);
    expect(r.payment.status).toBe('refunded');
  });

  it('should ignore an out-of-order notification instead of throwing', async () => {
    const pago = await chargeOrder({ order_id: 'ord_ooo', value: 2990 });

    // succeeded → failed não é transição válida
    const r = await handleWebhook(
      { transaction_id: pago.gateway_transaction_id, status: 'failed' }, 'segredo-de-teste',
    );

    expect(r.processed).toBe(false);
    expect(r.reason).toBe('transição inválida');
    expect(r.payment.status).toBe('succeeded');
  });

  it('should reject an unknown status', async () => {
    const pago = await chargeOrder({ order_id: 'ord_bad', value: 2990 });

    await expect(handleWebhook(
      { transaction_id: pago.gateway_transaction_id, status: 'talvez' }, 'segredo-de-teste',
    )).rejects.toThrow(MissingRequiredFieldError);
  });
});

// ─── Conciliação ──────────────────────────────────────────────────────────────

describe('reconcile', () => {
  it('should report succeeded payments and the total in cents', async () => {
    await chargeOrder({ order_id: 'ord_r1', value: 2990 });
    await chargeOrder({ order_id: 'ord_r2', value: 1500 });

    const rel = await reconcile();

    expect(rel.checked).toBe(2);
    expect(rel.total_cents).toBe(4490);
    expect(rel.missing_transaction).toEqual([]);
  });

  it('should flag a succeeded payment without a transaction id', async () => {
    const pago = await chargeOrder({ order_id: 'ord_r3', value: 2990 });
    // Corrompe deliberadamente para exercitar a deteção
    store.set(pago.id, { ...pago, gateway_transaction_id: null });

    const rel = await reconcile();

    expect(rel.missing_transaction).toEqual([pago.id]);
  });

  it('should be explicit that the gateway cross-check is unavailable', async () => {
    const rel = await reconcile();
    expect(rel.gateway_cross_check).toMatch(/indisponível/);
  });
});

