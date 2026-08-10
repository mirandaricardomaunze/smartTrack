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

// ─── Despacho automático (spec § 3.38) ───────────────────────────────────────

const { haversineKm } = require('../../../routes-service/src/domain/optimizer');

/** Estados a partir dos quais uma encomenda pode sair para entrega. */
const DISPATCHABLE_STATUSES = ['at_warehouse', 'collected'];

/**
 * A encomenda pode entrar numa rota hoje? PURA.
 *
 * Devolve o motivo da recusa em vez de um booleano: um plano que esconde as
 * sobras deixa encomendas paradas sem ninguém saber porquê.
 *
 * @param {object} order
 * @param {string} today YYYY-MM-DD
 * @returns {{ ok: boolean, reason?: string }}
 */
function orderEligibility(order, today) {
  if (!DISPATCHABLE_STATUSES.includes(order?.current_status)) {
    return { ok: false, reason: `não está pronta a sair (${order?.current_status})` };
  }
  if (!order.destination?.city) {
    return { ok: false, reason: 'sem destino registado' };
  }
  // Foi precisamente para isto que o § 3.37 pôs a data no pedido: uma encomenda
  // reagendada para sexta não entra na rota de terça.
  if (order.next_attempt_on && String(order.next_attempt_on).slice(0, 10) > today) {
    return { ok: false, reason: `nova tentativa marcada para ${String(order.next_attempt_on).slice(0, 10)}` };
  }
  return { ok: true };
}

/**
 * Coordenadas do destino de uma encomenda, se conhecidas. PURA.
 *
 * Aceita as duas formas em que as coordenadas aparecem no sistema — no próprio
 * pedido ou dentro do destino — porque ambas existem consoante a origem do
 * registo, e obrigar o chamador a normalizar espalharia esse conhecimento.
 *
 * @param {object} order
 * @returns {{ lat: number, lng: number }|null}
 */
function orderCoords(order) {
  const c = order?.coords ?? order?.destination?.coords ?? order?.gps;
  const lat = Number(c?.lat);
  const lng = Number(c?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Planeia a distribuição de encomendas por motoristas. PURA — não toca na base.
 *
 * Heurística: vizinho mais próximo com capacidade. Parte-se da origem, junta-se
 * a encomenda mais próxima, depois a mais próxima dessa, até o veículo encher;
 * repete-se para o motorista seguinte. É a mesma família do que o otimizador de
 * paradas já usa — introduzir aqui um segundo algoritmo daria duas noções de
 * "perto" no mesmo sistema.
 *
 * A ORDEM das paradas dentro de cada rota NÃO é decidida aqui: é do otimizador
 * (§ 3.2). Esta função decide quem leva o quê.
 *
 * @param {object[]} orders
 * @param {object[]} drivers
 * @param {{ origin?: {lat:number,lng:number}, today?: string }} [opts]
 * @returns {{ routes: object[], unassigned: object[], summary: object }}
 */
function planDispatch(orders, drivers, opts = {}) {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const origin = opts.origin ?? null;

  const unassigned = [];

  // 1. Elegibilidade das encomendas — as recusadas saem já nomeadas.
  const candidatas = [];
  for (const order of orders ?? []) {
    const elegivel = orderEligibility(order, today);
    if (elegivel.ok) candidatas.push(order);
    else unassigned.push({ order_id: order?.id, tracking_code: order?.tracking_code, reason: elegivel.reason });
  }

  // 2. Motoristas disponíveis. Um `on_route` já leva carga que o sistema não
  //    sabe medir, e somar-lhe mais seria decidir sobre um veículo que não se vê.
  const disponiveis = (drivers ?? []).filter((d) => d?.current_status === 'available');
  if (disponiveis.length === 0) {
    for (const order of candidatas) {
      unassigned.push({ order_id: order.id, tracking_code: order.tracking_code, reason: 'sem motoristas disponíveis' });
    }
    return { routes: [], unassigned, summary: resumo([], unassigned, candidatas.length) };
  }

  // Com coordenadas agrupa-se por proximidade; sem elas só resta a capacidade.
  const comCoords = candidatas.filter((o) => orderCoords(o));
  const semCoords = candidatas.filter((o) => !orderCoords(o));

  const routes = [];
  const porAtribuir = new Set(comCoords.map((o) => o.id));
  const porId = new Map(candidatas.map((o) => [o.id, o]));

  for (const driver of disponiveis) {
    let capacidade;
    try {
      capacidade = driverCapacity(driver).capacity_grams;
    } catch {
      // Veículo sem modal válido no cadastro: não se adivinha uma capacidade.
      continue;
    }

    const paradas = [];
    let carga = 0;
    let desconhecidas = 0;
    let referencia = origin;

    // Vizinho mais próximo enquanto couber.
    for (;;) {
      let melhor = null;
      let melhorDist = Infinity;

      for (const id of porAtribuir) {
        const order = porId.get(id);
        const peso = Number(order.weight_grams);
        // Peso desconhecido não consome capacidade nem é recusado por isso —
        // mesmo critério do § 3.33: dizer "não sei" é honesto.
        const consome = Number.isFinite(peso) && peso > 0 ? peso : 0;
        if (carga + consome > capacidade) continue;

        const c = orderCoords(order);
        const dist = referencia ? haversineKm(referencia, c) : 0;
        if (dist < melhorDist) { melhorDist = dist; melhor = order; }
      }

      if (!melhor) break;

      const peso = Number(melhor.weight_grams);
      if (Number.isFinite(peso) && peso > 0) carga += peso; else desconhecidas += 1;
      paradas.push(melhor);
      porAtribuir.delete(melhor.id);
      referencia = orderCoords(melhor);
    }

    if (paradas.length > 0) {
      routes.push(montarRota(driver, paradas, carga, desconhecidas, capacidade));
    }
  }

  // 3. As sem coordenadas entram no fim, por capacidade, em rotas já formadas
  //    ou numa nova de um motorista ainda livre.
  for (const order of semCoords) {
    const peso = Number(order.weight_grams);
    const consome = Number.isFinite(peso) && peso > 0 ? peso : 0;

    const rota = routes.find((r) => r.load_grams + consome <= r.capacity_grams);
    if (rota) {
      rota.stops.push(paradaDe(order, false));
      rota.load_grams += consome;
      if (consome === 0) rota.unknown_weight += 1;
      rota.load_kg = rota.load_grams / 1000;
      continue;
    }

    const livre = disponiveis.find((d) => !routes.some((r) => r.driver_id === d.id));
    if (livre) {
      let capacidade;
      try { capacidade = driverCapacity(livre).capacity_grams; } catch { capacidade = 0; }
      if (consome <= capacidade) {
        routes.push(montarRota(livre, [order], consome, consome === 0 ? 1 : 0, capacidade));
        continue;
      }
    }
    unassigned.push({
      order_id: order.id, tracking_code: order.tracking_code,
      reason: 'não coube em nenhum veículo disponível',
    });
  }

  // 4. O que sobrou com coordenadas.
  for (const id of porAtribuir) {
    const order = porId.get(id);
    unassigned.push({
      order_id: order.id, tracking_code: order.tracking_code,
      reason: 'não coube em nenhum veículo disponível',
    });
  }

  return { routes, unassigned, summary: resumo(routes, unassigned, candidatas.length) };
}

/** @returns {object} Uma parada do plano. PURA. */
function paradaDe(order, geolocalizada) {
  const c = orderCoords(order);
  return {
    order_id:      order.id,
    tracking_code: order.tracking_code,
    address:       order.destination?.city ?? 'Destino',
    lat:           c?.lat,
    lng:           c?.lng,
    weight_grams:  Number.isFinite(Number(order.weight_grams)) ? Number(order.weight_grams) : null,
    // Diz se entrou pelo agrupamento geográfico ou só por capacidade — quem
    // revê o plano precisa de saber onde a proposta é mais fraca.
    geolocated:    geolocalizada,
  };
}

/** @returns {object} Uma rota proposta. PURA. */
function montarRota(driver, orders, loadGrams, unknownWeight, capacityGrams) {
  return {
    driver_id:      driver.id,
    driver_name:    driver.name,
    vehicle_modal:  driver.vehicle?.type,
    capacity_grams: capacityGrams,
    capacity_kg:    capacityGrams / 1000,
    load_grams:     loadGrams,
    load_kg:        loadGrams / 1000,
    unknown_weight: unknownWeight,
    stops:          orders.map((o) => paradaDe(o, Boolean(orderCoords(o)))),
  };
}

/** @returns {object} Contagens do plano. PURA. */
function resumo(routes, unassigned, elegiveis) {
  return {
    eligible_orders: elegiveis,
    planned_orders:  routes.reduce((n, r) => n + r.stops.length, 0),
    unassigned:      unassigned.length,
    drivers_used:    routes.length,
  };
}

/**
 * Carrega o estado real e planeia (§ 3.38).
 *
 * A parte que decide é `planDispatch`, pura. Isto é só a ida à base: carrega as
 * encomendas prontas e os motoristas, e entrega-lhas. Manter a fronteira é o que
 * permite afirmar as regras de distribuição num teste sem montar nada.
 *
 * @param {{ warehouse_id?: string, origin?: {lat:number,lng:number}, limit?: number }} [opts]
 * @returns {Promise<object>}
 */
async function planAutomaticDispatch(opts = {}) {
  // Uma página generosa: um dia de despacho de uma transportadora média cabe
  // aqui, e o teto impede que um pedido sem filtro puxe a tabela inteira.
  const limite = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);

  const { items } = await OrderRepository.list({
    warehouse_id: opts.warehouse_id,
    limit: limite,
    offset: 0,
  });

  const drivers = await DriverRepository.findAll();
  const plano = planDispatch(items, drivers, { origin: opts.origin });

  console.info(
    `[dispatch] Plano automático: ${plano.summary.planned_orders} encomenda(s) `
    + `em ${plano.summary.drivers_used} rota(s); ${plano.summary.unassigned} por atribuir.`,
  );
  return plano;
}

module.exports = {
  assertRouteFitsDriver,
  assignRouteOrders,
  summarizeStopLoad,
  driverCapacity,
  // Despacho automático (§ 3.38) — puros
  planDispatch,
  orderEligibility,
  orderCoords,
  DISPATCHABLE_STATUSES,
  // Despacho automático — caso de uso
  planAutomaticDispatch,
  DispatchError,
};
