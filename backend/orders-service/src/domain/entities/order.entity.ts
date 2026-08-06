/**
 * @file order.entity.ts
 * @description Entidade de domínio Pedido.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 7 (Entidades — Pedido)
 *
 * REGRAS DE DOMÍNIO:
 * - Toda mudança de status DEVE passar por `isValidTransition()`.
 * - Nunca usar string literal de status — sempre `OrderStatus` enum.
 * - Campos de datas sempre UTC (ISO8601).
 * - `id` sempre UUID (formato `order-xxxx-uuid-nnnn` em testes).
 */
import {
  OrderStatus,
  isValidTransition,
} from '../../../../shared/types/src/order-status.enum';

export interface Endereco {
  cidade: string;
  estado: string;
  pais:   string; // ISO 3166-1 alpha-2: 'BR', 'CN', 'US'...
}

export interface GpsPosition {
  lat:     number;
  lng:     number;
  heading: number;
  speed:   number;    // m/s
  updatedAt: string;  // ISO8601 UTC
}

export interface HistoricoItem {
  status:      OrderStatus;
  descricao:   string;
  localizacao: string;
  timestamp:   string; // ISO8601 UTC
}

export interface Order {
  id:                    string;
  cliente_id:            string;
  codigo_rastreio:       string;
  status_atual:          OrderStatus;
  origem:                Endereco;
  destino:               Endereco;
  transportadora_intl_id?: string;
  motorista_id?:         string;
  rota_id?:              string;
  /** Valor em centavos inteiros. Nunca usar float. Ex: R$ 29,90 = 2990 */
  valor:                 number;
  historico:             HistoricoItem[];
  criado_em:             string; // ISO8601 UTC
  atualizado_em:         string; // ISO8601 UTC
}

/** DTO de criação validado antes de persistir */
export interface CreateOrderDTO {
  codigo_rastreio: string;
  cliente:         string;
  destino:         string;
  valor:           number;
}

/** Erro tipado de transição inválida */
export class InvalidStatusTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Transição inválida: ${from} → ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

/** Erro tipado de código de rastreio inválido */
export class InvalidTrackingCodeError extends Error {
  constructor(code: string) {
    super(`Código de rastreio inválido: "${code}"`);
    this.name = 'InvalidTrackingCodeError';
  }
}

// ─── Funções de domínio puras (sem efeitos colaterais) ─────────────────────

/**
 * Determina se o código de rastreio é de um pedido internacional.
 * Padrão nacional: começa com TRK e termina em BR (ex: TRK00000001BR).
 * Padrão internacional: duas letras, dígitos, duas letras (ex: LX987654321CN).
 */
export function isInternationalCode(code: string): boolean {
  return !code.endsWith('BR') && /^[A-Z]{2}\d+[A-Z]{2}$/.test(code);
}

/**
 * Valida o formato do código de rastreio.
 * Aceita padrão nacional (TRKxxx...BR) ou internacional (LLxxxxx...LL).
 */
export function validateTrackingCode(code: string): void {
  const isNational      = /^TRK\d+BR$/.test(code);
  const isInternational = /^[A-Z]{2}\d+[A-Z]{2}$/.test(code);

  if (!isNational && !isInternational) {
    throw new InvalidTrackingCodeError(code);
  }
}

/**
 * Aplica uma transição de status à entidade Order.
 * Lança `InvalidStatusTransitionError` se a transição não for permitida.
 * Retorna um novo objeto (imutável) — não muta o original.
 */
export function applyStatusTransition(
  order: Order,
  newStatus: OrderStatus,
  descricao: string,
  localizacao: string,
): Order {
  if (!isValidTransition(order.status_atual, newStatus)) {
    throw new InvalidStatusTransitionError(order.status_atual, newStatus);
  }

  const now = new Date().toISOString();

  const newHistoricoItem: HistoricoItem = {
    status:      newStatus,
    descricao,
    localizacao,
    timestamp:   now,
  };

  return {
    ...order,
    status_atual:  newStatus,
    atualizado_em: now,
    historico:     [newHistoricoItem, ...order.historico],
  };
}

/**
 * Cria um novo Order com status CREATED e historico inicial.
 * Deve ser chamado apenas pelo CreateOrderUseCase.
 */
export function createOrderEntity(
  id: string,
  dto: CreateOrderDTO,
): Order {
  const code = dto.codigo_rastreio.trim().toUpperCase();
  validateTrackingCode(code);

  const internacional = isInternationalCode(code);
  const now           = new Date().toISOString();

  return {
    id,
    cliente_id:    dto.cliente,
    codigo_rastreio: code,
    status_atual:  OrderStatus.CREATED,
    origem:        internacional
      ? { cidade: 'Origem Internacional', estado: '',   pais: 'INTL' }
      : { cidade: 'Centro de Triagem',    estado: 'SP', pais: 'BR' },
    destino:       { cidade: dto.destino, estado: '', pais: 'BR' },
    transportadora_intl_id: internacional ? '17TRACK' : undefined,
    valor:         dto.valor,
    historico:     [
      {
        status:      OrderStatus.CREATED,
        descricao:   internacional
          ? 'Pedido internacional registrado — aguardando processamento'
          : 'Pedido registrado no sistema nacional',
        localizacao: internacional ? 'Origem Internacional' : 'Centro de Triagem Nacional',
        timestamp:   now,
      },
    ],
    criado_em:     now,
    atualizado_em: now,
  };
}
