/**
 * @file delivery-journey.ts — condutor do percurso operacional completo
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.34 (Prontidão de produção)
 *
 * PORQUÊ EXISTE: até aqui cada troço do percurso tinha o seu teste — POD,
 * armazém, rotas, acerto de COD — e todos passavam. O que ninguém corria era a
 * encomenda a atravessar os troços **pela mesma ordem por que atravessa na
 * operação**, e foi exatamente na junta entre dois deles que apareceu o defeito:
 * criar a rota gravava as paradas mas não escrevia o motorista no pedido, pelo
 * que a aplicação do motorista recebia 403 em tudo o que tentasse fazer a
 * seguir. Um teste por troço nunca apanha isso; um percurso apanha.
 *
 * COMO SE USA: os módulos do backend são injetados, não importados. Este
 * ficheiro não sabe qual é a base de dados nem em que ordem as variáveis de
 * ambiente têm de ser definidas — quem o usa é que resolve isso antes (ver a
 * nota em tests/integration/helpers/pg-env.js). Assim o condutor serve tanto a
 * base real como um duplo em memória.
 *
 *   const jornada = new DeliveryJourney({ orders, routes, dispatch }, { ... });
 *   await jornada.criar();
 *   await jornada.recolher();
 *   ...
 *   expect(jornada.trilho).toEqual([...]);
 */

/** Módulos do backend de que o percurso depende. */
export interface JourneyServices {
  /** backend/api-gateway/src/application/orders.service */
  orders: any;
  /** backend/routes-service/src/application/routes.service */
  routes: any;
  /** backend/api-gateway/src/application/dispatch.service */
  dispatch: any;
}

export interface JourneyOptions {
  /** Código de rastreio da encomenda. Nacional (sem prefixo internacional). */
  trackingCode: string;
  /** Identificação do cliente remetente, como chega do painel. */
  client: string;
  /** Cidade de destino. */
  destination: string;
  /** Motorista que vai fazer a rota. Tem de existir na base. */
  driverId: string;
  /** Morada da parada na rota. */
  address: string;
  /** Peso do volume em gramas — é o que a verificação de carga usa. */
  weightGrams?: number;
  /** Valor a cobrar na entrega, em centavos. 0 = sem cobrança. */
  codAmountCents?: number;
}

/** Um passo dado, na ordem em que foi dado. */
export interface JourneyStep {
  /** Nome do passo: `criar`, `recolher`, … */
  passo: string;
  /** Estado da encomenda depois do passo. */
  estado: string;
  /** Momento em que o passo terminou. */
  at: string;
}

export class DeliveryJourney {
  private readonly svc: JourneyServices;
  private readonly opts: JourneyOptions;

  /** A encomenda tal como o último passo a devolveu. */
  order: any = null;
  /** A rota criada no despacho. */
  route: any = null;
  /** O que o despacho atribuiu e o que recusou atribuir. */
  assignment: { assigned: string[]; skipped: string[] } | null = null;

  private readonly passos: JourneyStep[] = [];

  constructor(services: JourneyServices, options: JourneyOptions) {
    this.svc  = services;
    this.opts = options;
  }

  /** Os estados por que a encomenda passou, na ordem. */
  get trilho(): string[] {
    return this.passos.map((p) => p.estado);
  }

  /** O registo completo dos passos — para uma falha dizer onde parou. */
  get historico(): JourneyStep[] {
    return [...this.passos];
  }

  private registar(passo: string, estado: string): void {
    this.passos.push({ passo, estado, at: new Date().toISOString() });
  }

  /** 1. O cliente regista o envio. */
  async criar(): Promise<any> {
    this.order = await this.svc.orders.createOrder({
      tracking_code: this.opts.trackingCode,
      client:        this.opts.client,
      destination:   this.opts.destination,
      weight_grams:  this.opts.weightGrams,
      cod_amount:    this.opts.codAmountCents ?? 0,
    });
    this.registar('criar', this.order.current_status);
    return this.order;
  }

  /** 2. A encomenda é recolhida no remetente. */
  async recolher(): Promise<any> {
    this.order = await this.svc.orders.updateOrderStatus(this.order.id, {
      new_status: 'collected',
      location:   this.opts.address,
      notes:      'Recolhido no remetente',
    });
    this.registar('recolher', this.order.current_status);
    return this.order;
  }

  /**
   * 3. Despacho: verifica a carga, monta a rota e atribui a encomenda.
   *
   * Não avança o estado da encomenda de propósito — despachar é atribuir, não
   * transportar. O estado muda no passo seguinte, quando o veículo sai.
   */
  async despachar(): Promise<any> {
    await this.svc.dispatch.assertRouteFitsDriver(this.opts.driverId, [{ order_id: this.order.id }]);

    this.route = await this.svc.routes.createRoute({
      driver_id: this.opts.driverId,
      stops: [{ order_id: this.order.id, address: this.opts.address }],
    });
    this.assignment = await this.svc.dispatch.assignRouteOrders(this.route);

    // Reler: quem confirma a atribuição é a base, não o retorno do despacho.
    // `getOrderTracking` e não `getDriverOrder` — este devolve a projeção
    // reduzida que a aplicação do motorista consome, sem `driver_id`.
    this.order = await this.svc.orders.getOrderTracking(this.opts.trackingCode);
    this.registar('despachar', this.order.current_status);
    return this.route;
  }

  /** 4. O veículo sai com a carga. */
  async transportar(): Promise<any> {
    this.order = await this.svc.orders.updateOrderStatus(this.order.id, {
      new_status: 'in_transit',
      location:   this.opts.address,
      user_id:    this.opts.driverId,
      event_origin: 'DRIVER_APP',
    });
    this.registar('transportar', this.order.current_status);
    return this.order;
  }

  /** 5. Última perna: a encomenda sai para o destinatário. */
  async sairParaEntrega(): Promise<any> {
    this.order = await this.svc.orders.updateOrderStatus(this.order.id, {
      new_status: 'out_for_delivery',
      location:   this.opts.destination,
      user_id:    this.opts.driverId,
      event_origin: 'DRIVER_APP',
    });
    this.registar('sairParaEntrega', this.order.current_status);
    return this.order;
  }

  /**
   * 6. Entrega com comprovativo.
   * @param pod Assinatura, foto, nome de quem recebeu e coordenadas.
   */
  async entregar(pod: {
    recipient_name: string;
    signature?: string;
    photo?: string;
    lat?: number;
    lng?: number;
    cod_method?: string;
  }): Promise<any> {
    this.order = await this.svc.orders.deliverOrder(this.order.id, {
      ...pod,
      user_id: this.opts.driverId,
    });
    this.registar('entregar', this.order.current_status);
    return this.order;
  }

  /**
   * 7. A prova apresentada ao cliente: o que ele vê ao consultar o código.
   *
   * Devolve o que o portal do cliente mostra e as imagens em separado — é assim
   * que a API as serve (§ 3.28), e é isso que se quer provar.
   */
  async provaDeEntrega(): Promise<{ rastreio: any; imagens: any }> {
    const rastreio = await this.svc.orders.getOrderTracking(this.opts.trackingCode);
    const imagens  = await this.svc.orders.getPodImagesByCode(this.opts.trackingCode);
    this.registar('provaDeEntrega', rastreio.current_status);
    return { rastreio, imagens };
  }
}
