/**
 * @file orders.service.js
 * @description Camada de aplicação — use cases de Pedidos (em Inglês).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1, § 8.1
 */
'use strict';

const crypto = require('crypto');
const { OrderRepository, DriverRepository } = require('../infrastructure/pg.repository');
const { OrderStatus, isValidTransition } = require('./order-status-shim');
const { maskPII } = require('../infrastructure/privacy.utils');
const { assertQuota, consumeQuota } = require('./subscriptions.service');

const {
  createRoute,
  previewOptimization,
} = require('../../../routes-service/src/application/routes.service');
const { sendClientMessage } = require('../../../notifications-service/src/application/messaging.service');

/**
 * Calcula o hash SHA-256 de um evento de rastreio encadeado (Cadeia de Confiança).
 *
 * @param {string} status
 * @param {string} description
 * @param {string} location
 * @param {string} timestamp
 * @param {string} parentHash
 * @returns {string} Hash SHA-256
 */
function calculateEventHash(status, description, location, timestamp, parentHash) {
  const content = `${status}|${description}|${location}|${timestamp}|${parentHash}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ─── Erros de Aplicação ──────────────────────────────────────────────────────

class OrderNotFoundError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`Order not found: ${code}`);
    this.name = 'OrderNotFoundError';
    this.statusCode = 404;
  }
}

class InvalidStatusTransitionError extends Error {
  /**
   * @param {string} from
   * @param {string} to
   */
  constructor(from, to) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
    this.statusCode = 422;
  }
}

class InvalidTrackingCodeError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`Invalid tracking code: "${code}"`);
    this.name = 'InvalidTrackingCodeError';
    this.statusCode = 400;
  }
}

class MissingRequiredFieldError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Missing required field: ${field}`);
    this.name = 'MissingRequiredFieldError';
    this.statusCode = 400;
  }
}

class WarehouseActionError extends Error {
  /** @param {string} currentStatus */
  constructor(currentStatus) {
    super(`Ação de armazém indisponível: o pedido está em "${currentStatus}", não no armazém.`);
    this.name = 'WarehouseActionError';
    this.statusCode = 409;
  }
}

class WarehouseIntakeRequiredError extends Error {
  constructor() {
    super('Para receber uma encomenda, selecione um armazém cadastrado e use a operação de receção.');
    this.name = 'WarehouseIntakeRequiredError';
    this.statusCode = 409;
  }
}

class DeliveryStateError extends Error {
  /** @param {string} currentStatus */
  constructor(currentStatus) {
    super(`Entrega indisponível: o pedido está em "${currentStatus}", não em "saiu para entrega".`);
    this.name = 'DeliveryStateError';
    this.statusCode = 409;
  }
}

class PodTooLargeError extends Error {
  /** @param {string} field */
  constructor(field) {
    super(`Ficheiro do comprovativo demasiado grande: ${field} excede o limite permitido.`);
    this.name = 'PodTooLargeError';
    this.statusCode = 413;
  }
}

class InvalidDeliveryFailureReasonError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`Motivo de insucesso inválido: "${reason}".`);
    this.name = 'InvalidDeliveryFailureReasonError';
    this.statusCode = 400;
  }
}

class NoContactForOtpError extends Error {
  constructor() {
    super('Sem telefone do cliente: não é possível enviar o código de entrega.');
    this.name = 'NoContactForOtpError';
    this.statusCode = 409;
  }
}

class OtpInvalidError extends Error {
  constructor() {
    super('Código de entrega inválido.');
    this.name = 'OtpInvalidError';
    this.statusCode = 400;
  }
}

class OtpExpiredError extends Error {
  constructor() {
    super('Código de entrega expirado. Envie um novo.');
    this.name = 'OtpExpiredError';
    this.statusCode = 400;
  }
}

class OtpMaxAttemptsError extends Error {
  constructor() {
    super('Demasiadas tentativas de código. Envie um novo.');
    this.name = 'OtpMaxAttemptsError';
    this.statusCode = 429;
  }
}

// ─── Funções de domínio ──────────────────────────────────────────────────────

/** @param {string} code  @returns {boolean} */
function isInternationalCode(code) {
  return !code.endsWith('BR') && /^[A-Z]{2}\d+[A-Z]{2}$/.test(code);
}

/** @param {string} code */
function validateTrackingCode(code) {
  const isNational      = /^TRK\d+BR$/.test(code);
  const isInternational = /^[A-Z]{2}\d+[A-Z]{2}$/.test(code);
  if (!isNational && !isInternational) {
    throw new InvalidTrackingCodeError(code);
  }
}

/** @returns {string} */
function generateOrderId() {
  // Id GLOBALMENTE único (multi-tenant, spec § 2.4): não depende de contagem por
  // empresa — a numeração por contagem colidia com a chave primária global.
  return `order-${crypto.randomUUID()}`;
}

// ─── Use Cases ───────────────────────────────────────────────────────────────

/**
 * Lista pedidos com filtros e paginação (spec § 3.1).
 *
 * Devolve sempre o envelope `{ items, total, page, pageSize }`: uma listagem sem
 * teto era o caminho mais curto para uma página que deixa de abrir quando a
 * empresa passa das dezenas de milhares de pedidos.
 *
 * @param {{ page?: number, pageSize?: number, status?: string, search?: string, driver_id?: string, warehouse_id?: string, cod_status?: string, from?: string, to?: string }} [opts]
 */
async function listOrders(opts = {}) {
  const page = Math.max(Number(opts.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 25, 1), 200);
  const status = opts.status && Object.values(OrderStatus).includes(opts.status) ? opts.status : undefined;

  const { items, total } = await OrderRepository.list({
    status,
    search: opts.search,
    driver_id: opts.driver_id,
    warehouse_id: opts.warehouse_id,
    cod_status: opts.cod_status,
    from: opts.from,
    to: opts.to,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return { items, total, page, pageSize };
}

/**
 * Cria um novo pedido com status CREATED.
 *
 * @param {{ tracking_code: string; client: string; destination: string; value?: number; cod_amount?: number }} dto
 * @returns {Promise<object>} Pedido criado
 */
async function createOrder(dto) {
  if (!dto.tracking_code) throw new MissingRequiredFieldError('tracking_code');
  if (!dto.client)        throw new MissingRequiredFieldError('client');
  if (!dto.destination)   throw new MissingRequiredFieldError('destination');

  // Limite do plano da empresa (SaaS, spec § 2.5). Não faz nada sem empresa no
  // contexto (testes/tarefas de fundo) nem em planos sem limite.
  await assertQuota();

  // Limite de crédito do contrato (§ 3.35). Trava ANTES de gravar: aceitar a
  // encomenda e recusar a fatura depois deixa a operação a transportar carga de
  // um cliente que já não devia estar a receber serviço. Sem cliente registado,
  // sem contrato ou sem limite acordado, não faz nada.
  // `require` à chamada — `contracts.service` fecha um ciclo com o repositório.
  if (dto.client_ref_id) {
    const contracts = require('./contracts.service');
    await contracts.assertWithinCredit(String(dto.client_ref_id).trim(), Number(dto.value) || 0);
  }

  const code = dto.tracking_code.trim().toUpperCase();
  validateTrackingCode(code);

  const codAmount = normalizeCents(dto.cod_amount);

  const international = isInternationalCode(code);
  const now           = new Date().toISOString();
  const id            = generateOrderId();

  const desc = international
    ? 'International order registered — awaiting processing'
    : 'Order registered in the national system';
  const loc = international ? 'International Origin' : 'National Sorting Center';

  const hash = calculateEventHash(OrderStatus.CREATED, desc, loc, now, GENESIS_HASH);

  const newOrder = {
    id,
    client_id:      dto.client.trim(),
    client_ref_id:  dto.client_ref_id ? String(dto.client_ref_id).trim() : undefined,
    client_phone:   dto.client_phone ? String(dto.client_phone).trim() : undefined,
    client_email:   dto.client_email ? String(dto.client_email).trim().toLowerCase() : undefined,
    tracking_code:  code,
    current_status: OrderStatus.CREATED,
    origin: international
      ? { city: 'International Origin', state: '',   country: 'INTL' }
      : { city: 'Sorting Center',       state: 'SP', country: 'BR' },
    destination:    { city: dto.destination.trim(), state: '', country: 'BR' },
    carrier_intl_id: international ? '17TRACK' : undefined,
    driver_id:      undefined,
    cod_amount:     codAmount,
    cod_status:     codAmount > 0 ? 'pending' : 'none',
    weight_grams:   Number.isFinite(Number(dto.weight_grams)) && Number(dto.weight_grams) > 0 ? Math.round(Number(dto.weight_grams)) : undefined,
    pricing:        dto.pricing && typeof dto.pricing === 'object' ? dto.pricing : undefined,
    value:          typeof dto.value === 'number' ? dto.value : 1990,
    history: [
      {
        id:          crypto.randomUUID(),
        order_id:    id,
        status:      OrderStatus.CREATED,
        description: desc,
        location:    loc,
        event_origin: 'SYSTEM',
        timestamp:   now,
        parent_hash: GENESIS_HASH,
        hash,
      },
    ],
    created_at:     now,
    updated_at:     now,
  };

  console.info(`[audit] Order ${id} (${code}) created for client: ${maskPII(newOrder.client_id, 'EMAIL')}`);
  const created = await OrderRepository.create(newOrder);
  // O contador mensal é a fonte de verdade da quota — só depois de gravar.
  await consumeQuota();
  return created;
}

/**
 * Busca pedido pelo código de rastreio para exibição ao cliente.
 *
 * @param {string} trackingCode
 * @returns {Promise<object>} Pedido encontrado
 */
async function getOrderTracking(trackingCode) {
  const code  = trackingCode.trim().toUpperCase();
  const order = await OrderRepository.findByCode(code);
  if (!order) throw new OrderNotFoundError(code);
  return order;
}

/**
 * Imagens do comprovativo de um pedido, por id (spec § 3.28).
 *
 * Carregadas à parte: uma assinatura chega a 2,2 MB e nenhuma listagem precisa
 * delas. O `findById` antes da leitura não é cerimónia — é o que garante que o
 * pedido pertence à empresa de quem pergunta antes de a prova sair da base.
 *
 * @param {string} orderId
 * @returns {Promise<{ signature?: string, photo?: string }>}
 */
async function getPodImages(orderId) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (!order.pod) return {};
  return OrderRepository.findPodImages(order.id);
}

/**
 * O mesmo, pelo código de rastreio — serve o portal público do cliente, que
 * nunca teve login mas sempre mostrou a prova da sua própria entrega.
 *
 * @param {string} trackingCode
 * @returns {Promise<{ signature?: string, photo?: string }>}
 */
async function getPodImagesByCode(trackingCode) {
  const code  = String(trackingCode ?? '').trim().toUpperCase();
  const order = await OrderRepository.findByCode(code);
  if (!order) throw new OrderNotFoundError(code);
  if (!order.pod) return {};
  return OrderRepository.findPodImages(order.id);
}

/** Dados mínimos necessários ao motorista atribuído para executar a entrega. */
async function getDriverOrder(orderId) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  return {
    id: order.id,
    tracking_code: order.tracking_code,
    client: order.client_id,
    client_phone: order.client_phone ?? null,
    destination: order.destination,
    current_status: order.current_status,
    value: order.value,
    cod_amount: order.cod_amount,
    updated_at: order.updated_at,
  };
}

/**
 * Atualiza o status de um pedido, validando a transição.
 *
 * @param {string} orderId
 * @param {{ new_status: string; notes?: string; location?: string; event_origin?: string; user_id?: string; device_id?: string; device_timestamp?: string }} dto
 * @returns {Promise<object>} Pedido atualizado
 */
async function updateOrderStatus(orderId, dto) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);

  const newStatus = dto.new_status;

  // Uma entrada física precisa de armazém, capacidade e movimento auditável.
  // O endpoint genérico não possui esse contexto e não pode criar estados órfãos.
  if (newStatus === OrderStatus.AT_WAREHOUSE) {
    throw new WarehouseIntakeRequiredError();
  }

  if (!isValidTransition(order.current_status, newStatus)) {
    throw new InvalidStatusTransitionError(order.current_status, newStatus);
  }

  const now = new Date().toISOString();

  const latestEvent = order.history[0];
  const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;

  const desc = dto.notes ?? `Status updated to ${newStatus}`;
  const loc  = dto.location ?? 'In transit';

  const hash = calculateEventHash(newStatus, desc, loc, now, parentHash);

  const updatedOrder = {
    ...order,
    current_status: newStatus,
    updated_at:     now,
    history: [
      {
        id:          crypto.randomUUID(),
        order_id:    order.id,
        status:      newStatus,
        description: desc,
        location:    loc,
        event_origin: dto.event_origin ?? 'SYSTEM',
        user_id:      dto.user_id,
        device_id:    dto.device_id,
        device_timestamp: dto.device_timestamp,
        timestamp:   now,
        parent_hash: parentHash,
        hash,
      },
      ...order.history,
    ],
  };

  console.info(`[audit] Order ${orderId} updated: ${order.current_status} -> ${newStatus} (Hash: ${hash.substring(0, 8)})`);
  await OrderRepository.update(updatedOrder);
  return updatedOrder;
}

// ─── Entrega: comprovativo (POD) e insucesso ─────────────────────────────────
// Imagens (assinatura/foto) são guardadas como data URL em JSONB, com limite de
// tamanho. Pragmático para este projeto; em produção real migrar para object
// storage — a interface do POD não muda.

const MAX_POD_IMAGE_CHARS = 3_000_000; // ~2,2 MB em data URL

const VALID_FAILURE_REASONS = ['RECIPIENT_ABSENT', 'WRONG_ADDRESS', 'REFUSED', 'OTHER'];
const FAILURE_REASON_LABELS = {
  RECIPIENT_ABSENT: 'destinatário ausente',
  WRONG_ADDRESS:    'morada incorreta',
  REFUSED:          'encomenda recusada',
  OTHER:            'outro motivo',
};

/** Métodos de cobrança na entrega (espelha CodMethod de cod.types.ts). */
const VALID_COD_METHODS = ['CASH', 'MPESA', 'EMOLA', 'MKESH'];

/**
 * Normaliza um valor em centavos: inteiro ≥ 0 (0 quando ausente/ inválido).
 * @param {unknown} value
 * @returns {number}
 */
function normalizeCents(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Valida uma imagem de POD (assinatura/foto): data URL não vazio dentro do limite.
 * @param {unknown} value
 * @param {string} field
 * @returns {string | undefined}
 */
function validatePodImage(value, field) {
  if (value == null || value === '') return undefined;
  const s = String(value);
  if (!s.startsWith('data:')) throw new MissingRequiredFieldError(`${field} (data URL inválido)`);
  if (s.length > MAX_POD_IMAGE_CHARS) throw new PodTooLargeError(field);
  return s;
}

/** Rótulo legível do destino, para a localização do evento. */
function destinationLabel(order) {
  const d = order.destination || {};
  if (!d.city) return 'Local de entrega';
  return d.state ? `${d.city} - ${d.state}` : d.city;
}

// ─── OTP de entrega (spec § 3.1 / § 3.3) ─────────────────────────────────────
// Guardamos apenas o HASH do código; o texto só sai por SMS ao cliente. A
// validação é em tempo constante.

const OTP_TTL_MINUTES = () => Number(process.env.DELIVERY_OTP_TTL_MINUTES) || 240; // 4h
const OTP_MAX_ATTEMPTS = 5;

/** @returns {string} código de 6 dígitos */
function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** @param {string} code @returns {string} */
function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** Comparação em tempo constante do código introduzido com o hash guardado. */
function otpMatches(inputCode, storedHash) {
  const a = Buffer.from(hashOtp(inputCode), 'hex');
  const b = Buffer.from(String(storedHash ?? ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Gera um código de entrega (OTP) e envia-o ao cliente por SMS (spec § 3.3).
 * Válido apenas a partir de OUT_FOR_DELIVERY e exige telefone do cliente.
 *
 * @param {string} orderId
 * @param {{ user_id?: string }} [dto]
 * @returns {Promise<{ sent: boolean; expires_at: string }>}
 */
async function requestDeliveryOtp(orderId, dto = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (order.current_status !== OrderStatus.OUT_FOR_DELIVERY) throw new DeliveryStateError(order.current_status);
  if (!order.client_phone) throw new NoContactForOtpError();

  const code      = generateOtpCode();
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES() * 60_000).toISOString();

  const updatedOrder = {
    ...order,
    delivery_otp: { code_hash: hashOtp(code), expires_at: expiresAt, attempts: 0, created_at: now.toISOString(), verified_at: null },
    updated_at: now.toISOString(),
  };
  await OrderRepository.update(updatedOrder);

  // O código só sai por este canal (best-effort).
  try {
    await sendClientMessage({
      channels:      ['sms'],
      to_phone:      order.client_phone,
      body:          `O seu código de entrega para a encomenda ${order.tracking_code} é ${code}. Válido por ${OTP_TTL_MINUTES()} minutos.`,
      order_id:      order.id,
      tracking_code: order.tracking_code,
    });
  } catch (err) {
    console.error(`[otp] Falha ao enviar código da encomenda ${order.id}:`, err.message);
  }

  console.info(`[audit] Delivery OTP emitido para ${orderId} (expira ${expiresAt}).`);
  return { sent: true, expires_at: expiresAt };
}

/**
 * Regista a entrega com comprovativo (POD) — spec § 3.1.
 *
 * Válido apenas a partir de OUT_FOR_DELIVERY. Exige o nome de quem recebeu;
 * assinatura e foto são opcionais (data URL). Se houver um OTP de entrega emitido
 * e ainda não verificado, o código é obrigatório e validado. Anexa o POD ao
 * pedido e ao evento `delivered` na cadeia de histórico.
 *
 * @param {string} orderId
 * @param {{ recipient_name: string; otp?: string; signature?: string; photo?: string; notes?: string; lat?: number; lng?: number; cod_method?: string; event_origin?: string; user_id?: string }} dto
 * @returns {Promise<object>} Pedido atualizado (com pod)
 */
async function deliverOrder(orderId, dto) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (order.current_status !== OrderStatus.OUT_FOR_DELIVERY) {
    throw new DeliveryStateError(order.current_status);
  }

  const recipient = String(dto?.recipient_name ?? '').trim();
  if (!recipient) throw new MissingRequiredFieldError('recipient_name');

  // OTP de entrega: se emitido e ainda não verificado, é obrigatório e válido.
  if (order.delivery_otp && !order.delivery_otp.verified_at) {
    const otp = order.delivery_otp;
    const provided = String(dto.otp ?? '').trim();
    if (!provided) throw new MissingRequiredFieldError('otp');
    if (Date.parse(otp.expires_at) < Date.now()) throw new OtpExpiredError();
    if ((otp.attempts ?? 0) >= OTP_MAX_ATTEMPTS) throw new OtpMaxAttemptsError();
    if (!otpMatches(provided, otp.code_hash)) {
      await OrderRepository.update({
        ...order,
        delivery_otp: { ...otp, attempts: (otp.attempts ?? 0) + 1 },
        updated_at: new Date().toISOString(),
      });
      throw new OtpInvalidError();
    }
  }

  const signature = validatePodImage(dto.signature, 'signature');
  const photo     = validatePodImage(dto.photo, 'photo');
  const method = signature && photo ? 'signature_photo' : (photo && !signature ? 'photo' : 'signature');

  const now    = new Date().toISOString();
  const coords = validCoords(Number(dto.lat), Number(dto.lng))
    ? { lat: Number(dto.lat), lng: Number(dto.lng) }
    : undefined;

  const pod = {
    method,
    recipient_name: recipient,
    signature,
    photo,
    notes:       dto.notes ? String(dto.notes).trim() : undefined,
    coords,
    captured_by: dto.user_id,
    captured_at: now,
  };

  // ── COD: cobrança na entrega (spec § 3.5) ───────────────────────────────────
  // Quando o pedido tem valor a cobrar, o método é obrigatório e o valor recolhido
  // fica registado para o acerto de caixa do motorista.
  let codFields = {};
  if (order.cod_amount > 0) {
    const codMethod = String(dto.cod_method ?? '').trim().toUpperCase();
    if (!VALID_COD_METHODS.includes(codMethod)) throw new MissingRequiredFieldError('cod_method');
    const collected = dto.cod_amount != null ? normalizeCents(dto.cod_amount) : order.cod_amount;
    codFields = {
      cod:        { amount: collected, method: codMethod, collected_by: dto.user_id, collected_at: now },
      cod_status: 'collected',
    };
  }

  // OTP verificado (quando existia) fica marcado no pedido.
  const otpFields = order.delivery_otp && !order.delivery_otp.verified_at
    ? { delivery_otp: { ...order.delivery_otp, verified_at: now } }
    : {};

  const newStatus = OrderStatus.DELIVERED;
  const loc  = destinationLabel(order);
  const desc = `Entregue a ${recipient}.`
    + `${order.delivery_otp ? ' Código verificado.' : ''}`
    + `${signature ? ' Assinatura capturada.' : ''}${photo ? ' Foto capturada.' : ''}`
    + `${order.cod_amount > 0 ? ` COD cobrado (${codFields.cod.method}).` : ''}`;

  const latestEvent = order.history[0];
  const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash        = calculateEventHash(newStatus, desc, loc, now, parentHash);

  const updatedOrder = {
    ...order,
    current_status: newStatus,
    pod,
    ...codFields,
    ...otpFields,
    updated_at: now,
    history: [
      {
        id:           crypto.randomUUID(),
        order_id:     order.id,
        status:       newStatus,
        description:  desc,
        location:     loc,
        event_origin: dto.event_origin ?? 'DRIVER',
        user_id:      dto.user_id,
        recipient_name: recipient,
        has_signature:  Boolean(signature),
        has_photo:      Boolean(photo),
        timestamp:    now,
        parent_hash:  parentHash,
        hash,
      },
      ...order.history,
    ],
  };

  console.info(`[audit] Order ${orderId} DELIVERED to ${recipient.charAt(0)}*** (POD ${method}; Hash: ${hash.substring(0, 8)})`);
  await OrderRepository.update(updatedOrder);

  // Best-effort: ao cobrar COD, se existir fatura ativa do pedido, marca-a paga
  // com o método cobrado (faturação, spec § 3.14). Nunca bloqueia a entrega.
  if (order.cod_amount > 0) {
    try {
      const { markPaidForOrder } = require('./invoices.service');
      await markPaidForOrder(order.id, codFields.cod.method);
    } catch { /* faturação é best-effort */ }
  }

  // A resposta não devolve as imagens (spec § 3.28). Devolvê-las era mandar de
  // volta pela rede móvel os megabytes que o motorista acabou de enviar, para
  // um cliente que já os tem. A leitura do POD é sempre por metadados.
  return {
    ...updatedOrder,
    pod: { ...pod, signature: undefined, photo: undefined, has_signature: Boolean(signature), has_photo: Boolean(photo) },
  };
}

/**
 * Regista o insucesso de uma tentativa de entrega, com motivo — spec § 3.1.
 * Válido apenas a partir de OUT_FOR_DELIVERY. Transiciona para FAILED.
 *
 * @param {string} orderId
 * @param {{ reason: string; notes?: string; event_origin?: string; user_id?: string }} dto
 * @returns {Promise<object>} Pedido atualizado
 */
async function failDelivery(orderId, dto) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (order.current_status !== OrderStatus.OUT_FOR_DELIVERY) {
    throw new DeliveryStateError(order.current_status);
  }

  const reason = String(dto?.reason ?? '').trim().toUpperCase();
  if (!VALID_FAILURE_REASONS.includes(reason)) {
    throw new InvalidDeliveryFailureReasonError(dto?.reason);
  }

  const now       = new Date().toISOString();
  const newStatus = OrderStatus.FAILED;
  const loc       = destinationLabel(order);
  const notes     = dto.notes ? String(dto.notes).trim() : '';
  const desc      = `Insucesso na entrega: ${FAILURE_REASON_LABELS[reason]}.${notes ? ` ${notes}` : ''}`;

  const latestEvent = order.history[0];
  const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash        = calculateEventHash(newStatus, desc, loc, now, parentHash);

  const updatedOrder = {
    ...order,
    current_status: newStatus,
    updated_at: now,
    history: [
      {
        id:             crypto.randomUUID(),
        order_id:       order.id,
        status:         newStatus,
        description:    desc,
        location:       loc,
        event_origin:   dto.event_origin ?? 'DRIVER',
        user_id:        dto.user_id,
        failure_reason: reason,
        timestamp:      now,
        parent_hash:    parentHash,
        hash,
      },
      ...order.history,
    ],
  };

  console.info(`[audit] Order ${orderId} delivery FAILED (${reason}; Hash: ${hash.substring(0, 8)})`);
  await OrderRepository.update(updatedOrder);
  return updatedOrder;
}

/**
 * Regista a entrada física de uma encomenda num armazém (spec § 8.2, passo 1).
 *
 * Transiciona a encomenda para AT_WAREHOUSE (validando a transição), liga-a ao
 * armazém (`warehouse_id`) e regista o evento na cadeia de histórico. Reutiliza a
 * mesma lógica de hash/validação de `updateOrderStatus`. É a peça "lado-pedido"
 * usada pelo `warehouses.service` no fluxo de entrada (intake).
 *
 * @param {string} orderId
 * @param {{ warehouse_id: string; location: string; notes?: string; event_origin?: string; user_id?: string }} dto
 * @returns {Promise<object>} Pedido atualizado (com warehouse_id definido)
 */
async function receiveIntoWarehouse(orderId, dto, executor) {
  const order = await OrderRepository.findById(orderId, executor);
  if (!order) throw new OrderNotFoundError(orderId);

  const newStatus = OrderStatus.AT_WAREHOUSE;
  if (!isValidTransition(order.current_status, newStatus)) {
    throw new InvalidStatusTransitionError(order.current_status, newStatus);
  }

  const now  = new Date().toISOString();
  const loc  = (dto.location && String(dto.location).trim()) || 'Armazém';
  const desc = (dto.notes && String(dto.notes).trim()) || 'Encomenda recebida e conferida no armazém.';

  const latestEvent = order.history[0];
  const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash        = calculateEventHash(newStatus, desc, loc, now, parentHash);

  const updatedOrder = {
    ...order,
    current_status: newStatus,
    warehouse_id:   dto.warehouse_id,
    updated_at:     now,
    history: [
      {
        id:           crypto.randomUUID(),
        order_id:     order.id,
        status:       newStatus,
        description:  desc,
        location:     loc,
        event_origin: dto.event_origin ?? 'ADMIN',
        user_id:      dto.user_id,
        timestamp:    now,
        parent_hash:  parentHash,
        hash,
      },
      ...order.history,
    ],
  };

  console.info(`[audit] Order ${orderId} received @ warehouse ${dto.warehouse_id} (${loc}) -> ${newStatus} (Hash: ${hash.substring(0, 8)})`);
  await OrderRepository.update(updatedOrder, executor);
  return updatedOrder;
}

/**
 * Divide uma string de destino "Cidade - UF" nas suas partes.
 * @param {string} input
 * @param {string} [fallbackCountry]
 * @returns {{ city: string; state: string; country: string }}
 */
function parseDestinationString(input, fallbackCountry) {
  const raw = String(input).trim();
  const [cityPart, statePart] = raw.split(/\s*-\s*/);
  return {
    city:    (cityPart || raw).trim(),
    state:   (statePart || '').trim(),
    country: fallbackCountry || 'BR',
  };
}

/**
 * Aciona o routes-service para recalcular a rota do pedido (spec § 8.2, passo 5).
 *
 * Se o pedido tem motorista atribuído, cria uma rota otimizada persistida
 * (`POST /routes`) usando a posição GPS atual do motorista como origem — assim a
 * rota fica visível no painel de Rotas. Sem motorista, faz um cálculo puro
 * O cálculo chama diretamente o módulo de rotas. É best-effort: uma falha no
 * cálculo não impede o envio e fica registada no histórico.
 *
 * @param {object} order
 * @param {string} destLabel
 * @returns {Promise<{ ok: boolean; persisted?: boolean; routeId?: string; distanceKm?: number; unoptimized?: number; reason?: string }>}
 */
function validCoords(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && !Number.isNaN(lat) && !Number.isNaN(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

async function recalculateRoute(order, destLabel, coords) {
  const stop = { order_id: order.id, address: destLabel };
  if (coords && validCoords(coords.lat, coords.lng)) {
    stop.lat = coords.lat;
    stop.lng = coords.lng;
  }

  let origin;
  if (order.driver_id) {
    const driver = await DriverRepository.findById(order.driver_id);
    if (driver?.gps && typeof driver.gps.lat === 'number' && typeof driver.gps.lng === 'number') {
      origin = { lat: driver.gps.lat, lng: driver.gps.lng };
    }
  }

  try {
    const persist = Boolean(order.driver_id);
    const body    = persist
      ? { driver_id: order.driver_id, stops: [stop], origin }
      : { stops: [stop], origin };
    const data = persist ? await createRoute(body) : previewOptimization(body);

    if (persist) {
      const unoptimized = (data.stops || []).filter((s) => s.lat == null).length;
      return { ok: true, persisted: true, routeId: data.id, distanceKm: data.distance_km, unoptimized };
    }
    return { ok: true, persisted: false, distanceKm: data.distance_km, unoptimized: (data.unoptimized_stops || []).length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Solicita o envio de um pedido que chegou ao armazém (spec § 8.2, passo 5).
 *
 * Confirma/define o destino → aciona o módulo de rotas para recalcular →
 * regista o evento DESTINATION_CONFIRMED → transiciona para OUT_FOR_DELIVERY.
 * Válido apenas a partir de AT_WAREHOUSE ou AWAITING_DESTINATION.
 *
 * @param {string} orderId
 * @param {{ destination: string; notes?: string }} dto
 * @returns {Promise<object>} Pedido atualizado (com route_id quando a rota é persistida)
 */
async function requestWarehouseShipment(orderId, dto) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);

  const atWarehouse =
    order.current_status === OrderStatus.AT_WAREHOUSE ||
    order.current_status === OrderStatus.AWAITING_DESTINATION;
  if (!atWarehouse) {
    throw new WarehouseActionError(order.current_status);
  }
  if (!dto || !dto.destination || !String(dto.destination).trim()) {
    throw new MissingRequiredFieldError('destination');
  }

  const destination  = parseDestinationString(dto.destination, order.destination?.country);
  const now          = new Date().toISOString();
  const warehouseLoc = order.history?.[0]?.location ?? 'Armazém';
  const newStatus    = OrderStatus.OUT_FOR_DELIVERY;
  const destLabel    = destination.state ? `${destination.city} - ${destination.state}` : destination.city;

  // Coordenadas reais capturadas de quem confirma (opcional) — dão distância real.
  const coords = validCoords(Number(dto.lat), Number(dto.lng))
    ? { lat: Number(dto.lat), lng: Number(dto.lng) }
    : null;
  if (coords) {
    destination.lat = coords.lat;
    destination.lng = coords.lng;
  }

  // Passo 5: routes-service recalcula a rota (real, best-effort).
  const route = await recalculateRoute(order, destLabel, coords);

  let routeNote;
  if (route.ok && route.persisted) {
    routeNote = `Rota ${route.routeId} recalculada pelo routes-service (${route.distanceKm} km`
      + `${route.unoptimized ? `, ${route.unoptimized} parada sem geocodificação` : ''}).`;
  } else if (route.ok) {
    routeNote = `Rota recalculada pelo routes-service (${route.distanceKm} km).`;
  } else {
    routeNote = `Rota não recalculada (routes-service indisponível: ${route.reason}).`;
  }

  const baseDesc = (dto.notes && String(dto.notes).trim())
    ? String(dto.notes).trim()
    : `Destino confirmado (${destLabel}). Envio solicitado no armazém.`;
  const desc = `${baseDesc} ${routeNote}`;

  const latestEvent = order.history[0];
  const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash        = calculateEventHash(newStatus, desc, warehouseLoc, now, parentHash);

  const updatedOrder = {
    ...order,
    destination,
    route_id:       route.ok && route.persisted ? route.routeId : order.route_id,
    // A encomenda deixa fisicamente o armazém ao ser expedida (envio) — liberta a ocupação.
    warehouse_id:   null,
    current_status: newStatus,
    updated_at:     now,
    history: [
      {
        id:          crypto.randomUUID(),
        order_id:    order.id,
        status:      newStatus,
        description: desc,
        location:    warehouseLoc,
        event_origin: dto.event_origin ?? 'SYSTEM',
        user_id:      dto.user_id,
        timestamp:   now,
        parent_hash: parentHash,
        hash,
      },
      ...order.history,
    ],
  };

  console.info(`[audit] Order ${orderId} DESTINATION_CONFIRMED @ ${warehouseLoc} -> ${newStatus} (dest: ${destLabel}; route: ${route.ok ? (route.routeId || 'preview') : 'FAILED'})`);
  await OrderRepository.update(updatedOrder);
  return updatedOrder;
}

/**
 * Solicita o envio por **código de rastreio** (fluxo do cliente, spec § 8.2).
 * Resolve o pedido pelo código e reutiliza a mesma lógica do operador.
 *
 * @param {string} code
 * @param {{ destination: string; notes?: string; lat?: number; lng?: number }} dto
 * @returns {Promise<object>} Pedido atualizado
 */
// ─── Reagendamento e devolução ao remetente (spec § 3.37) ────────────────────

/** Tentativas antes de a devolução passar a ser o único caminho. */
const MAX_DELIVERY_ATTEMPTS = Number(process.env.DELIVERY_MAX_ATTEMPTS) || 3;

/** Motivos de devolução ao remetente. */
const VALID_RETURN_REASONS = ['ATTEMPTS_EXHAUSTED', 'REFUSED', 'WRONG_ADDRESS', 'SENDER_REQUEST', 'OTHER'];

const RETURN_REASON_LABELS = {
  ATTEMPTS_EXHAUSTED: 'tentativas esgotadas',
  REFUSED:            'encomenda recusada',
  WRONG_ADDRESS:      'morada incorreta',
  SENDER_REQUEST:     'pedido do remetente',
  OTHER:              'outro motivo',
};

/** Data no formato YYYY-MM-DD, ou null. PURA. */
function parseScheduleDate(value) {
  const s = String(value ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

class RescheduleError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RescheduleError';
    this.statusCode = statusCode;
  }
}

class ReturnStateError extends Error {
  constructor(status) {
    super(`Não é possível devolver uma encomenda no estado "${status}".`);
    this.name = 'ReturnStateError';
    this.statusCode = 409;
  }
}

/**
 * Marca nova tentativa de entrega (§ 3.37).
 *
 * Só a partir de `failed`: reagendar uma entrega que ainda não foi tentada não
 * significa nada. A data fica NO PEDIDO e não num comentário — é o que permite
 * não pôr a encomenda numa rota antes do dia acordado, e aparecer no dia errado
 * é falhar a entrega uma segunda vez com o cliente à espera.
 *
 * A encomenda volta a `in_transit`: fisicamente regressa ao circuito até à nova
 * tentativa.
 *
 * @param {string} orderId
 * @param {{ scheduled_for: string, notes?: string, user_id?: string }} dto
 * @returns {Promise<object>}
 */
async function rescheduleDelivery(orderId, dto = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (order.current_status !== OrderStatus.FAILED) {
    throw new RescheduleError(
      `Só se reagenda uma entrega falhada. Esta encomenda está em "${order.current_status}".`, 409,
    );
  }

  const dia = parseScheduleDate(dto.scheduled_for);
  if (!dia) throw new RescheduleError('A data da nova tentativa é obrigatória (AAAA-MM-DD).');

  // Uma "nova tentativa" marcada para ontem é um erro de digitação que ninguém
  // apanha depois — a encomenda fica marcada para uma data que já passou.
  const hoje = new Date().toISOString().slice(0, 10);
  if (dia < hoje) throw new RescheduleError('A nova tentativa não pode ser marcada para uma data passada.');

  const tentativas = (order.delivery_attempts ?? 0) + 1;
  if (tentativas > MAX_DELIVERY_ATTEMPTS) {
    throw new RescheduleError(
      `A encomenda já esgotou as ${MAX_DELIVERY_ATTEMPTS} tentativas permitidas. `
      + 'O caminho agora é a devolução ao remetente.', 409,
    );
  }

  const atualizado = await updateOrderStatus(orderId, {
    new_status:   OrderStatus.IN_TRANSIT,
    notes:        `Nova tentativa marcada para ${dia}.${dto.notes ? ` ${String(dto.notes).trim()}` : ''}`,
    location:     destinationLabel(order),
    event_origin: dto.event_origin ?? 'ADMIN',
    user_id:      dto.user_id,
  });

  return OrderRepository.update({
    ...atualizado,
    delivery_attempts: tentativas,
    next_attempt_on:   dia,
    updated_at:        new Date().toISOString(),
  });
}

/**
 * Inicia a devolução ao remetente (§ 3.37).
 *
 * A encomenda viaja de volta em `in_transit` com o motivo registado. A partir de
 * `failed` (falhou e desiste-se) ou de `at_warehouse` (voltou ao armazém e ficou
 * lá) — são as duas situações reais em que se decide devolver.
 *
 * @param {string} orderId
 * @param {{ reason: string, notes?: string, user_id?: string }} dto
 * @returns {Promise<object>}
 */
async function startReturn(orderId, dto = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);

  const podeDevolver = order.current_status === OrderStatus.FAILED
    || order.current_status === OrderStatus.AT_WAREHOUSE;
  if (!podeDevolver) throw new ReturnStateError(order.current_status);

  const reason = String(dto.reason ?? '').trim().toUpperCase();
  if (!VALID_RETURN_REASONS.includes(reason)) {
    throw new RescheduleError(
      `Motivo de devolução inválido. Use ${VALID_RETURN_REASONS.join(', ')}.`,
    );
  }

  const now = new Date().toISOString();
  const atualizado = await updateOrderStatus(orderId, {
    new_status:   OrderStatus.IN_TRANSIT,
    notes:        `Devolução ao remetente: ${RETURN_REASON_LABELS[reason]}.${dto.notes ? ` ${String(dto.notes).trim()}` : ''}`,
    location:     'A caminho do remetente',
    event_origin: dto.event_origin ?? 'ADMIN',
    user_id:      dto.user_id,
  });

  return OrderRepository.update({
    ...atualizado,
    // A data marcada deixa de fazer sentido: já não vai haver nova tentativa.
    next_attempt_on: null,
    return_info: {
      reason,
      notes:      dto.notes ? String(dto.notes).trim().slice(0, 1000) : undefined,
      started_at: now,
      started_by: dto.user_id,
    },
    updated_at: now,
  });
}

/**
 * Confirma que a encomenda chegou de volta ao remetente (§ 3.37).
 *
 * Exige PROVA — quem recebeu de volta e quando. Uma devolução sem prova é
 * indistinguível de uma encomenda perdida, e é precisamente aí que a discussão
 * com o remetente acontece.
 *
 * O COD é cancelado: o dinheiro nunca foi cobrado, e deixá-lo `pending` fá-lo
 * aparecer eternamente no que há a receber. Uma fatura ativa é ASSINALADA e não
 * alterada — creditar automaticamente seria inventar uma política comercial
 * (há quem cobre o frete na mesma, porque o trabalho foi feito). A nota de
 * crédito emite-se pelo § 3.19, por decisão de quem responde pela conta.
 *
 * @param {string} orderId
 * @param {{ received_by: string, signature?: string, photo?: string, notes?: string, user_id?: string }} dto
 * @returns {Promise<object>}
 */
async function confirmReturn(orderId, dto = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (!order.return_info) {
    throw new ReturnStateError(`${order.current_status} (devolução não iniciada)`);
  }
  if (order.current_status !== OrderStatus.IN_TRANSIT) {
    throw new ReturnStateError(order.current_status);
  }

  const recebidoPor = String(dto.received_by ?? '').trim();
  if (!recebidoPor) throw new MissingRequiredFieldError('received_by');

  const signature = validatePodImage(dto.signature, 'signature');
  const photo     = validatePodImage(dto.photo, 'photo');

  const now  = new Date().toISOString();
  const desc = `Devolvida ao remetente — recebida por ${recebidoPor}.`;
  const latest = order.history[0];
  const parentHash = latest ? (latest.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash = calculateEventHash(OrderStatus.RETURNED, desc, 'Remetente', now, parentHash);

  // Fatura ativa: assinalar, não mexer.
  let invoiceAlert;
  if (order.client_ref_id || order.id) {
    const { InvoiceRepository } = require('../infrastructure/pg.repository');
    const fatura = await InvoiceRepository.findActiveByOrderId(order.id);
    if (fatura) {
      invoiceAlert = {
        invoice_id: fatura.id,
        number: fatura.number,
        status: fatura.status,
        total_cents: fatura.total_cents,
        note: 'Existe fatura ativa. Emitir nota de crédito (§ 3.19) se a política da empresa o exigir.',
      };
    }
  }

  // As imagens vão para `order_pod_images` — ver a nota em `saveReturnImages`.
  await OrderRepository.saveReturnImages(order.id, { signature, photo });

  return OrderRepository.update({
    ...order,
    current_status: OrderStatus.RETURNED,
    // Nunca foi cobrado. `cancelled` e não `none`: `none` apagava o facto de
    // ter existido um valor a cobrar.
    cod_status: order.cod_amount > 0 ? 'cancelled' : order.cod_status,
    return_info: {
      ...order.return_info,
      received_by:  recebidoPor,
      received_at:  now,
      has_signature: Boolean(signature),
      has_photo:     Boolean(photo),
      confirmed_by:  dto.user_id,
      notes:         dto.notes ? String(dto.notes).trim().slice(0, 1000) : order.return_info.notes,
      invoice_alert: invoiceAlert,
    },
    updated_at: now,
    history: [
      {
        id: crypto.randomUUID(),
        order_id: order.id,
        status: OrderStatus.RETURNED,
        description: desc,
        location: 'Remetente',
        event_origin: dto.event_origin ?? 'ADMIN',
        user_id: dto.user_id,
        recipient_name: recebidoPor,
        timestamp: now,
        parent_hash: parentHash,
        hash,
      },
      ...order.history,
    ],
  });
}

/**
 * A encomenda sai de um armazém numa transferência entre filiais (§ 3.36).
 *
 * Difere de `requestWarehouseShipment` no essencial: aquela é a última perna —
 * a encomenda sai PARA O DESTINATÁRIO e vai a `out_for_delivery`. Esta é um
 * movimento interno: vai a `in_transit` e **perde o armazém**, porque durante o
 * percurso não está em nenhum. Deixá-la a contar na ocupação da origem daria um
 * inventário que não corresponde ao que lá está.
 *
 * @param {string} orderId
 * @param {{ transfer_code?: string, user_id?: string }} [dto]
 * @returns {Promise<object>}
 */
async function leaveWarehouseForTransfer(orderId, dto = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (order.current_status !== OrderStatus.AT_WAREHOUSE) {
    throw new WarehouseActionError(order.current_status);
  }

  const atualizado = await updateOrderStatus(orderId, {
    new_status:   OrderStatus.IN_TRANSIT,
    notes:        `Transferência entre filiais${dto.transfer_code ? ` (${dto.transfer_code})` : ''}`,
    location:     'Em trânsito entre armazéns',
    event_origin: 'ADMIN',
    user_id:      dto.user_id,
  });

  // Só depois de a transição passar: se o estado não podia mudar, o armazém não
  // pode ser limpo, ou a encomenda ficava sem localização nenhuma.
  return OrderRepository.update({ ...atualizado, warehouse_id: undefined, updated_at: new Date().toISOString() });
}

/**
 * A encomenda chega ao armazém de destino de uma transferência (§ 3.36).
 *
 * Não passa por `receiveIntoWarehouse` de propósito: aquela verifica capacidade
 * e recusa. Aqui o camião já descarregou — recusar seria ficção, e a encomenda
 * ficava sem sítio nenhum no sistema enquanto está fisicamente no chão do
 * armazém. O excesso de capacidade é reportado pela transferência, não travado.
 *
 * @param {string} orderId
 * @param {{ warehouse_id: string, transfer_code?: string, user_id?: string }} dto
 * @returns {Promise<object>}
 */
async function arriveFromTransfer(orderId, dto) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (!dto?.warehouse_id) throw new MissingRequiredFieldError('warehouse_id');

  // Já cá está (releitura de um código repetido na conferência): não há nada a
  // fazer, e repetir a transição rebentaria a máquina de estados sem razão.
  if (order.current_status === OrderStatus.AT_WAREHOUSE && order.warehouse_id === dto.warehouse_id) {
    return order;
  }
  if (order.current_status !== OrderStatus.IN_TRANSIT) {
    throw new WarehouseActionError(order.current_status);
  }

  const now  = new Date().toISOString();
  const desc = `Recebida por transferência${dto.transfer_code ? ` (${dto.transfer_code})` : ''}`;
  const latest = order.history[0];
  const parentHash = latest ? (latest.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash = calculateEventHash(OrderStatus.AT_WAREHOUSE, desc, 'Armazém de destino', now, parentHash);

  return OrderRepository.update({
    ...order,
    current_status: OrderStatus.AT_WAREHOUSE,
    warehouse_id:   dto.warehouse_id,
    updated_at:     now,
    history: [
      {
        id: crypto.randomUUID(),
        order_id: order.id,
        status: OrderStatus.AT_WAREHOUSE,
        description: desc,
        location: 'Armazém de destino',
        event_origin: 'ADMIN',
        user_id: dto.user_id,
        timestamp: now,
        parent_hash: parentHash,
        hash,
      },
      ...order.history,
    ],
  });
}

async function requestShipmentByCode(code, dto) {
  const order = await OrderRepository.findByCode(String(code || '').trim().toUpperCase());
  if (!order) throw new OrderNotFoundError(code);
  return requestWarehouseShipment(order.id, dto);
}

/**
 * Processa lote de eventos offline do app do motorista.
 *
 * @param {{ events: Array<{ order_id: string; payload: { new_status: string; notes?: string }; device_timestamp: string; correlation_id: string }> }} dto
 * @returns {Promise<{ success: boolean; syncedCount: number; skippedCount: number }>}
 */
async function syncDriverEvents(dto) {
  if (!Array.isArray(dto.events)) {
    throw new MissingRequiredFieldError('events');
  }

  let synced  = 0;
  let skipped = 0;

  for (const evt of dto.events) {
    const order = (await OrderRepository.findById(evt.order_id))
      ?? (await OrderRepository.findByCode(evt.order_id));

    if (!order) { skipped++; continue; }

    const newStatus = evt.payload?.new_status;
    if (!newStatus || !isValidTransition(order.current_status, newStatus)) {
      console.warn(
        `[sync] Skipped event ${evt.correlation_id ?? '?'}: ` +
        `invalid transition ${order.current_status} → ${newStatus}`,
      );
      skipped++;
      continue;
    }

    const now = new Date().toISOString();
    const latestEvent = order.history[0];
    const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;

    const desc = evt.payload.notes ?? 'Updated via driver app';
    const loc  = 'In transit';

    const hash = calculateEventHash(newStatus, desc, loc, now, parentHash);

    const updatedOrder = {
      ...order,
      current_status: newStatus,
      updated_at:     now,
      history: [
        {
          id:          evt.id ?? crypto.randomUUID(),
          order_id:    order.id,
          status:      newStatus,
          description: desc,
          location:    loc,
          event_origin: 'DRIVER',
          user_id:      dto.driver_id,
          device_id:    evt.device_id,
          device_timestamp: evt.device_timestamp,
          timestamp:   now,
          parent_hash: parentHash,
          hash,
        },
        ...order.history,
      ],
    };

    console.info(`[audit] Offline sync: Order ${order.id} updated: ${order.current_status} -> ${newStatus} (Hash: ${hash.substring(0, 8)})`);
    await OrderRepository.update(updatedOrder);
    synced++;
  }

  return { success: true, syncedCount: synced, skippedCount: skipped };
}


// ─── Levantamento no armazém (spec § 3.23) ───────────────────────────────────

/** Estados em que a encomenda está fisicamente no armazém e pode ser levantada. */
const PICKUPABLE_STATUSES = [OrderStatus.AT_WAREHOUSE, OrderStatus.AWAITING_DESTINATION];

/**
 * Valida e normaliza quem levanta a encomenda. PURA.
 *
 * O levantamento por terceiros é o caso comum — o destinatário manda alguém —
 * mas é também onde nascem as reclamações. Por isso, quem não é o destinatário
 * tem de ficar identificado com **relação** e **como foi autorizado**; sem isso
 * não há como responder a "quem levou a minha encomenda?".
 *
 * @param {object} dto
 * @returns {{name:string,document:string,is_recipient:boolean,relationship?:string,authorization?:string}}
 */
function normalizeCollector(dto = {}) {
  const name = String(dto.collector_name ?? '').trim();
  if (!name) throw new MissingRequiredFieldError('collector_name');

  const document = String(dto.collector_document ?? '').trim();
  if (document.length < 4) throw new MissingRequiredFieldError('collector_document');

  // Por omissão assume-se o destinatário: é o caso simples e o mais frequente.
  const isRecipient = dto.is_recipient === undefined ? true : Boolean(dto.is_recipient);
  if (isRecipient) return { name, document, is_recipient: true };

  const relationship = String(dto.relationship ?? '').trim();
  if (!relationship) throw new MissingRequiredFieldError('relationship');

  const authorization = String(dto.authorization ?? '').trim();
  if (authorization.length < 5) throw new MissingRequiredFieldError('authorization');

  return {
    name,
    document,
    is_recipient: false,
    relationship: relationship.slice(0, 120),
    authorization: authorization.slice(0, 300),
  };
}

/**
 * Entrega a encomenda ao balcão do armazém.
 *
 * Difere de `deliverOrder` no essencial: não há motorista nem rota, a encomenda
 * sai do armazém pelas mãos de quem a vem buscar, e o COD entra no caixa do
 * ARMAZÉM — por isso fica marcado com `channel: 'warehouse'` e é excluído do
 * acerto do motorista (§ 3.5).
 *
 * @param {string} orderId
 * @param {object} dto
 */
async function pickupOrder(orderId, dto = {}) {
  const order = await OrderRepository.findById(orderId);
  if (!order) throw new OrderNotFoundError(orderId);
  if (!PICKUPABLE_STATUSES.includes(order.current_status)) {
    throw new DeliveryStateError(order.current_status);
  }

  const collector = normalizeCollector(dto);

  // O código de entrega, quando existe, vale tanto ao domicílio como ao balcão.
  if (order.delivery_otp && !order.delivery_otp.verified_at) {
    const otp = order.delivery_otp;
    const provided = String(dto.otp ?? '').trim();
    if (!provided) throw new MissingRequiredFieldError('otp');
    if (Date.parse(otp.expires_at) < Date.now()) throw new OtpExpiredError();
    if ((otp.attempts ?? 0) >= OTP_MAX_ATTEMPTS) throw new OtpMaxAttemptsError();
    if (!otpMatches(provided, otp.code_hash)) {
      await OrderRepository.update({
        ...order,
        delivery_otp: { ...otp, attempts: (otp.attempts ?? 0) + 1 },
        updated_at: new Date().toISOString(),
      });
      throw new OtpInvalidError();
    }
  }

  const signature = validatePodImage(dto.signature, 'signature');
  const photo     = validatePodImage(dto.photo, 'photo');
  const method = signature && photo ? 'signature_photo' : (photo && !signature ? 'photo' : 'signature');
  const now = new Date().toISOString();

  const pod = {
    method,
    recipient_name: collector.name,
    signature,
    photo,
    notes:       dto.notes ? String(dto.notes).trim() : undefined,
    captured_by: dto.user_id,
    captured_at: now,
    // Bloco próprio do levantamento: é o que responde a "quem levou".
    pickup: {
      ...collector,
      warehouse_id: order.warehouse_id,
      collected_at: now,
    },
  };

  let codFields = {};
  if (order.cod_amount > 0) {
    const codMethod = String(dto.cod_method ?? '').trim().toUpperCase();
    if (!VALID_COD_METHODS.includes(codMethod)) throw new MissingRequiredFieldError('cod_method');
    const collected = dto.cod_amount != null ? normalizeCents(dto.cod_amount) : order.cod_amount;
    codFields = {
      cod: {
        amount: collected,
        method: codMethod,
        collected_by: dto.user_id,
        collected_at: now,
        // Dinheiro que entrou no caixa do armazém, não no do motorista.
        channel: 'warehouse',
        warehouse_id: order.warehouse_id,
      },
      cod_status: 'collected',
    };
  }

  const otpFields = order.delivery_otp && !order.delivery_otp.verified_at
    ? { delivery_otp: { ...order.delivery_otp, verified_at: now } }
    : {};

  const newStatus = OrderStatus.DELIVERED;
  const loc = destinationLabel(order);
  const who = collector.is_recipient
    ? `ao destinatário ${collector.name}`
    : `a ${collector.name} (${collector.relationship}), autorizado pelo destinatário`;
  const desc = `Levantado no armazém ${who}.`
    + `${order.delivery_otp ? ' Código verificado.' : ''}`
    + `${signature ? ' Assinatura capturada.' : ''}${photo ? ' Foto capturada.' : ''}`
    + `${order.cod_amount > 0 ? ` COD cobrado ao balcão (${codFields.cod.method}).` : ''}`;

  const latestEvent = order.history[0];
  const parentHash  = latestEvent ? (latestEvent.hash || GENESIS_HASH) : GENESIS_HASH;
  const hash        = calculateEventHash(newStatus, desc, loc, now, parentHash);

  const updatedOrder = {
    ...order,
    current_status: newStatus,
    pod,
    ...codFields,
    ...otpFields,
    updated_at: now,
    history: [
      {
        id:           crypto.randomUUID(),
        order_id:     order.id,
        status:       newStatus,
        description:  desc,
        location:     loc,
        event_origin: 'ADMIN',
        user_id:      dto.user_id,
        recipient_name: collector.name,
        has_signature:  Boolean(signature),
        has_photo:      Boolean(photo),
        timestamp:    now,
        parent_hash:  parentHash,
        hash,
      },
      ...order.history,
    ],
  };

  console.info(`[audit] Order ${orderId} PICKED UP by ${collector.name.charAt(0)}*** (${collector.is_recipient ? 'destinatário' : 'terceiro'}; Hash: ${hash.substring(0, 8)})`);
  await OrderRepository.update(updatedOrder);

  if (order.cod_amount > 0) {
    try {
      const { markPaidForOrder } = require('./invoices.service');
      await markPaidForOrder(order.id, codFields.cod.method);
    } catch { /* faturação é best-effort */ }
  }

  return updatedOrder;
}

module.exports = {
  pickupOrder,
  normalizeCollector,
  PICKUPABLE_STATUSES,
  listOrders,
  createOrder,
  getOrderTracking,
  getPodImages,
  getPodImagesByCode,
  getDriverOrder,
  updateOrderStatus,
  receiveIntoWarehouse,
  requestWarehouseShipment,
  leaveWarehouseForTransfer,
  arriveFromTransfer,
  // Reagendamento e devolução (§ 3.37)
  rescheduleDelivery,
  startReturn,
  confirmReturn,
  parseScheduleDate,
  MAX_DELIVERY_ATTEMPTS,
  VALID_RETURN_REASONS,
  RETURN_REASON_LABELS,
  RescheduleError,
  ReturnStateError,
  requestShipmentByCode,
  deliverOrder,
  failDelivery,
  requestDeliveryOtp,
  syncDriverEvents,
  // Erros exportados para uso no controller
  OrderNotFoundError,
  InvalidStatusTransitionError,
  InvalidTrackingCodeError,
  MissingRequiredFieldError,
  WarehouseActionError,
  WarehouseIntakeRequiredError,
  DeliveryStateError,
  PodTooLargeError,
  InvalidDeliveryFailureReasonError,
  NoContactForOtpError,
  OtpInvalidError,
  OtpExpiredError,
  OtpMaxAttemptsError,
};
