/**
 * @file inventory.service.js
 * @description Transferências entre filiais e contagens de inventário.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * PORQUÊ EXISTE: havia entrada e envio, mas mover carga entre duas unidades da
 * mesma empresa fazia-se como um envio seguido de uma entrada — dois atos sem
 * ligação nenhuma. Entre um e outro a encomenda não estava em lado nenhum, e se
 * não chegasse, ninguém tinha como saber que devia ter chegado.
 *
 * A PEÇA CENTRAL É A RECONCILIAÇÃO, e aparece duas vezes no domínio: conferir o
 * que chegou de uma transferência contra o manifesto, e conferir o que está no
 * armazém contra o que o sistema diz. É a mesma operação — esperado contra
 * lido — e por isso é UMA função pura (`reconcile`) usada pelas duas. Escrevê-la
 * duas vezes daria duas definições de "em falta" que divergiriam à primeira
 * correção.
 *
 * DECISÕES QUE VALE A PENA CONHECER:
 *
 *   1. **Receber nunca recusa por capacidade.** A entrada normal recusa: a
 *      encomenda ainda não foi aceite e diz-se ao portador que a leve a outro
 *      lado. Numa transferência o camião já descarregou — recusar seria ficção,
 *      e a encomenda ficaria sem sítio nenhum no sistema enquanto está
 *      fisicamente no chão do armazém. Regista-se o excesso e segue.
 *
 *   2. **O que foi lido e não estava no manifesto é recebido na mesma.** A
 *      encomenda está ali. Recusá-la deixava-a em limbo. Fica marcada como
 *      inesperada, que é a informação de que alguém precisa.
 *
 *   3. **O que estava no manifesto e não chegou fica `in_transit`, sem
 *      armazém.** Não se inventa uma localização para uma encomenda perdida.
 *      Fica visível como em falta até aparecer.
 */
'use strict';

const crypto = require('crypto');
const {
  WarehouseRepository, OrderRepository, TransferRepository, CountRepository,
} = require('../infrastructure/pg.repository');
const ordersService = require('./orders.service');
const audit = require('./audit.service');

const TransferStatus = Object.freeze({
  DRAFT:      'draft',
  IN_TRANSIT: 'in_transit',
  RECEIVED:   'received',
  CANCELLED:  'cancelled',
});

const ItemStatus = Object.freeze({
  PENDING:    'pending',
  RECEIVED:   'received',
  MISSING:    'missing',
  UNEXPECTED: 'unexpected',
});

const CountStatus = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

// ─── Erros ───────────────────────────────────────────────────────────────────

class InventoryValidationError extends Error {
  constructor(message) { super(message); this.name = 'InventoryValidationError'; this.statusCode = 400; }
}
class TransferNotFoundError extends Error {
  constructor(id) { super(`Transferência não encontrada: ${id}`); this.name = 'TransferNotFoundError'; this.statusCode = 404; }
}
class CountNotFoundError extends Error {
  constructor(id) { super(`Contagem não encontrada: ${id}`); this.name = 'CountNotFoundError'; this.statusCode = 404; }
}
class TransferStateError extends Error {
  constructor(status, acao) {
    super(`Não é possível ${acao} uma transferência no estado "${status}".`);
    this.name = 'TransferStateError';
    this.statusCode = 409;
  }
}

// ─── Núcleo puro ─────────────────────────────────────────────────────────────

/**
 * Compara o que se esperava com o que se leu. PURA.
 *
 * A operação que dá sentido tanto à conferência de uma transferência como à
 * contagem de um armazém. Trabalha sobre identificadores opacos — códigos de
 * rastreio ou ids — e não sabe de onde vêm.
 *
 * Duplicados na leitura são absorvidos: ler duas vezes a mesma etiqueta é o que
 * acontece num armazém, e contá-la duas vezes produziria uma divergência que não
 * existe.
 *
 * @param {string[]} expected
 * @param {string[]} scanned
 * @returns {{ found: string[], missing: string[], unexpected: string[], expected_count: number, scanned_count: number, ok: boolean }}
 */
function reconcile(expected, scanned) {
  const esperados = new Set((expected ?? []).filter(Boolean).map(String));
  const lidos     = new Set((scanned ?? []).filter(Boolean).map(String));

  const found      = [...esperados].filter((x) => lidos.has(x));
  const missing    = [...esperados].filter((x) => !lidos.has(x));
  const unexpected = [...lidos].filter((x) => !esperados.has(x));

  return {
    found,
    missing,
    unexpected,
    expected_count: esperados.size,
    scanned_count:  lidos.size,
    // "Bateu certo" é não faltar nada E não aparecer nada a mais. Um armazém
    // com uma encomenda a mais está tão errado como um com uma a menos.
    ok: missing.length === 0 && unexpected.length === 0,
  };
}

/**
 * Idade de cada encomenda no armazém, em dias. PURA.
 *
 * PORQUE INTERESSA: uma encomenda parada há três semanas ocupa espaço que
 * nega outra e é uma falha de serviço que ninguém reparou. A ocupação diz
 * quantas estão lá; a idade diz quais é que não deviam estar.
 *
 * @param {Array<{ id: string, tracking_code?: string, updated_at?: string }>} orders
 * @param {string} [nowIso]
 * @returns {{ items: object[], buckets: { fresh: number, aging: number, stale: number }, oldest_days: number }}
 */
function ageInventory(orders, nowIso = new Date().toISOString()) {
  const agora = Date.parse(nowIso);
  const items = (orders ?? []).map((o) => {
    const desde = Date.parse(o.updated_at ?? o.created_at ?? nowIso);
    const days = Number.isFinite(desde) ? Math.max(0, Math.floor((agora - desde) / 86_400_000)) : 0;
    return { id: o.id, tracking_code: o.tracking_code, days_in_warehouse: days };
  });

  // Cortes em 3 e 7 dias: é a fronteira habitual entre "está a andar",
  // "atrasou" e "alguém tem de ir ver".
  const buckets = { fresh: 0, aging: 0, stale: 0 };
  for (const i of items) {
    if (i.days_in_warehouse <= 3) buckets.fresh += 1;
    else if (i.days_in_warehouse <= 7) buckets.aging += 1;
    else buckets.stale += 1;
  }

  return {
    items: items.sort((a, b) => b.days_in_warehouse - a.days_in_warehouse),
    buckets,
    oldest_days: items.reduce((max, i) => Math.max(max, i.days_in_warehouse), 0),
  };
}

/** Código legível e ordenável de uma transferência. PURA. */
function generateTransferCode(nowIso = new Date().toISOString()) {
  const ano = nowIso.slice(0, 4);
  return `TR${ano}/${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// ─── Use Cases — Transferências ──────────────────────────────────────────────

/**
 * Abre uma transferência com o manifesto do que vai seguir.
 *
 * As encomendas continuam fisicamente na origem: abrir é montar a lista, não
 * despachar. Só entram encomendas que estejam MESMO neste armazém — o operador
 * procura por código e nada garante que o código que leu pertence à unidade
 * onde está (mesmo raciocínio do levantamento ao balcão, § 3.23).
 *
 * @param {{ origin_id: string, destination_id: string, order_ids?: string[], tracking_codes?: string[], notes?: string, user_id?: string }} dto
 */
async function createTransfer(dto = {}) {
  const origin_id = String(dto.origin_id ?? '').trim();
  const destination_id = String(dto.destination_id ?? '').trim();
  if (!origin_id) throw new InventoryValidationError('A origem é obrigatória.');
  if (!destination_id) throw new InventoryValidationError('O destino é obrigatório.');
  if (origin_id === destination_id) {
    throw new InventoryValidationError('A origem e o destino têm de ser armazéns diferentes.');
  }

  const origem = await WarehouseRepository.findById(origin_id);
  if (!origem) throw new InventoryValidationError(`Armazém de origem não encontrado: ${origin_id}`);
  const destino = await WarehouseRepository.findById(destination_id);
  if (!destino) throw new InventoryValidationError(`Armazém de destino não encontrado: ${destination_id}`);
  if (destino.status !== 'active') {
    throw new InventoryValidationError(`O armazém de destino "${destino.code}" está inativo.`);
  }

  const encomendas = await resolveOrders(dto);
  if (encomendas.length === 0) {
    throw new InventoryValidationError('A transferência precisa de pelo menos uma encomenda.');
  }

  const foraDoArmazem = encomendas.filter((o) => o.warehouse_id !== origin_id);
  if (foraDoArmazem.length > 0) {
    throw new InventoryValidationError(
      `Estas encomendas não estão no armazém de origem: ${foraDoArmazem.map((o) => o.tracking_code).join(', ')}.`,
    );
  }

  const now = new Date().toISOString();
  const transfer = await TransferRepository.create({
    id: `transfer-${crypto.randomUUID()}`,
    code: generateTransferCode(now),
    origin_id,
    destination_id,
    status: TransferStatus.DRAFT,
    notes: dto.notes ? String(dto.notes).trim().slice(0, 2000) : null,
    created_at: now,
    updated_at: now,
  }, encomendas.map((o) => ({
    id: `transfer-item-${crypto.randomUUID()}`,
    order_id: o.id,
    tracking_code: o.tracking_code,
    status: ItemStatus.PENDING,
  })));

  await audit.record({
    action: 'inventory.transfer.create',
    summary: `Transferência ${transfer.code}: ${encomendas.length} encomenda(s) de ${origem.code} para ${destino.code}`,
    entity_type: 'warehouse_transfer', entity_id: transfer.id, entity_label: transfer.code,
    outcome: audit.Outcome.SUCCESS,
    metadata: { origin: origem.code, destination: destino.code, items: encomendas.length },
    request: { user_id: dto.user_id },
  });

  return transfer;
}

/**
 * Despacha a transferência: a carga sai da origem.
 *
 * Cada encomenda passa a `in_transit` e perde o armazém — durante o percurso
 * não está em nenhum, e deixá-la a contar na ocupação da origem daria um
 * inventário que não corresponde ao que lá está.
 *
 * @param {string} id
 * @param {{ user_id?: string }} [dto]
 */
async function dispatchTransfer(id, dto = {}) {
  const transfer = await TransferRepository.findById(id);
  if (!transfer) throw new TransferNotFoundError(id);
  if (transfer.status !== TransferStatus.DRAFT) throw new TransferStateError(transfer.status, 'despachar');

  const now = new Date().toISOString();
  for (const item of transfer.items) {
    await ordersService.leaveWarehouseForTransfer(item.order_id, {
      transfer_code: transfer.code,
      user_id: dto.user_id,
    });
  }

  const atualizada = await TransferRepository.update(id, {
    status: TransferStatus.IN_TRANSIT,
    dispatched_at: now,
    dispatched_by: dto.user_id ?? null,
    updated_at: now,
  });

  await audit.record({
    action: 'inventory.transfer.dispatch',
    summary: `Transferência ${transfer.code} despachada com ${transfer.items.length} encomenda(s)`,
    entity_type: 'warehouse_transfer', entity_id: id, entity_label: transfer.code,
    outcome: audit.Outcome.SUCCESS,
    request: { user_id: dto.user_id },
  });

  return atualizada;
}

/**
 * Confere e recebe a transferência no destino.
 *
 * É aqui que a transferência ganha sentido: compara-se o que chegou com o que
 * devia ter chegado. Ver as decisões 1 a 3 no topo do ficheiro para o porquê de
 * receber o inesperado, aceitar acima da capacidade e deixar o que falta em
 * trânsito.
 *
 * @param {string} id
 * @param {{ scanned_codes?: string[], notes?: string, user_id?: string }} dto
 * @returns {Promise<{ transfer: object, reconciliation: object, over_capacity: boolean }>}
 */
async function receiveTransfer(id, dto = {}) {
  const transfer = await TransferRepository.findById(id);
  if (!transfer) throw new TransferNotFoundError(id);
  if (transfer.status !== TransferStatus.IN_TRANSIT) throw new TransferStateError(transfer.status, 'receber');

  const lidos = [...new Set((dto.scanned_codes ?? [])
    .map((c) => String(c ?? '').trim().toUpperCase())
    .filter(Boolean))];

  const esperados = transfer.items.map((i) => i.tracking_code).filter(Boolean);
  const reconciliation = reconcile(esperados, lidos);

  const destino = await WarehouseRepository.findById(transfer.destination_id);
  const now = new Date().toISOString();

  // 1) O que veio no manifesto e foi lido: entra no destino.
  const porCodigo = new Map(transfer.items.map((i) => [i.tracking_code, i]));
  for (const codigo of reconciliation.found) {
    const item = porCodigo.get(codigo);
    await ordersService.arriveFromTransfer(item.order_id, {
      warehouse_id: transfer.destination_id,
      transfer_code: transfer.code,
      user_id: dto.user_id,
    });
    await TransferRepository.updateItemStatus(item.id, ItemStatus.RECEIVED);
  }

  // 2) O que veio no manifesto e NÃO foi lido: fica em trânsito, sinalizado.
  for (const codigo of reconciliation.missing) {
    await TransferRepository.updateItemStatus(porCodigo.get(codigo).id, ItemStatus.MISSING);
  }

  // 3) O que foi lido e não estava no manifesto: entra na mesma (está ali) e
  //    fica registado como inesperado.
  for (const codigo of reconciliation.unexpected) {
    const order = await OrderRepository.findByCode(codigo);
    if (!order) continue; // código que não é deste sistema — nada a receber
    await ordersService.arriveFromTransfer(order.id, {
      warehouse_id: transfer.destination_id,
      transfer_code: transfer.code,
      user_id: dto.user_id,
    });
    await TransferRepository.addItem(id, {
      id: `transfer-item-${crypto.randomUUID()}`,
      order_id: order.id,
      tracking_code: order.tracking_code,
      status: ItemStatus.UNEXPECTED,
    });
  }

  const atualizada = await TransferRepository.update(id, {
    status: TransferStatus.RECEIVED,
    received_at: now,
    received_by: dto.user_id ?? null,
    notes: dto.notes ? String(dto.notes).trim().slice(0, 2000) : transfer.notes,
    updated_at: now,
  });

  // Capacidade: informa, não trava (decisão 1).
  const destinoDepois = await WarehouseRepository.findById(transfer.destination_id);
  const over_capacity = destinoDepois.capacity > 0 && destinoDepois.occupancy > destinoDepois.capacity;

  await audit.record({
    action: 'inventory.transfer.receive',
    summary: `Transferência ${transfer.code} recebida em ${destino?.code}: `
      + `${reconciliation.found.length} conferida(s), ${reconciliation.missing.length} em falta, `
      + `${reconciliation.unexpected.length} inesperada(s)`,
    entity_type: 'warehouse_transfer', entity_id: id, entity_label: transfer.code,
    // Uma conferência com divergências não é um erro do sistema, mas também não
    // é um sucesso silencioso: quem audita tem de a encontrar sem procurar.
    outcome: reconciliation.ok ? audit.Outcome.SUCCESS : audit.Outcome.DENIED,
    metadata: {
      found: reconciliation.found.length,
      missing: reconciliation.missing,
      unexpected: reconciliation.unexpected,
      over_capacity,
    },
    request: { user_id: dto.user_id },
  });

  return { transfer: atualizada, reconciliation, over_capacity };
}

/** Cancela uma transferência ainda em rascunho — nada saiu, nada a desfazer. */
async function cancelTransfer(id, dto = {}) {
  const transfer = await TransferRepository.findById(id);
  if (!transfer) throw new TransferNotFoundError(id);
  if (transfer.status !== TransferStatus.DRAFT) throw new TransferStateError(transfer.status, 'cancelar');

  return TransferRepository.update(id, {
    status: TransferStatus.CANCELLED,
    updated_at: new Date().toISOString(),
  });
}

/** @param {{ warehouse_id?: string, status?: string }} [opts] */
async function listTransfers(opts = {}) {
  return TransferRepository.list(opts);
}

/** @param {string} id */
async function getTransfer(id) {
  const transfer = await TransferRepository.findById(id);
  if (!transfer) throw new TransferNotFoundError(id);
  return transfer;
}

// ─── Use Cases — Inventário e contagem ───────────────────────────────────────

/**
 * O que está no armazém agora, com idade.
 *
 * @param {string} warehouseId
 */
async function getInventory(warehouseId) {
  const warehouse = await WarehouseRepository.findById(warehouseId);
  if (!warehouse) throw new InventoryValidationError(`Armazém não encontrado: ${warehouseId}`);

  const orders = await WarehouseRepository.listOrders(warehouseId);
  return {
    warehouse: {
      id: warehouse.id, code: warehouse.code, name: warehouse.name,
      capacity: warehouse.capacity, occupancy: warehouse.occupancy,
      utilization: warehouse.utilization, near_capacity: warehouse.near_capacity,
    },
    ...ageInventory(orders),
  };
}

/**
 * Abre uma contagem, congelando o que o sistema diz estar no armazém.
 *
 * O congelamento é o ponto: comparar no fim com o estado ATUAL acusaria como
 * divergência tudo o que entrou e saiu legitimamente durante as duas horas em
 * que se andou a ler códigos.
 *
 * @param {string} warehouseId
 * @param {{ user_id?: string }} [dto]
 */
async function openCount(warehouseId, dto = {}) {
  const warehouse = await WarehouseRepository.findById(warehouseId);
  if (!warehouse) throw new InventoryValidationError(`Armazém não encontrado: ${warehouseId}`);

  const aberta = await CountRepository.findOpenByWarehouse(warehouseId);
  if (aberta) {
    throw new InventoryValidationError(
      `Já existe uma contagem aberta neste armazém (${aberta.id}). Feche-a antes de abrir outra.`,
    );
  }

  const orders = await WarehouseRepository.listOrders(warehouseId);
  return CountRepository.create({
    id: `count-${crypto.randomUUID()}`,
    warehouse_id: warehouseId,
    status: CountStatus.OPEN,
    expected: orders.map((o) => o.tracking_code).filter(Boolean),
    scanned: [],
    opened_by: dto.user_id ?? null,
    opened_at: new Date().toISOString(),
  });
}

/**
 * Acrescenta leituras a uma contagem aberta.
 *
 * Acumula em vez de substituir: a contagem faz-se em várias passagens, e cada
 * chamada trazer só o que se leu desde a anterior é como o leitor de mão
 * funciona.
 *
 * @param {string} countId
 * @param {{ codes?: string[] }} dto
 */
async function addCountScans(countId, dto = {}) {
  const count = await CountRepository.findById(countId);
  if (!count) throw new CountNotFoundError(countId);
  if (count.status !== CountStatus.OPEN) {
    throw new InventoryValidationError('A contagem já está fechada.');
  }

  const novos = (dto.codes ?? [])
    .map((c) => String(c ?? '').trim().toUpperCase())
    .filter(Boolean);

  const acumulado = [...new Set([...count.scanned, ...novos])];
  return CountRepository.update(countId, { scanned: acumulado });
}

/**
 * Fecha a contagem e produz o relatório de divergências.
 *
 * NÃO corrige nada sozinha. Uma contagem diz o que está diferente; decidir o que
 * fazer com uma encomenda que não aparece é do responsável da unidade, e mover
 * registos automaticamente com base numa leitura apagaria a prova do problema.
 *
 * @param {string} countId
 * @param {{ notes?: string, user_id?: string }} [dto]
 */
async function closeCount(countId, dto = {}) {
  const count = await CountRepository.findById(countId);
  if (!count) throw new CountNotFoundError(countId);
  if (count.status !== CountStatus.CLOSED) {
    const result = reconcile(count.expected, count.scanned);
    const fechada = await CountRepository.update(countId, {
      status: CountStatus.CLOSED,
      result,
      notes: dto.notes ? String(dto.notes).trim().slice(0, 2000) : null,
      closed_by: dto.user_id ?? null,
      closed_at: new Date().toISOString(),
    });

    await audit.record({
      action: 'inventory.count.close',
      summary: `Contagem fechada: ${result.found.length} conferida(s), `
        + `${result.missing.length} em falta, ${result.unexpected.length} a mais`,
      entity_type: 'warehouse_count', entity_id: countId,
      outcome: result.ok ? audit.Outcome.SUCCESS : audit.Outcome.DENIED,
      metadata: { missing: result.missing, unexpected: result.unexpected },
      request: { user_id: dto.user_id },
    });

    return fechada;
  }
  return count;
}

/** @param {string} warehouseId */
async function listCounts(warehouseId) {
  return CountRepository.listByWarehouse(warehouseId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve o manifesto: aceita ids ou códigos de rastreio, como o resto do
 * módulo de armazéns (o operador tem o código na etiqueta, não o id).
 *
 * @param {{ order_ids?: string[], tracking_codes?: string[] }} dto
 * @returns {Promise<object[]>}
 */
async function resolveOrders(dto) {
  const encontrados = [];
  const emFalta = [];

  for (const id of dto.order_ids ?? []) {
    const order = await OrderRepository.findById(id);
    if (order) encontrados.push(order); else emFalta.push(id);
  }
  for (const code of dto.tracking_codes ?? []) {
    const codigo = String(code ?? '').trim().toUpperCase();
    if (!codigo) continue;
    const order = await OrderRepository.findByCode(codigo);
    if (order) encontrados.push(order); else emFalta.push(codigo);
  }

  if (emFalta.length > 0) {
    throw new InventoryValidationError(`Encomendas não encontradas: ${emFalta.join(', ')}.`);
  }
  // Um id e o código da mesma encomenda no mesmo pedido não a metem duas vezes.
  return [...new Map(encontrados.map((o) => [o.id, o])).values()];
}

module.exports = {
  // Puros
  reconcile,
  ageInventory,
  generateTransferCode,
  // Transferências
  createTransfer,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
  listTransfers,
  getTransfer,
  // Inventário
  getInventory,
  openCount,
  addCountScans,
  closeCount,
  listCounts,
  // Constantes e erros
  TransferStatus,
  ItemStatus,
  CountStatus,
  InventoryValidationError,
  TransferNotFoundError,
  CountNotFoundError,
  TransferStateError,
};
