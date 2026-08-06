/**
 * @file payments.service.js
 * @description Casos de uso do payments-service.
 *
 * Single Responsibility: lógica de negócio — não conhece HTTP nem SQL.
 * Skill ref: .agents/skills/payment-idempotency/SKILL.md § Charge Flow
 *
 * GARANTIA CENTRAL: nenhum cliente é cobrado duas vezes pela mesma entrega,
 * mesmo com falhas de rede, retentativas ou pedidos concorrentes. Isso assenta
 * em três camadas:
 *   1. `idempotency_key` enviada ao gateway em toda tentativa (regra 1).
 *   2. Índice UNIQUE sobre `idempotency_key` no banco — dois processos em
 *      corrida não conseguem inserir a mesma tentativa.
 *   3. Verificação de pagamento já liquidado antes de iniciar nova cobrança.
 */
'use strict';

const { PaymentRepository } = require('../infrastructure/pg.repository');
const { getGatewayClient }  = require('../infrastructure/gateway.client');
const {
  publishPaymentSucceeded,
  publishPaymentFailed,
  publishPaymentRefunded,
} = require('../infrastructure/event.publisher');

const {
  classifyResponse,
  delayForAttempt,
  hasAttemptsLeft,
  PAYMENT_RETRY,
} = require('../domain/retry-policy');

const {
  PaymentStatus,
  PaymentGateway,
  PaymentNotFoundError,
  MissingRequiredFieldError,
  InvalidAmountError,
  InvalidPaymentTransitionError,
  MaxAttemptsExceededError,
  isValidPaymentTransition,
  createPaymentEntity,
  applyPaymentTransition,
  prepareRetry,
  isSettled,
  validateAmount,
} = require('../domain/payment.entity');

/** Erro de assinatura de webhook — nunca processar payload não verificado. */
class InvalidWebhookSignatureError extends Error {
  constructor() {
    super('Assinatura do webhook inválida.');
    this.name = 'InvalidWebhookSignatureError';
    this.statusCode = 401;
  }
}

/**
 * @returns {string}
 */
function generatePaymentId() {
  const stamp  = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `payment-${stamp}-${random}`;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Costura de dependências ──────────────────────────────────────────────────

/**
 * Portas do serviço. Os defaults são a infraestrutura real; os testes trocam-nas
 * por duplos via `configurePorts` (repositório em memória, relógio que não dorme).
 *
 * Existe porque este módulo é CommonJS e é carregado com `require` — o mock de
 * módulos do Vitest não intercepta isso. Uma costura explícita é mais honesta do
 * que depender do carregador de módulos, e deixa a dependência visível no código.
 */
const DEFAULT_PORTS = Object.freeze({
  repo:       PaymentRepository,
  getGateway: getGatewayClient,
  sleep:      defaultSleep,
  events: Object.freeze({
    succeeded: publishPaymentSucceeded,
    failed:    publishPaymentFailed,
    refunded:  publishPaymentRefunded,
  }),
});

let ports = { ...DEFAULT_PORTS };

/**
 * Substitui portas. Aceita substituição parcial.
 * @param {object} overrides
 */
function configurePorts(overrides) {
  ports = { ...ports, ...overrides };
}

/** Repõe a infraestrutura real. */
function resetPorts() {
  ports = { ...DEFAULT_PORTS };
}

// ─── Consultas ────────────────────────────────────────────────────────────────

/**
 * @param {{ order_id?: string }} [filtros]
 * @returns {Promise<object[]>}
 */
async function listPayments(filtros = {}) {
  return filtros.order_id
    ? ports.repo.findByOrder(filtros.order_id)
    : ports.repo.findAll();
}

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getPayment(id) {
  const pagamento = await ports.repo.findById(id);
  if (!pagamento) throw new PaymentNotFoundError(id);
  return pagamento;
}

/** @returns {Promise<object>} */
async function getStats() {
  return ports.repo.getStats();
}

// ─── Cobrança ─────────────────────────────────────────────────────────────────

/**
 * Cobra um pedido, com retentativa conforme a política da skill.
 *
 * Fluxo (skill § Charge Flow):
 *   1. Se já existe pagamento liquidado para o pedido → devolve-o (idempotente).
 *   2. Cria/recupera o registo e transita para PROCESSING.
 *   3. Chama o gateway com a idempotency_key.
 *      a. 2xx        → SUCCEEDED, guarda transaction_id, emite PaymentSucceeded.
 *      b. 4xx        → FAILED definitivo, NÃO retenta.
 *      c. 5xx/rede   → nova tentativa com backoff, até maxAttempts.
 *   4. Esgotadas as tentativas → FAILED e emite PaymentFailed.
 *
 * @param {{ order_id: string, value: number, gateway?: string }} dto
 * @returns {Promise<object>} Pagamento no estado final
 */
async function chargeOrder(dto) {
  if (!dto || !dto.order_id) throw new MissingRequiredFieldError('order_id');
  validateAmount(dto.value);

  // ── 1. Idempotência ao nível do pedido ──────────────────────────────────────
  // Um pedido já pago não é recobrado, aconteça o que acontecer a montante.
  const existente = await ports.repo.findLatestByOrder(dto.order_id);
  if (existente && isSettled(existente)) {
    console.info(
      `[audit] Cobrança ignorada para ${dto.order_id}: já está em ${existente.status}.`,
    );
    return existente;
  }

  // Retoma a tentativa anterior se ela ficou por resolver; senão começa do zero.
  let pagamento = existente
    ? existente
    : await ports.repo.create(
        createPaymentEntity(generatePaymentId(), {
          order_id: dto.order_id,
          value:    dto.value,
          gateway:  dto.gateway ?? PaymentGateway.MERCADO_PAGO,
        }),
      );

  const client = ports.getGateway(pagamento.gateway);

  // ── 2. Ciclo de tentativas ──────────────────────────────────────────────────
  for (;;) {
    const espera = delayForAttempt(pagamento.attempt_number);
    if (espera > 0) await ports.sleep(espera);

    // PENDING/FAILED → PROCESSING antes de tocar no gateway.
    if (pagamento.status !== PaymentStatus.PROCESSING) {
      pagamento = await ports.repo.update(
        applyPaymentTransition(pagamento, PaymentStatus.PROCESSING),
      );
    }

    const resposta = await client.charge({
      idempotencyKey: pagamento.idempotency_key, // regra 1 — sempre presente
      orderId:        pagamento.order_id,
      value:          pagamento.value,
      gateway:        pagamento.gateway,
    });

    const desfecho = classifyResponse(resposta.httpCode);

    // ── 3a. Sucesso ───────────────────────────────────────────────────────────
    if (desfecho === 'success') {
      pagamento = await ports.repo.update(
        applyPaymentTransition(pagamento, PaymentStatus.SUCCEEDED, {
          gateway_transaction_id: resposta.transactionId,
        }),
      );

      console.info(
        `[audit] Pagamento ${pagamento.id} aprovado para ${pagamento.order_id} ` +
        `(tentativa ${pagamento.attempt_number}, tx ${resposta.transactionId}).`,
      );
      ports.events.succeeded(pagamento);
      return pagamento;
    }

    // ── 3b. Falha definitiva — regra 2: nunca retentar em 4xx ─────────────────
    if (desfecho === 'definitive_failure') {
      pagamento = await ports.repo.update(
        applyPaymentTransition(pagamento, PaymentStatus.FAILED, {
          failure_reason: resposta.message,
        }),
      );

      console.warn(
        `[audit] Pagamento ${pagamento.id} recusado definitivamente ` +
        `(HTTP ${resposta.httpCode}): ${resposta.message}`,
      );
      ports.events.failed(pagamento, resposta.message);
      return pagamento;
    }

    // ── 3c. Retentável ────────────────────────────────────────────────────────
    if (!hasAttemptsLeft(pagamento.attempt_number)) {
      pagamento = await ports.repo.update(
        applyPaymentTransition(pagamento, PaymentStatus.FAILED, {
          failure_reason: `Esgotadas ${PAYMENT_RETRY.maxAttempts} tentativas: ${resposta.message}`,
        }),
      );

      console.error(
        `[alert] Pagamento ${pagamento.id} falhou após ${PAYMENT_RETRY.maxAttempts} ` +
        `tentativas — requer intervenção de operações.`,
      );
      ports.events.failed(pagamento, pagamento.failure_reason);
      return pagamento;
    }

    // Falha desta tentativa: incrementa e gera NOVA chave de idempotência.
    pagamento = await ports.repo.update(
      prepareRetry(
        applyPaymentTransition(pagamento, PaymentStatus.FAILED, {
          failure_reason: resposta.message,
        }),
      ),
    );

    console.warn(
      `[audit] Pagamento ${pagamento.id}: tentativa ${pagamento.attempt_number - 1} ` +
      `falhou (${resposta.message}); nova chave ${pagamento.idempotency_key}.`,
    );
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Valida a assinatura do webhook (skill § regra 4).
 *
 * ⚠️  Comparação simples contra PAYMENTS_WEBHOOK_SECRET. Um gateway real assina
 * o corpo com HMAC e envia o digest num header — ao ligar o gateway, substituir
 * por `crypto.timingSafeEqual` sobre o HMAC do payload cru.
 *
 * @param {string|undefined} signature
 * @returns {boolean}
 */
function verifyWebhookSignature(signature) {
  const esperado = process.env.PAYMENTS_WEBHOOK_SECRET;

  // Sem segredo configurado, recusamos tudo — falhar fechado, nunca aberto.
  if (!esperado) return false;
  if (!signature) return false;

  return signature === esperado;
}

/**
 * Processa uma notificação do gateway.
 *
 * CRÍTICO (skill § Webhook Handler Rules): webhooks podem ser entregues várias
 * vezes. Este handler é idempotente — reprocessar a mesma notificação não muda
 * nada nem emite eventos duplicados.
 *
 * @param {{ transaction_id: string, status: string, order_id?: string }} dto
 * @param {string|undefined} signature
 * @returns {Promise<{ processed: boolean, payment: object|null, reason?: string }>}
 */
async function handleWebhook(dto, signature) {
  if (!verifyWebhookSignature(signature)) throw new InvalidWebhookSignatureError();
  if (!dto || !dto.transaction_id) throw new MissingRequiredFieldError('transaction_id');
  if (!dto.status) throw new MissingRequiredFieldError('status');

  const pagamento = await ports.repo.findByGatewayTxId(dto.transaction_id);

  // Transação desconhecida: aceitamos (200) para o gateway parar de reenviar,
  // mas sinalizamos para investigação — pode ser cobrança fora do sistema.
  if (!pagamento) {
    console.warn(`[alert] Webhook para transação desconhecida: ${dto.transaction_id}`);
    return { processed: false, payment: null, reason: 'transação desconhecida' };
  }

  // Já liquidado: reentrega do mesmo webhook. Reconhecer e sair.
  if (pagamento.status === PaymentStatus.SUCCEEDED && dto.status === 'succeeded') {
    return { processed: false, payment: pagamento, reason: 'já processado' };
  }

  const alvo = dto.status === 'succeeded' ? PaymentStatus.SUCCEEDED
             : dto.status === 'refunded'  ? PaymentStatus.REFUNDED
             : dto.status === 'failed'    ? PaymentStatus.FAILED
             : null;

  if (!alvo) {
    throw new MissingRequiredFieldError(`status (recebido: ${dto.status})`);
  }

  // Transição inválida (ex.: succeeded → failed) não é erro do gateway; é uma
  // notificação fora de ordem. Registamos e ignoramos em vez de rebentar.
  if (!isValidPaymentTransition(pagamento.status, alvo)) {
    console.warn(
      `[audit] Webhook ignorado: transição ${pagamento.status} → ${alvo} não é válida ` +
      `(tx ${dto.transaction_id}).`,
    );
    return { processed: false, payment: pagamento, reason: 'transição inválida' };
  }

  const atualizado = await ports.repo.update(
    applyPaymentTransition(pagamento, alvo, {
      gateway_transaction_id: dto.transaction_id,
    }),
  );

  if (alvo === PaymentStatus.SUCCEEDED) ports.events.succeeded(atualizado);
  if (alvo === PaymentStatus.REFUNDED)  ports.events.refunded(atualizado);
  if (alvo === PaymentStatus.FAILED)    ports.events.failed(atualizado, 'Notificado pelo gateway');

  console.info(`[audit] Webhook aplicado: ${pagamento.status} → ${alvo} (${atualizado.id}).`);
  return { processed: true, payment: atualizado };
}

// ─── Estorno ──────────────────────────────────────────────────────────────────

/**
 * @param {string} id
 * @returns {Promise<object>}
 */
async function refundPayment(id) {
  const pagamento = await ports.repo.findById(id);
  if (!pagamento) throw new PaymentNotFoundError(id);

  const client = ports.getGateway(pagamento.gateway);

  const resposta = await client.refund({
    idempotencyKey: `${pagamento.order_id}:refund:${pagamento.attempt_number}`,
    transactionId:  pagamento.gateway_transaction_id,
  });

  if (classifyResponse(resposta.httpCode) !== 'success') {
    throw new InvalidPaymentTransitionError(pagamento.status, PaymentStatus.REFUNDED);
  }

  const atualizado = await ports.repo.update(
    applyPaymentTransition(pagamento, PaymentStatus.REFUNDED),
  );

  console.info(`[audit] Pagamento ${id} estornado.`);
  ports.events.refunded(atualizado);
  return atualizado;
}

// ─── Conciliação ──────────────────────────────────────────────────────────────

/**
 * Conciliação diária (skill § regra 6).
 *
 * ⚠️  INCOMPLETA POR DESENHO: cruzar contra os registos do gateway exige a API
 * real. Enquanto o gateway é simulado, esta função só verifica a consistência
 * interna — pagamentos SUCCEEDED sem `gateway_transaction_id`, que nunca deviam
 * existir. É o que dá para verificar com verdade hoje.
 *
 * @param {string} [sinceIso] Default: últimas 24h
 * @returns {Promise<object>} Relatório
 */
async function reconcile(sinceIso) {
  const desde = sinceIso ?? new Date(Date.now() - 86_400_000).toISOString();
  const pagos = await ports.repo.findSucceededSince(desde);

  const semTransacao = pagos.filter((p) => !p.gateway_transaction_id);
  const totalCents   = pagos.reduce((sum, p) => sum + p.value, 0);

  if (semTransacao.length > 0) {
    console.error(
      `[alert] Conciliação: ${semTransacao.length} pagamento(s) aprovados sem ` +
      `gateway_transaction_id — inconsistência grave.`,
    );
  }

  return {
    since:               desde,
    checked:             pagos.length,
    total_cents:         totalCents,
    missing_transaction: semTransacao.map((p) => p.id),
    gateway_cross_check: 'indisponível — nenhum gateway real configurado',
  };
}

module.exports = {
  listPayments,
  getPayment,
  getStats,
  chargeOrder,
  handleWebhook,
  verifyWebhookSignature,
  refundPayment,
  reconcile,
  generatePaymentId,
  configurePorts,
  resetPorts,
  DEFAULT_PORTS,
  InvalidWebhookSignatureError,
  PaymentNotFoundError,
  MissingRequiredFieldError,
  InvalidAmountError,
  InvalidPaymentTransitionError,
  MaxAttemptsExceededError,
};
