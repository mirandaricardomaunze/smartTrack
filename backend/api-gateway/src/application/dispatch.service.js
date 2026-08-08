/**
 * @file dispatch.service.js
 * @description Verificação de carga antes de atribuir uma rota a um motorista.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.33 (e § 3.2, capacidade
 * do veículo, que o otimizador de rotas ainda não considerava)
 *
 * PORQUE ISTO EXISTE: o § 3.2 já pedia que a rota respeitasse a capacidade do
 * veículo, mas nada verificava. Com motociclistas e mototriciclistas na frota
 * isso deixa de ser um detalhe — 200 kg atribuídos a uma moto não são uma rota
 * ineficiente, são uma rota impossível, e quem descobre é o motorista no
 * armazém, com o cliente já notificado. A verificação corre no gateway porque é
 * o único sítio onde o motorista (e o seu veículo) e os pedidos (e o seu peso)
 * são conhecidos ao mesmo tempo: o módulo de rotas só vê paradas.
 *
 * O QUE NÃO FAZ: não reparte a carga por vários motoristas nem escolhe o
 * veículo. Recusa e diz porquê, com o modal sugerido — a decisão de quem leva
 * o quê continua de quem despacha.
 */
'use strict';

const { DriverRepository, OrderRepository } = require('../infrastructure/pg.repository');
const modals = require('../domain/delivery-modals');

class DispatchError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {{ modal?: string|null, suggested_modal?: string|null }} [detail]
   */
  constructor(message, statusCode = 422, detail = {}) {
    super(message);
    this.name            = 'DispatchError';
    this.statusCode      = statusCode;
    this.modal           = detail.modal ?? null;
    this.suggested_modal = detail.suggested_modal ?? null;
  }
}

/**
 * Soma o peso conhecido de um conjunto de paradas.
 *
 * Pedidos sem peso registado entram na contagem de `unknown_weight` em vez de
 * assumirem zero ou um valor médio: dizer "não sei" é honesto e deixa quem
 * despacha decidir; inventar um peso é que produziria uma recusa (ou uma
 * autorização) sem base nenhuma.
 *
 * @param {Array<{ order_id?: string }>} stops
 * @returns {Promise<{ total_grams: number, heaviest_grams: number, heaviest_order_id: string|null, counted: number, unknown_weight: number }>}
 */
async function summarizeStopLoad(stops = []) {
  const ids    = stops.map((stop) => stop?.order_id).filter(Boolean);
  const orders = await OrderRepository.findManyByIds(ids);

  let total    = 0;
  let heaviest = 0;
  let heaviestOrderId = null;
  let counted  = 0;
  let unknown  = 0;

  for (const id of new Set(ids)) {
    const weight = Number(orders.get(id)?.weight_grams);
    if (!Number.isFinite(weight) || weight <= 0) { unknown++; continue; }

    total += weight;
    counted++;
    if (weight > heaviest) { heaviest = weight; heaviestOrderId = id; }
  }

  return {
    total_grams:       total,
    heaviest_grams:    heaviest,
    heaviest_order_id: heaviestOrderId,
    counted,
    unknown_weight:    unknown,
  };
}

/**
 * Capacidade efetiva do veículo de um motorista, em gramas.
 * @param {object} driver
 * @returns {{ modal: object, capacity_grams: number }}
 */
function driverCapacity(driver) {
  const vehicle = driver?.vehicle ?? {};
  const modal   = modals.getModal(vehicle.type);
  if (!modal) {
    throw new DispatchError(
      `O motorista ${driver?.name ?? ''} não tem um tipo de veículo válido no cadastro.`.trim(),
      409,
    );
  }
  return { modal, capacity_grams: modals.capacityGramsFor(modal.code, vehicle.capacity_kg) };
}

/**
 * Recusa a rota se a carga não couber no veículo do motorista.
 *
 * Duas verificações, porque falham por razões diferentes:
 *   1. um volume isolado maior que o veículo — nunca vai caber, nem sozinho;
 *   2. a soma das paradas acima da capacidade — cabe repartido, não de uma vez.
 *
 * @param {string} driverId
 * @param {Array<{ order_id?: string }>} stops
 * @returns {Promise<{ modal: string, capacity_kg: number, load_kg: number, unknown_weight: number }>}
 * @throws {DispatchError}
 */
async function assertRouteFitsDriver(driverId, stops = []) {
  const driver = await DriverRepository.findById(driverId);
  if (!driver) throw new DispatchError(`Motorista não encontrado: ${driverId}`, 404);

  const { modal, capacity_grams } = driverCapacity(driver);
  const load = await summarizeStopLoad(stops);

  if (load.heaviest_grams > capacity_grams) {
    const fit = modals.fitsModal({ weight_grams: load.heaviest_grams }, modal.code, driver.vehicle?.capacity_kg);
    throw new DispatchError(
      `Um dos volumes pesa ${(load.heaviest_grams / 1000).toFixed(1)} kg e não cabe ` +
      `no veículo deste motorista (${modal.label}, até ${capacity_grams / 1000} kg).` +
      suggestionSuffix(fit.suggested_modal, modal.code),
      422,
      { modal: modal.code, suggested_modal: fit.suggested_modal },
    );
  }

  if (load.total_grams > capacity_grams) {
    const suggested = modals.smallestModalFor({ weight_grams: load.total_grams });
    throw new DispatchError(
      `A rota soma ${(load.total_grams / 1000).toFixed(1)} kg em ${load.counted} volumes e excede ` +
      `a capacidade do veículo (${modal.label}, até ${capacity_grams / 1000} kg). ` +
      'Reparta a carga por mais viagens ou por outro motorista.' +
      suggestionSuffix(suggested, modal.code),
      422,
      { modal: modal.code, suggested_modal: suggested },
    );
  }

  return {
    modal:          modal.code,
    capacity_kg:    capacity_grams / 1000,
    load_kg:        load.total_grams / 1000,
    unknown_weight: load.unknown_weight,
  };
}

/**
 * Sufixo de sugestão — omitido quando sugeriria o modal que já está em uso.
 * @param {string|null} suggested
 * @param {string} current
 * @returns {string}
 */
function suggestionSuffix(suggested, current) {
  if (!suggested || suggested === current) return '';
  return ` Sugestão: ${modals.MODAL_CATALOG[suggested].label}.`;
}

/**
 * Liga os pedidos de uma rota ao motorista que a vai fazer.
 *
 * PORQUÊ ISTO EXISTE: criar a rota gravava as paradas com o `order_id`, mas o
 * pedido em si ficava sem `driver_id`. O painel mostrava a rota montada e, na
 * prática, o motorista continuava sem a encomenda: `PUT /v1/orders/:id/status`
 * recusava-o (o guard de dono compara `order.driver_id` com o `sub` do token),
 * `POST /v1/driver-sync/events` devolvia 403 ao lote inteiro, a listagem
 * filtrada por motorista vinha vazia e o COD cobrado nunca entrava no acerto de
 * caixa. Só um ADMIN conseguia mover a encomenda — o que anula a aplicação do
 * motorista. Despachar tem de escrever a atribuição no pedido.
 *
 * Corre DEPOIS de a rota estar criada, e de propósito: a rota é o facto que
 * autoriza a atribuição. Se a criação falhar, nenhum pedido fica preso a um
 * motorista que não o vai levar.
 *
 * @param {{ id: string, driver_id: string, stops?: Array<{ order_id?: string }> }} route
 * @returns {Promise<{ assigned: string[], skipped: string[] }>}
 *   `skipped` são as paradas que a base recusou atualizar — pedido inexistente
 *   ou já entregue/cancelado. Quem despacha precisa de o saber: a parada está na
 *   rota mas a encomenda não vai ser levada.
 */
async function assignRouteOrders(route) {
  const ids = (route?.stops ?? []).map((stop) => stop?.order_id).filter(Boolean);
  if (ids.length === 0) return { assigned: [], skipped: [] };

  const assigned = await OrderRepository.assignToRoute(ids, {
    driver_id: route.driver_id,
    route_id:  route.id,
  });

  const feitos  = new Set(assigned);
  const skipped = [...new Set(ids)].filter((id) => !feitos.has(id));

  if (skipped.length > 0) {
    console.warn(
      `[dispatch] Rota ${route.id}: ${skipped.length} parada(s) não atribuída(s) ` +
      `(pedido inexistente, já entregue ou cancelado): ${skipped.join(', ')}.`,
    );
  }
  return { assigned, skipped };
}

module.exports = {
  assertRouteFitsDriver,
  assignRouteOrders,
  summarizeStopLoad,
  driverCapacity,
  DispatchError,
};
