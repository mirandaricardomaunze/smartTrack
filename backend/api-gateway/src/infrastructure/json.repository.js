/**
 * @file json.repository.js
 * @description Camada de acesso a dados — persistência em database.json.
 *
 * Single Responsibility: ÚNICO arquivo que lê/escreve o database.json.
 * Nenhum outro módulo deve acessar o arquivo diretamente.
 *
 * Arquitetura: implementa o padrão Repository Pattern.
 * Quando migrar para PostgreSQL, substituir apenas este arquivo.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database.json');

// ─── Posições GPS demo para dados iniciais ─────────────────────────────────
const DEMO_GPS = [
  { lat: -23.5505, lng: -46.6333, heading: 45,  speed: 35, updatedAt: new Date().toISOString() },
  { lat: -23.5629, lng: -46.6544, heading: 120, speed: 0,  updatedAt: new Date().toISOString() },
  { lat: -23.5489, lng: -46.6388, heading: 270, speed: 28, updatedAt: new Date().toISOString() },
];

/** @returns {import('../domain/entities/order.entity').Order[]} */
function buildInitialOrders() {
  const now  = new Date().toISOString();
  const h1   = new Date(Date.now() - 3_600_000).toISOString();
  const h2   = new Date(Date.now() - 7_200_000).toISOString();
  const d1   = new Date(Date.now() - 86_400_000).toISOString();
  const d2   = new Date(Date.now() - 172_800_000).toISOString();
  const d7   = new Date(Date.now() - 604_800_000).toISOString();

  return [
    {
      id:              'order-test-uuid-0001',
      cliente_id:      'Carlos Silva',
      codigo_rastreio: 'TRK00000001BR',
      status_atual:    'em_transito',   // OrderStatus.IN_TRANSIT
      origem:          { cidade: 'São Paulo',   estado: 'SP', pais: 'BR' },
      destino:         { cidade: 'São Paulo',   estado: 'SP', pais: 'BR' },
      motorista_id:    'driver-test-uuid-0001',
      valor:           2990,
      historico: [
        { status: 'em_transito', descricao: 'Encomenda em transferência entre filiais',    localizacao: 'São Paulo - SP', timestamp: now },
        { status: 'coletado',    descricao: 'Encomenda coletada pela equipe de logística', localizacao: 'São Paulo - SP', timestamp: h1 },
        { status: 'criado',      descricao: 'Pedido registrado no sistema',                localizacao: 'São Paulo - SP', timestamp: h2 },
      ],
      criado_em:     h2,
      atualizado_em: now,
    },
    {
      id:              'order-test-uuid-0002',
      cliente_id:      'Ana Oliveira',
      codigo_rastreio: 'LX987654321CN',
      status_atual:    'no_armazem',    // OrderStatus.AT_WAREHOUSE
      origem:          { cidade: 'Shenzhen', estado: 'GD', pais: 'CN' },
      destino:         { cidade: 'Rio de Janeiro', estado: 'RJ', pais: 'BR' },
      transportadora_intl_id: '17TRACK',
      motorista_id:    'driver-test-uuid-0002',
      valor:           8990,
      historico: [
        { status: 'no_armazem',             descricao: 'Recebida no hub nacional de triagem',         localizacao: 'Curitiba - PR',              timestamp: now },
        { status: 'em_transito',            descricao: 'Liberado pela Receita Federal do Brasil',     localizacao: 'Aeroporto de Guarulhos - SP', timestamp: d1 },
        { status: 'em_transito',            descricao: 'Encomenda em trânsito rumo ao Brasil',        localizacao: 'Hong Kong',                  timestamp: d2 },
        { status: 'criado',                 descricao: 'Pedido despachado pelo remetente',             localizacao: 'Shenzhen - China',            timestamp: d7 },
      ],
      criado_em:     d7,
      atualizado_em: now,
    },
  ];
}

/** @returns {import('../domain/entities/driver.entity').Driver[]} */
function buildInitialDrivers() {
  const now = new Date().toISOString();
  return [
    {
      id:           'driver-test-uuid-0001',
      nome:         'Marcos Souza',
      email:        'marcos.souza@test.com',
      telefone:     '+5511999990001',
      veiculo:      { tipo: 'MOTO', placa: 'TST-1234', capacidade_kg: 20 },
      status_atual: 'EM_ROTA',
      metricas_desempenho: { pontualidade: 96, taxa_sucesso: 98,  nota_media_cliente: 4.9, total_entregas: 142 },
      gps:          DEMO_GPS[0],
      criado_em:    now,
    },
    {
      id:           'driver-test-uuid-0002',
      nome:         'Pedro Santos',
      email:        'pedro.santos@test.com',
      telefone:     '+5511999990002',
      veiculo:      { tipo: 'VAN', placa: 'TST-5678', capacidade_kg: 500 },
      status_atual: 'DISPONIVEL',
      metricas_desempenho: { pontualidade: 92, taxa_sucesso: 95,  nota_media_cliente: 4.7, total_entregas: 88 },
      gps:          DEMO_GPS[1],
      criado_em:    now,
    },
    {
      id:           'driver-test-uuid-0003',
      nome:         'Lucas Lima',
      email:        'lucas.lima@test.com',
      telefone:     '+5511999990003',
      veiculo:      { tipo: 'CARRO', placa: 'TST-9012', capacidade_kg: 150 },
      status_atual: 'DISPONIVEL',
      metricas_desempenho: { pontualidade: 98, taxa_sucesso: 100, nota_media_cliente: 5.0, total_entregas: 210 },
      gps:          DEMO_GPS[2],
      criado_em:    now,
    },
  ];
}

/** @typedef {{ orders: object[], drivers: object[], routes: object[] }} Database */

/**
 * Lê o banco de dados do disco.
 * Se não existir ou estiver corrompido, cria e persiste dados iniciais.
 * @returns {Database}
 */
function loadDatabase() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw  = fs.readFileSync(DB_PATH, 'utf-8');
      const data = JSON.parse(raw);

      // Garante que motoristas tenham campo gps (migração progressiva)
      data.drivers = (data.drivers ?? []).map((/** @type {object} */ d, /** @type {number} */ i) => ({
        gps: DEMO_GPS[i % DEMO_GPS.length],
        ...d,
      }));

      return data;
    } catch (err) {
      console.error('[json.repository] Banco corrompido — recriando:', err);
    }
  }

  const initialData = {
    orders:  buildInitialOrders(),
    drivers: buildInitialDrivers(),
    routes:  [
      {
        id:           'ROT001',
        motorista_id: 'driver-test-uuid-0001',
        motorista:    'Marcos Souza',
        veiculo:      'Moto (Honda Cargo)',
        totalParadas: 12,
        entregues:    5,
        status:       'em_andamento',
        otimizadaEm:  new Date().toISOString(),
      },
    ],
  };

  fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2), 'utf-8');
  console.info('[json.repository] Banco inicializado com dados de demonstração.');
  return initialData;
}

/** @type {Database} — singleton em memória durante o processo */
const _db = loadDatabase();

/**
 * Persiste o estado atual do banco em disco.
 * Chamado após cada mutação.
 */
function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(_db, null, 2), 'utf-8');
}

// ─── API pública do Repository ──────────────────────────────────────────────

const OrderRepository = {
  /** @returns {object[]} */
  findAll() {
    return _db.orders;
  },

  /**
   * @param {string} codigoRastreio
   * @returns {object | undefined}
   */
  findByCode(codigoRastreio) {
    return _db.orders.find((o) => o.codigo_rastreio === codigoRastreio);
  },

  /**
   * @param {string} id
   * @returns {object | undefined}
   */
  findById(id) {
    return _db.orders.find((o) => o.id === id);
  },

  /**
   * Insere um novo pedido no início da lista (mais recentes primeiro).
   * @param {object} order
   */
  create(order) {
    _db.orders.unshift(order);
    save();
    return order;
  },

  /**
   * Substitui um pedido pelo `id`.
   * @param {object} order
   */
  update(order) {
    const idx = _db.orders.findIndex((o) => o.id === order.id);
    if (idx !== -1) {
      _db.orders[idx] = order;
      save();
    }
  },
};

const DriverRepository = {
  /** @returns {object[]} */
  findAll() {
    return _db.drivers;
  },

  /**
   * @param {string} id
   * @returns {object | undefined}
   */
  findById(id) {
    return _db.drivers.find((d) => d.id === id);
  },

  /**
   * @param {object} driver
   */
  update(driver) {
    const idx = _db.drivers.findIndex((d) => d.id === driver.id);
    if (idx !== -1) {
      _db.drivers[idx] = driver;
      save();
    }
  },
};

module.exports = { OrderRepository, DriverRepository };
