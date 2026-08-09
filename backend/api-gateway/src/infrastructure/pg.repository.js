/**
 * @file pg.repository.js
 * @description Camada de acesso a dados — persistência em PostgreSQL (em Inglês).
 *
 * Single Responsibility: ÚNICO arquivo que faz queries no banco.
 *
 * Arquitetura: Repository Pattern.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Stack — PostgreSQL 15+)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.3 (timestamps UTC — timestamptz)
 */
'use strict';

const pool = require('./db');
const { readCompanyId, writeCompanyId } = require('./tenant-context');

// ─── Multiempresa (spec § 2.4) ────────────────────────────────────────────────
// `readCompanyId()` devolve a empresa a filtrar (ou undefined = sem filtro:
// testes/tarefas de fundo/SUPERADMIN/rotas públicas). `writeCompanyId()` devolve
// a empresa a gravar (a do contexto, ou a Empresa Padrão).

/** Anexa `AND company_id = $n` a um WHERE quando há empresa no contexto. */
function companyClause(params, table = '') {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  const col = table ? `${table}.company_id` : 'company_id';
  return ` AND ${col} = $${params.length}`;
}

/** Devolve ` WHERE company_id = $n` (ou '') para queries sem outro WHERE. */
function companyWhere(params, table = '') {
  const cid = readCompanyId();
  if (!cid) return '';
  params.push(cid);
  const col = table ? `${table}.company_id` : 'company_id';
  return ` WHERE ${col} = $${params.length}`;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Mapeia uma row do PostgreSQL → shape de Order compatível.
 * @param {object} row
 * @returns {object}
 */
function rowToOrder(row) {
  return {
    id:              row.id,
    client_id:       row.client_id,
    company_id:      row.company_id ?? undefined,
    client_ref_id:   row.client_ref_id ?? undefined,
    client_phone:    row.client_phone ?? undefined,
    client_email:    row.client_email ?? undefined,
    tracking_code:   row.tracking_code,
    current_status:  row.current_status,
    origin:          row.origin,
    destination:     row.destination,
    carrier_intl_id: row.carrier_intl_id ?? undefined,
    driver_id:       row.driver_id ?? undefined,
    route_id:        row.route_id ?? undefined,
    warehouse_id:    row.warehouse_id ?? undefined,
    pod:             row.pod ?? undefined,
    delivery_otp:    row.delivery_otp ?? undefined,
    cod_amount:      row.cod_amount ?? 0,
    cod_status:      row.cod_status ?? 'none',
    cod:             row.cod ?? undefined,
    cod_settlement_id: row.cod_settlement_id ?? undefined,
    weight_grams:    row.weight_grams ?? undefined,
    pricing:         row.pricing ?? undefined,
    value:           row.value,
    history:         row.history ?? [],
    created_at:      row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    updated_at:      row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at,
  };
}

/**
 * Mapeia uma row do PostgreSQL → shape de Driver.
 * @param {object} row
 * @returns {object}
 */
function rowToDriver(row) {
  return {
    id:                  row.id,
    name:                row.name,
    email:               row.email,
    phone:               row.phone,
    vehicle:             row.vehicle,
    current_status:      row.current_status,
    performance_metrics: row.performance_metrics,
    gps:                 row.gps ?? undefined,
    created_at:          row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
  };
}

// ─── POD: imagens fora da linha do pedido (spec § 3.28) ──────────────────────
// A assinatura e a foto chegam a 2,2 MB cada. Guardadas em `orders.pod`, iam a
// reboque de cada `SELECT *` — e todas as listagens fazem `SELECT *`. Ficam numa
// tabela à parte, carregadas só quando alguém abre o detalhe da entrega.

const POD_IMAGE_KEYS = ['signature', 'photo'];

/**
 * Separa o POD em metadados (ficam no pedido) e imagens (vão para a tabela própria).
 *
 * Quando o POD chega sem imagens — o caso de qualquer atualização de estado sobre
 * um pedido já entregue — os sinalizadores existentes são preservados e as imagens
 * guardadas não são tocadas. Sem isso, uma mudança de estado apagava a prova.
 *
 * @param {object | null | undefined} pod
 * @returns {{ meta: object | null, images: { signature?: string, photo?: string } | null }}
 */
function splitPod(pod) {
  if (!pod || typeof pod !== 'object') return { meta: null, images: null };

  const meta = { ...pod };
  const images = {};
  for (const key of POD_IMAGE_KEYS) {
    const value = meta[key];
    delete meta[key];
    if (typeof value === 'string' && value) images[key] = value;
  }

  meta.has_signature = images.signature ? true : Boolean(pod.has_signature);
  meta.has_photo     = images.photo     ? true : Boolean(pod.has_photo);

  return { meta, images: Object.keys(images).length ? images : null };
}

/**
 * Grava as imagens do POD. Só é chamada quando há imagens novas — uma atualização
 * de metadados não reescreve megabytes.
 * @param {import('pg').PoolClient | import('pg').Pool} executor
 */
async function upsertPodImages(executor, orderId, images) {
  await executor.query(`
    INSERT INTO order_pod_images (order_id, signature, photo, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (order_id) DO UPDATE SET
      signature  = COALESCE(EXCLUDED.signature, order_pod_images.signature),
      photo      = COALESCE(EXCLUDED.photo,     order_pod_images.photo),
      updated_at = NOW()
  `, [orderId, images.signature ?? null, images.photo ?? null]);
}

/**
 * Corre `fn` dentro de uma transação. Se já vier um executor de transação, usa-o
 * — quem abriu a transação é que a fecha.
 * @template T
 * @param {import('pg').PoolClient | import('pg').Pool} executor
 * @param {(executor: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function inTransaction(executor, fn) {
  if (executor !== pool) return fn(executor);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── OrderRepository ─────────────────────────────────────────────────────────

const OrderRepository = {
  /**
   * Lista todos os pedidos, mais recentes primeiro.
   *
   * ATENÇÃO: sem teto. Só deve ser usada onde o conjunto é sabidamente pequeno
   * ou já limitado por outro critério — uma empresa com dezenas de milhares de
   * pedidos traz tudo para memória. Para listagens de ecrã use `list()`, para
   * janelas temporais use `listSince()`.
   * @returns {Promise<object[]>}
   */
  async findAll() {
    const params = [];
    const { rows } = await pool.query(
      `SELECT * FROM orders${companyWhere(params)} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(rowToOrder);
  },

  /**
   * Lista paginada e filtrada — a que serve os ecrãs (spec § 3.1).
   *
   * Os filtros são resolvidos em SQL, e não em JavaScript depois de trazer tudo:
   * é a diferença entre uma página que abre com 50 mil pedidos e uma que não.
   *
   * @param {{ status?: string, driver_id?: string, warehouse_id?: string, cod_status?: string, from?: string, to?: string, search?: string, limit?: number, offset?: number }} [opts]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async list(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`current_status = $${params.length}`); }
    if (opts.driver_id) { params.push(opts.driver_id); clauses.push(`driver_id = $${params.length}`); }
    if (opts.warehouse_id) { params.push(opts.warehouse_id); clauses.push(`warehouse_id = $${params.length}`); }
    if (opts.cod_status) { params.push(opts.cod_status); clauses.push(`cod_status = $${params.length}`); }
    if (opts.from) { params.push(opts.from); clauses.push(`created_at >= $${params.length}`); }
    if (opts.to) { params.push(opts.to); clauses.push(`created_at < $${params.length}`); }
    if (opts.search) {
      params.push(`%${String(opts.search).toLowerCase()}%`);
      const p = `$${params.length}`;
      clauses.push(`(lower(tracking_code) LIKE ${p} OR lower(client_id) LIKE ${p} OR lower(coalesce(destination->>'city','')) LIKE ${p})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = Number((await pool.query(`SELECT COUNT(*) AS total FROM orders ${where}`, params)).rows[0].total);
    const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const { rows } = await pool.query(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map(rowToOrder), total };
  },

  /**
   * Pedidos criados a partir de uma data — janela dos relatórios.
   * O teto existe para um período muito largo não repetir o problema que a
   * paginação veio resolver.
   * @param {string} fromIso
   * @param {number} [max]
   */
  async listSince(fromIso, max = 20_000) {
    const params = [fromIso];
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE created_at >= $1${companyClause(params)} ORDER BY created_at DESC LIMIT ${Number(max) || 20_000}`,
      params,
    );
    return rows.map(rowToOrder);
  },

  /**
   * Rastreio PÚBLICO por código — GLOBAL (sem filtro de empresa). Os códigos são
   * únicos em toda a plataforma; a empresa é derivada do pedido encontrado.
   * @param {string} trackingCode
   * @returns {Promise<object | undefined>}
   */
  async findByCode(trackingCode, executor = pool) {
    const { rows } = await executor.query(
      'SELECT * FROM orders WHERE tracking_code = $1 LIMIT 1',
      [trackingCode],
    );
    return rows.length ? rowToOrder(rows[0]) : undefined;
  },

  /**
   * @param {string} id
   * @returns {Promise<object | undefined>}
   */
  async findById(id, executor = pool) {
    const params = [id];
    const { rows } = await executor.query(
      `SELECT * FROM orders WHERE id = $1${companyClause(params)} LIMIT 1`,
      params,
    );
    return rows.length ? rowToOrder(rows[0]) : undefined;
  },

  /**
   * Vários pedidos por id, numa consulta só.
   *
   * O despacho (§ 3.33) precisa do peso de todas as paradas antes de montar a
   * rota; uma rota de trinta paradas não pode custar trinta idas à base.
   * Ids desconhecidos são simplesmente omitidos do resultado.
   *
   * @param {string[]} ids
   * @returns {Promise<Map<string, object>>}
   */
  async findManyByIds(ids) {
    const unique = [...new Set((ids ?? []).filter(Boolean))];
    if (unique.length === 0) return new Map();

    const params = [unique];
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE id = ANY($1::text[])${companyClause(params)}`,
      params,
    );
    return new Map(rows.map((row) => [row.id, rowToOrder(row)]));
  },

  /**
   * Liga um conjunto de pedidos ao motorista e à rota que os vai levar.
   *
   * PORQUÊ UMA ESCRITA PRÓPRIA e não `update()`: `update()` reescreve a linha
   * inteira a partir de um objeto em memória. Aqui mexem-se dois campos em
   * várias linhas ao mesmo tempo, e ler-modificar-gravar cada pedido abria uma
   * janela para desfazer o que a app do motorista tivesse acabado de gravar.
   *
   * Só atualiza pedidos que ainda não estão fechados: uma rota reotimizada não
   * pode reatribuir uma encomenda já entregue ou cancelada.
   *
   * @param {string[]} orderIds
   * @param {{ driver_id: string, route_id: string }} assignment
   * @returns {Promise<string[]>} Ids efetivamente atualizados.
   */
  async assignToRoute(orderIds, assignment) {
    const unique = [...new Set((orderIds ?? []).filter(Boolean))];
    if (unique.length === 0) return [];

    const params = [assignment.driver_id, assignment.route_id, unique];
    const { rows } = await pool.query(`
      UPDATE orders
         SET driver_id  = $1,
             route_id   = $2,
             updated_at = NOW()
       WHERE id = ANY($3::text[])
         AND current_status NOT IN ('delivered', 'cancelled')${companyClause(params)}
      RETURNING id
    `, params);
    return rows.map((row) => row.id);
  },

  /**
   * Pedidos ligados a um cliente (histórico), mais recentes primeiro.
   * @param {string} clientRefId
   * @returns {Promise<object[]>}
   */
  async findByClientRef(clientRefId) {
    const params = [clientRefId];
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE client_ref_id = $1${companyClause(params)} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(rowToOrder);
  },

  /**
   * Conta pedidos por status — usado pelo hook useSidebarStats.
   * Endpoint: GET /v1/orders/stats
   * @returns {Promise<{ pending: number; failed: number; active: number }>}
   */
  /**
   * Contadores agregados. Calculados em SQL de propósito: os cartões do topo da
   * página não podem depender de trazer os pedidos todos para os contar.
   */
  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE current_status = 'created')    AS pending,
        COUNT(*) FILTER (WHERE current_status = 'failed')     AS failed,
        COUNT(*) FILTER (WHERE current_status NOT IN ('delivered','cancelled')) AS active,
        COUNT(*) FILTER (WHERE current_status IN ('in_transit','out_for_delivery')) AS in_transit,
        COUNT(*) FILTER (WHERE current_status = 'awaiting_destination') AS awaiting_destination,
        COUNT(*) FILTER (WHERE current_status = 'delivered')   AS delivered
      FROM orders${companyWhere(params)}
    `, params);
    const r = rows[0];
    const delivered = Number(r.delivered);
    const failed = Number(r.failed);
    const finished = delivered + failed;
    return {
      total:   Number(r.total),
      pending: Number(r.pending),
      failed,
      active:  Number(r.active),
      in_transit: Number(r.in_transit),
      awaiting_destination: Number(r.awaiting_destination),
      delivered,
      // Sobre o que já terminou — uma taxa sobre pedidos ainda em curso não diz nada.
      success_rate_pct: finished > 0 ? Math.round((delivered / finished) * 100) : 0,
    };
  },

  /**
   * Insere um novo pedido.
   * @param {object} order
   * @returns {Promise<object>}
   */
  async create(order) {
    const { meta: podMeta, images: podImages } = splitPod(order.pod);
    if (podImages) {
      return inTransaction(pool, async (tx) => {
        const created = await insertOrder(tx, order, podMeta);
        await upsertPodImages(tx, order.id, podImages);
        return created;
      });
    }
    return insertOrder(pool, order, podMeta);
  },

  /**
   * Imagens do comprovativo, carregadas à parte (spec § 3.28).
   *
   * NÃO faz controlo de acesso — quem chama tem de ter confirmado antes, por
   * `findById` ou `findByCode`, que o pedido é visível a quem pergunta.
   *
   * @param {string} orderId
   * @returns {Promise<{ signature?: string, photo?: string }>}
   */
  async findPodImages(orderId, executor = pool) {
    const { rows } = await executor.query(
      'SELECT signature, photo FROM order_pod_images WHERE order_id = $1 LIMIT 1',
      [orderId],
    );
    if (!rows.length) return {};
    return {
      signature: rows[0].signature ?? undefined,
      photo:     rows[0].photo ?? undefined,
    };
  },

  /**
   * Atualiza um pedido existente.
   * @param {object} order
   * @returns {Promise<void>}
   */
  async update(order, executor = pool) {
    const { meta: podMeta, images: podImages } = splitPod(order.pod);
    if (podImages) {
      return inTransaction(executor, async (tx) => {
        await updateOrderRow(tx, order, podMeta);
        await upsertPodImages(tx, order.id, podImages);
      });
    }
    return updateOrderRow(executor, order, podMeta);
  },
};

/**
 * INSERT cru do pedido. Separado de `create` para o caminho com imagens poder
 * reutilizá-lo dentro da transação.
 * @param {import('pg').PoolClient | import('pg').Pool} executor
 */
async function insertOrder(executor, order, podMeta) {
  const { rows } = await executor.query(`
      INSERT INTO orders (
        id, client_id, client_phone, client_email, tracking_code, current_status,
        origin, destination, carrier_intl_id, driver_id, route_id, warehouse_id,
        pod, delivery_otp, cod_amount, cod_status, cod, cod_settlement_id,
        value, history, created_at, updated_at, client_ref_id, weight_grams, pricing, company_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      RETURNING *
    `, [
    order.id,
    order.client_id,
    order.client_phone ?? null,
    order.client_email ?? null,
    order.tracking_code,
    order.current_status,
    JSON.stringify(order.origin),
    JSON.stringify(order.destination),
    order.carrier_intl_id ?? null,
    order.driver_id ?? null,
    order.route_id ?? null,
    order.warehouse_id ?? null,
    podMeta ? JSON.stringify(podMeta) : null,
    order.delivery_otp ? JSON.stringify(order.delivery_otp) : null,
    order.cod_amount ?? 0,
    order.cod_status ?? 'none',
    order.cod ? JSON.stringify(order.cod) : null,
    order.cod_settlement_id ?? null,
    order.value,
    JSON.stringify(order.history ?? []),
    order.created_at,
    order.updated_at,
    order.client_ref_id ?? null,
    order.weight_grams ?? null,
    order.pricing ? JSON.stringify(order.pricing) : null,
    order.company_id ?? writeCompanyId(),
  ]);
  return rowToOrder(rows[0]);
}

/**
 * UPDATE cru do pedido, já com o POD sem imagens.
 * @param {import('pg').PoolClient | import('pg').Pool} executor
 */
async function updateOrderRow(executor, order, podMeta) {
  const params = [
    order.current_status,
    order.driver_id ?? null,
    order.route_id ?? null,
    order.warehouse_id ?? null,
    podMeta ? JSON.stringify(podMeta) : null,
    order.delivery_otp ? JSON.stringify(order.delivery_otp) : null,
    order.cod_amount ?? 0,
    order.cod_status ?? 'none',
    order.cod ? JSON.stringify(order.cod) : null,
    order.cod_settlement_id ?? null,
    JSON.stringify(order.destination ?? {}),
    JSON.stringify(order.history ?? []),
    order.updated_at,
    order.id,
  ];
  await executor.query(`
    UPDATE orders SET
      current_status    = $1,
      driver_id         = $2,
      route_id          = $3,
      warehouse_id      = $4,
      pod               = $5,
      delivery_otp      = $6,
      cod_amount        = $7,
      cod_status        = $8,
      cod               = $9,
      cod_settlement_id = $10,
      destination       = $11,
      history           = $12,
      updated_at        = $13
    WHERE id = $14${companyClause(params)}
  `, params);
}

// ─── UserRepository ──────────────────────────────────────────────────────────

/**
 * Mapeia uma row → shape de User (sem expor o hash da senha).
 * @param {object} row
 * @returns {object}
 */
function rowToUser(row) {
  return {
    id:         row.id,
    name:       row.name,
    email:      row.email,
    role:       row.role,
    company_id: row.company_id ?? undefined,
    // Bases anteriores à § 3.32 podem devolver a coluna vazia numa leitura que
    // não passou pelo `ensureTable` — uma conta sem estado é uma conta ativa.
    status:     row.status ?? 'active',
    blocked_at: toIso(row.blocked_at),
    created_at: toIso(row.created_at),
  };
}

/** Data → ISO, tolerante a string e a nulo. */
function toIso(value) {
  return value instanceof Date ? value.toISOString() : (value ?? undefined);
}

const UserRepository = {
  /**
   * Cria a tabela `users` se ainda não existir (idempotente).
   * Chamado no arranque para não depender de re-migração destrutiva.
   * @returns {Promise<void>}
   */
  async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT        PRIMARY KEY,
        name          TEXT        NOT NULL,
        email         TEXT        NOT NULL UNIQUE,
        password_hash TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'ADMIN',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Multiempresa (spec § 2.4): email continua identidade GLOBAL; a empresa do
    // utilizador vem daqui. SUPERADMIN tem company_id NULL (acesso à plataforma).
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id TEXT;`);
    await pool.query(`ALTER TABLE users ALTER COLUMN company_id DROP NOT NULL;`);
    // Estado de acesso (spec § 3.32). Repetido aqui, e não só na migração, para
    // que uma base antiga ganhe a coluna no arranque — o login lê-a em todas as
    // autenticações e uma coluna em falta seria um erro 500 na porta de entrada.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  },

  /**
   * Procura um utilizador por email. Devolve o hash da senha (uso interno de auth).
   * @param {string} email
   * @returns {Promise<object | undefined>} row com password_hash, ou undefined
   */
  async findByEmailWithHash(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [email],
    );
    return rows.length ? rows[0] : undefined;
  },

  /**
   * Insere um novo utilizador.
   * @param {{ id: string; name: string; email: string; password_hash: string; role: string }} user
   * @returns {Promise<object>} User público (sem hash)
   */
  async create(user) {
    const { rows } = await pool.query(`
      INSERT INTO users (id, name, email, password_hash, role, company_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [user.id, user.name, user.email, user.password_hash, user.role, user.company_id ?? null]);
    return rowToUser(rows[0]);
  },

  // ── Contas e acessos (spec § 3.32) ─────────────────────────────────────────
  // Todas as leituras e escritas abaixo passam pelo filtro da empresa em
  // contexto: um ADMIN da empresa A não vê nem mexe nas contas da empresa B.
  // Sem empresa em contexto (SUPERADMIN, testes) não há filtro, como no resto.

  /**
   * Contas da empresa em contexto. Nunca devolve o hash da senha.
   * @returns {Promise<object[]>}
   */
  async list() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT * FROM users${companyWhere(params)}
      ORDER BY role, name
    `, params);
    return rows.map(rowToUser);
  },

  /**
   * @param {string} id
   * @returns {Promise<object | undefined>}
   */
  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE id = $1${companyClause(params)} LIMIT 1`,
      params,
    );
    return rows.length ? rowToUser(rows[0]) : undefined;
  },

  /**
   * Quais destes ids já têm conta. Serve a listagem de motoristas, para o painel
   * saber a quem falta criar acesso sem uma consulta por linha.
   * @param {string[]} ids
   * @returns {Promise<Set<string>>}
   */
  async existingIds(ids) {
    const unique = [...new Set((ids ?? []).filter(Boolean))];
    if (unique.length === 0) return new Set();
    const params = [unique];
    const { rows } = await pool.query(
      `SELECT id FROM users WHERE id = ANY($1)${companyClause(params)}`,
      params,
    );
    return new Set(rows.map((row) => row.id));
  },

  /**
   * Substitui a senha. Devolve a conta afetada, ou undefined se não existe (ou
   * é de outra empresa).
   * @param {string} id
   * @param {string} passwordHash
   * @returns {Promise<object | undefined>}
   */
  async updatePassword(id, passwordHash) {
    const params = [passwordHash, id];
    const { rows } = await pool.query(`
      UPDATE users SET password_hash = $1, updated_at = NOW()
      WHERE id = $2${companyClause(params)}
      RETURNING *
    `, params);
    return rows.length ? rowToUser(rows[0]) : undefined;
  },

  /**
   * Suspende ou reativa uma conta.
   * @param {string} id
   * @param {'active'|'blocked'} status
   * @returns {Promise<object | undefined>}
   */
  async updateStatus(id, status) {
    const params = [status, status === 'blocked' ? new Date() : null, id];
    const { rows } = await pool.query(`
      UPDATE users SET status = $1, blocked_at = $2, updated_at = NOW()
      WHERE id = $3${companyClause(params)}
      RETURNING *
    `, params);
    return rows.length ? rowToUser(rows[0]) : undefined;
  },
};

// ─── UserLocationRepository ──────────────────────────────────────────────────
// "Onde a pessoa usa o sistema": última localização conhecida por conta (auditoria).
// Usa DOUBLE PRECISION (não NUMERIC) para o driver pg devolver number, não string.

const UserLocationRepository = {
  async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_locations (
        user_id    TEXT PRIMARY KEY,
        email      TEXT,
        role       TEXT,
        lat        DOUBLE PRECISION NOT NULL,
        lng        DOUBLE PRECISION NOT NULL,
        accuracy   DOUBLE PRECISION,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },

  /**
   * Regista/atualiza a localização de um utilizador (upsert por user_id).
   * @param {{ user_id: string; email?: string; role?: string; lat: number; lng: number; accuracy?: number|null }} loc
   * @returns {Promise<object>}
   */
  async upsert(loc) {
    const { rows } = await pool.query(`
      INSERT INTO user_locations (user_id, email, role, lat, lng, accuracy, company_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        email      = EXCLUDED.email,
        role       = EXCLUDED.role,
        lat        = EXCLUDED.lat,
        lng        = EXCLUDED.lng,
        accuracy   = EXCLUDED.accuracy,
        company_id = EXCLUDED.company_id,
        updated_at = NOW()
      RETURNING *
    `, [loc.user_id, loc.email ?? null, loc.role ?? null, loc.lat, loc.lng, loc.accuracy ?? null, writeCompanyId()]);
    return rows[0];
  },

  async findAll() {
    const params = [];
    const { rows } = await pool.query(`SELECT * FROM user_locations${companyWhere(params)} ORDER BY updated_at DESC`, params);
    return rows.map((r) => ({
      user_id:    r.user_id,
      email:      r.email,
      role:       r.role,
      lat:        Number(r.lat),
      lng:        Number(r.lng),
      accuracy:   r.accuracy == null ? null : Number(r.accuracy),
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    }));
  },
};

// ─── DriverRepository ─────────────────────────────────────────────────────────

const DriverRepository = {
  /**
   * Lista todos os motoristas.
   * @returns {Promise<object[]>}
   */
  async findAll() {
    const params = [];
    const { rows } = await pool.query(
      `SELECT * FROM drivers${companyWhere(params)} ORDER BY name ASC`,
      params,
    );
    return rows.map(rowToDriver);
  },

  /**
   * @param {string} id
   * @returns {Promise<object | undefined>}
   */
  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(
      `SELECT * FROM drivers WHERE id = $1${companyClause(params)} LIMIT 1`,
      params,
    );
    return rows.length ? rowToDriver(rows[0]) : undefined;
  },

  /**
   * Conta motoristas por status.
   * Endpoint: GET /v1/drivers/stats
   * @returns {Promise<{ offline: number; on_route: number; available: number }>}
   */
  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE current_status = 'offline')   AS offline,
        COUNT(*) FILTER (WHERE current_status = 'on_route')  AS on_route,
        COUNT(*) FILTER (WHERE current_status = 'available') AS available
      FROM drivers${companyWhere(params)}
    `, params);
    return {
      offline:   Number(rows[0].offline),
      on_route:  Number(rows[0].on_route),
      available: Number(rows[0].available),
    };
  },

  /**
   * Insere um motorista na empresa em contexto.
   *
   * PORQUE FALTAVA: o painel tinha um botão "Adicionar Motorista" que só
   * escrevia no estado do React — o motorista desaparecia ao recarregar a
   * página, e não havia endpoint nenhum para o criar (spec § 3.32).
   *
   * @param {object} driver
   * @returns {Promise<object>}
   */
  async create(driver) {
    const { rows } = await pool.query(`
      INSERT INTO drivers (id, name, email, phone, vehicle, current_status, performance_metrics, gps, created_at, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
      RETURNING *
    `, [
      driver.id,
      driver.name,
      driver.email ?? null,
      driver.phone ?? null,
      JSON.stringify(driver.vehicle ?? {}),
      driver.current_status ?? 'offline',
      JSON.stringify(driver.performance_metrics ?? {}),
      null,
      writeCompanyId(),
    ]);
    return rowToDriver(rows[0]);
  },

  /**
   * Atualiza GPS e/ou status do motorista.
   * @param {object} driver
   * @returns {Promise<void>}
   */
  async update(driver) {
    const params = [
      driver.current_status,
      JSON.stringify(driver.performance_metrics ?? {}),
      driver.gps ? JSON.stringify(driver.gps) : null,
      driver.id,
    ];
    await pool.query(`
      UPDATE drivers SET
        current_status      = $1,
        performance_metrics = $2,
        gps                 = $3
      WHERE id = $4${companyClause(params)}
    `, params);
  },
};

// ─── WarehouseRepository ──────────────────────────────────────────────────────
// Gestão dinâmica de armazéns. A ocupação é SEMPRE derivada das encomendas cujo
// warehouse_id aponta para o armazém e cujo status é de armazém — nunca um
// contador mantido à mão (garante consistência com o estado real do pedido).

/** Status de pedido considerados "dentro do armazém". */
const WAREHOUSE_ORDER_STATUSES = ['at_warehouse', 'awaiting_destination'];

/** Subquery de ocupação reutilizável (assume alias `w` para warehouses). */
const OCCUPANCY_SUBQUERY = `
  COALESCE((
    SELECT COUNT(*) FROM orders o
    WHERE o.warehouse_id = w.id
      AND o.current_status IN ('at_warehouse','awaiting_destination')
  ), 0) AS occupancy`;

/**
 * Mapeia uma row de warehouse (com coluna derivada `occupancy`) → shape de domínio.
 * @param {object} row
 * @returns {object}
 */
function rowToWarehouse(row) {
  const capacity  = Number(row.capacity) || 0;
  const occupancy = row.occupancy != null ? Number(row.occupancy) : 0;
  const utilization = capacity > 0 ? Math.round((occupancy / capacity) * 100) : 0;
  return {
    id:            row.id,
    code:          row.code,
    name:          row.name,
    address:       row.address ?? {},
    capacity,
    status:        row.status,
    gps:           row.gps ?? undefined,
    occupancy,
    utilization,
    near_capacity: capacity > 0 && occupancy >= capacity * 0.9,
    full:          capacity > 0 && occupancy >= capacity,
    created_at:    row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at:    row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * Mapeia uma row de warehouse_movements → shape de domínio.
 * @param {object} row
 * @returns {object}
 */
function rowToMovement(row) {
  return {
    id:            row.id,
    warehouse_id:  row.warehouse_id,
    order_id:      row.order_id,
    tracking_code: row.tracking_code ?? undefined,
    type:          row.type,
    notes:         row.notes ?? undefined,
    user_id:       row.user_id ?? undefined,
    created_at:    row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

const WarehouseRepository = {
  /** Executa uma operação de armazém de forma atómica. */
  async withTransaction(operation) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** @returns {string[]} Status de pedido considerados dentro do armazém. */
  warehouseOrderStatuses() {
    return WAREHOUSE_ORDER_STATUSES;
  },

  /**
   * Lista todos os armazéns com a ocupação derivada, ordenados por nome.
   * @returns {Promise<object[]>}
   */
  async findAll() {
    const params = [];
    const { rows } = await pool.query(
      `SELECT w.*, ${OCCUPANCY_SUBQUERY} FROM warehouses w${companyWhere(params, 'w')} ORDER BY w.name ASC`,
      params,
    );
    return rows.map(rowToWarehouse);
  },

  /**
   * @param {string} id
   * @returns {Promise<object | undefined>}
   */
  async findById(id, executor = pool, lock = false) {
    const params = [id];
    const { rows } = await executor.query(
      `SELECT w.*, ${OCCUPANCY_SUBQUERY} FROM warehouses w WHERE w.id = $1${companyClause(params, 'w')} LIMIT 1${lock ? ' FOR UPDATE OF w' : ''}`,
      params,
    );
    return rows.length ? rowToWarehouse(rows[0]) : undefined;
  },

  /**
   * @param {string} code
   * @returns {Promise<object | undefined>}
   */
  async findByCode(code) {
    const params = [code];
    const { rows } = await pool.query(
      `SELECT w.*, ${OCCUPANCY_SUBQUERY} FROM warehouses w WHERE w.code = $1${companyClause(params, 'w')} LIMIT 1`,
      params,
    );
    return rows.length ? rowToWarehouse(rows[0]) : undefined;
  },

  /**
   * Insere um novo armazém.
   * @param {object} warehouse
   * @returns {Promise<object>}
   */
  async create(warehouse) {
    const { rows } = await pool.query(`
      INSERT INTO warehouses (id, code, name, address, capacity, status, gps, company_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      RETURNING *
    `, [
      warehouse.id,
      warehouse.code,
      warehouse.name,
      JSON.stringify(warehouse.address ?? {}),
      warehouse.capacity ?? 0,
      warehouse.status ?? 'active',
      warehouse.gps ? JSON.stringify(warehouse.gps) : null,
      warehouse.company_id ?? writeCompanyId(),
      warehouse.created_at,
    ]);
    return rowToWarehouse(rows[0]);
  },

  /**
   * Atualiza campos editáveis de um armazém.
   * @param {object} warehouse
   * @returns {Promise<object>}
   */
  async update(warehouse) {
    const params = [
      warehouse.code,
      warehouse.name,
      JSON.stringify(warehouse.address ?? {}),
      warehouse.capacity ?? 0,
      warehouse.status ?? 'active',
      warehouse.gps ? JSON.stringify(warehouse.gps) : null,
      warehouse.updated_at,
      warehouse.id,
    ];
    const { rows } = await pool.query(`
      UPDATE warehouses SET
        code       = $1,
        name       = $2,
        address    = $3,
        capacity   = $4,
        status     = $5,
        gps        = $6,
        updated_at = $7
      WHERE id = $8${companyClause(params)}
      RETURNING *
    `, params);
    return rows.length ? rowToWarehouse(rows[0]) : undefined;
  },

  /**
   * Altera apenas o status do armazém (ativar/desativar).
   * @param {string} id
   * @param {string} status
   * @param {string} updatedAt
   * @returns {Promise<object | undefined>}
   */
  async setStatus(id, status, updatedAt) {
    const params = [status, updatedAt, id];
    const { rows } = await pool.query(
      `UPDATE warehouses SET status = $1, updated_at = $2 WHERE id = $3${companyClause(params)} RETURNING *`,
      params,
    );
    return rows.length ? rowToWarehouse(rows[0]) : undefined;
  },

  /**
   * Resumo agregado para o painel/sidebar.
   * Endpoint: GET /v1/warehouses/stats
   * @returns {Promise<{ total: number; active: number; storedOrders: number; nearCapacity: number }>}
   */
  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      WITH occ AS (
        SELECT w.status, w.capacity, ${OCCUPANCY_SUBQUERY}
        FROM warehouses w${companyWhere(params, 'w')}
      )
      SELECT
        COUNT(*)                                                              AS total,
        COUNT(*) FILTER (WHERE status = 'active')                             AS active,
        COALESCE(SUM(occupancy), 0)                                          AS stored_orders,
        COUNT(*) FILTER (WHERE capacity > 0 AND occupancy >= capacity * 0.9) AS near_capacity
      FROM occ
    `, params);
    return {
      total:        Number(rows[0].total),
      active:       Number(rows[0].active),
      storedOrders: Number(rows[0].stored_orders),
      nearCapacity: Number(rows[0].near_capacity),
    };
  },

  /**
   * Encomendas atualmente dentro do armazém (status de armazém), recentes primeiro.
   * @param {string} warehouseId
   * @returns {Promise<object[]>}
   */
  async listOrders(warehouseId) {
    const params = [warehouseId];
    const { rows } = await pool.query(
      `SELECT * FROM orders
       WHERE warehouse_id = $1 AND current_status IN ('at_warehouse','awaiting_destination')${companyClause(params)}
       ORDER BY updated_at DESC`,
      params,
    );
    return rows.map(rowToOrder);
  },

  /**
   * Regista um movimento auditável (entrada/envio).
   * @param {object} movement
   * @returns {Promise<object>}
   */
  async recordMovement(movement, executor = pool) {
    const { rows } = await executor.query(`
      INSERT INTO warehouse_movements (id, warehouse_id, order_id, tracking_code, type, notes, user_id, company_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      movement.id,
      movement.warehouse_id,
      movement.order_id,
      movement.tracking_code ?? null,
      movement.type,
      movement.notes ?? null,
      movement.user_id ?? null,
      movement.company_id ?? writeCompanyId(),
      movement.created_at,
    ]);
    return rowToMovement(rows[0]);
  },

  /**
   * Histórico de movimentos de um armazém, recentes primeiro.
   * @param {string} warehouseId
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async listMovements(warehouseId, limit = 100) {
    const params = [warehouseId];
    const cc = companyClause(params);
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM warehouse_movements WHERE warehouse_id = $1${cc} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(rowToMovement);
  },
};

// ─── SettlementRepository ─────────────────────────────────────────────────────
// Acerto de caixa do motorista (COD). Valores em centavos.

/**
 * Mapeia uma row de driver_settlements → shape de domínio.
 * @param {object} row
 * @returns {object}
 */
function rowToSettlement(row) {
  const toIso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    id:                    row.id,
    driver_id:             row.driver_id,
    status:                row.status,
    order_count:           Number(row.order_count),
    expected_cash_cents:   Number(row.expected_cash_cents),
    expected_mobile_cents: Number(row.expected_mobile_cents),
    expected_total_cents:  Number(row.expected_total_cents),
    received_cash_cents:   row.received_cash_cents == null ? null : Number(row.received_cash_cents),
    difference_cents:      row.difference_cents == null ? null : Number(row.difference_cents),
    order_ids:             row.order_ids ?? [],
    notes:                 row.notes ?? null,
    opened_by:             row.opened_by ?? undefined,
    reconciled_by:         row.reconciled_by ?? null,
    opened_at:             toIso(row.opened_at),
    reconciled_at:         row.reconciled_at == null ? null : toIso(row.reconciled_at),
  };
}

const SettlementRepository = {
  /** @returns {Promise<object[]>} */
  async findAll() {
    const params = [];
    const { rows } = await pool.query(`SELECT * FROM driver_settlements${companyWhere(params)} ORDER BY opened_at DESC`, params);
    return rows.map(rowToSettlement);
  },

  /** @param {string} id @returns {Promise<object | undefined>} */
  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(`SELECT * FROM driver_settlements WHERE id = $1${companyClause(params)} LIMIT 1`, params);
    return rows.length ? rowToSettlement(rows[0]) : undefined;
  },

  /** @param {string} driverId @returns {Promise<object[]>} */
  async findByDriver(driverId) {
    const params = [driverId];
    const { rows } = await pool.query(
      `SELECT * FROM driver_settlements WHERE driver_id = $1${companyClause(params)} ORDER BY opened_at DESC`,
      params,
    );
    return rows.map(rowToSettlement);
  },

  /**
   * Pedidos com COD recolhido e ainda por acertar de um motorista.
   * @param {string} driverId
   * @returns {Promise<object[]>}
   */
  async listCollectedUnsettledByDriver(driverId) {
    const params = [driverId];
    const { rows } = await pool.query(
      `SELECT * FROM orders
        WHERE driver_id = $1 AND cod_status = 'collected' AND cod_settlement_id IS NULL
          -- COD cobrado ao balcão entrou no caixa do ARMAZÉM (spec § 3.23):
          -- não pode aparecer no acerto de um motorista que não lhe tocou.
          AND coalesce(cod->>'channel', 'driver') <> 'warehouse'${companyClause(params)}
        ORDER BY updated_at ASC`,
      params,
    );
    return rows.map(rowToOrder);
  },

  /**
   * Abre um acerto numa transação: cria o registo e marca os pedidos como
   * `settled` + `cod_settlement_id` atomicamente.
   *
   * @param {object} settlement
   * @param {string[]} orderIds
   * @returns {Promise<object>}
   */
  async openForDriver(settlement, orderIds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO driver_settlements (
          id, driver_id, status, order_count,
          expected_cash_cents, expected_mobile_cents, expected_total_cents,
          received_cash_cents, difference_cents, order_ids, notes, opened_by, opened_at, company_id
        ) VALUES ($1,$2,'open',$3,$4,$5,$6,NULL,NULL,$7,NULL,$8,$9,$10)
        RETURNING *
      `, [
        settlement.id,
        settlement.driver_id,
        settlement.order_count,
        settlement.expected_cash_cents,
        settlement.expected_mobile_cents,
        settlement.expected_total_cents,
        JSON.stringify(orderIds),
        settlement.opened_by ?? null,
        settlement.opened_at,
        settlement.company_id ?? writeCompanyId(),
      ]);

      if (orderIds.length > 0) {
        const upParams = [settlement.id, orderIds];
        await client.query(
          `UPDATE orders SET cod_status = 'settled', cod_settlement_id = $1, updated_at = NOW()
            WHERE id = ANY($2::text[])${companyClause(upParams)}`,
          upParams,
        );
      }

      await client.query('COMMIT');
      return rowToSettlement(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Atualiza um acerto (reconciliação).
   * @param {object} settlement
   * @returns {Promise<object>}
   */
  async update(settlement) {
    const params = [
      settlement.status,
      settlement.received_cash_cents,
      settlement.difference_cents,
      settlement.notes ?? null,
      settlement.reconciled_by ?? null,
      settlement.reconciled_at ?? null,
      settlement.id,
    ];
    const { rows } = await pool.query(`
      UPDATE driver_settlements SET
        status              = $1,
        received_cash_cents = $2,
        difference_cents    = $3,
        notes               = $4,
        reconciled_by       = $5,
        reconciled_at       = $6
      WHERE id = $7${companyClause(params)}
      RETURNING *
    `, params);
    return rows.length ? rowToSettlement(rows[0]) : undefined;
  },

  /**
   * Resumo para painel/sidebar.
   * @returns {Promise<{ open: number; reconciled: number; pendingCashCents: number; driversPending: number }>}
   */
  async getStats() {
    const sParams = [];
    const s = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')       AS open,
        COUNT(*) FILTER (WHERE status = 'reconciled') AS reconciled
      FROM driver_settlements${companyWhere(sParams)}
    `, sParams);
    const codParams = [];
    const cod = await pool.query(`
      SELECT
        COALESCE(SUM((cod->>'amount')::int) FILTER (WHERE cod->>'method' = 'CASH'), 0) AS pending_cash,
        COUNT(DISTINCT driver_id)                                                      AS drivers_pending
      FROM orders
      WHERE cod_status = 'collected' AND cod_settlement_id IS NULL${companyClause(codParams)}
    `, codParams);
    return {
      open:             Number(s.rows[0].open),
      reconciled:       Number(s.rows[0].reconciled),
      pendingCashCents: Number(cod.rows[0].pending_cash),
      driversPending:   Number(cod.rows[0].drivers_pending),
    };
  },
};

// ─── SupportRepository ────────────────────────────────────────────────────────
// Chat de suporte (spec § 3.9). O `client_token_hash` NUNCA é exposto: o mapeador
// devolve apenas campos seguros; a verificação do token vive no serviço.

function isoOf(v) {
  return v instanceof Date ? v.toISOString() : v;
}

function rowToSupportThread(row) {
  return {
    id:                 row.id,
    client_name:        row.client_name,
    client_email:       row.client_email ?? undefined,
    subject:            row.subject,
    order_id:           row.order_id ?? undefined,
    tracking_code:      row.tracking_code ?? undefined,
    status:             row.status,
    assigned_agent_id:  row.assigned_agent_id ?? undefined,
    message_count:      row.message_count != null ? Number(row.message_count) : undefined,
    last_message_preview: row.last_message_preview ?? undefined,
    last_message_at:    isoOf(row.last_message_at),
    created_at:         isoOf(row.created_at),
    updated_at:         isoOf(row.updated_at),
  };
}

function rowToSupportMessage(row) {
  return {
    id:          row.id,
    thread_id:   row.thread_id,
    sender:      row.sender,
    sender_name: row.sender_name,
    body:        row.body,
    created_at:  isoOf(row.created_at),
  };
}

const SupportRepository = {
  /** Cria uma conversa. @returns {Promise<object>} thread segura (sem hash) */
  async createThread(thread) {
    const { rows } = await pool.query(`
      INSERT INTO support_threads (
        id, client_name, client_email, subject, order_id, tracking_code,
        status, assigned_agent_id, client_token_hash, company_id, last_message_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW(),NOW())
      RETURNING *
    `, [
      thread.id,
      thread.client_name,
      thread.client_email ?? null,
      thread.subject,
      thread.order_id ?? null,
      thread.tracking_code ?? null,
      thread.status ?? 'open',
      thread.assigned_agent_id ?? null,
      thread.client_token_hash,
      // A conversa herda a empresa do pedido (resolvido no serviço); sem pedido,
      // fica na empresa do contexto/Padrão.
      thread.company_id ?? writeCompanyId(),
    ]);
    return rowToSupportThread(rows[0]);
  },

  /** @param {string} id @returns {Promise<object | undefined>} thread segura */
  async findThreadById(id) {
    const params = [id];
    const { rows } = await pool.query(`SELECT * FROM support_threads WHERE id = $1${companyClause(params)} LIMIT 1`, params);
    return rows.length ? rowToSupportThread(rows[0]) : undefined;
  },

  /** Hash do token de acesso do cliente — uso interno na verificação (cliente público). */
  async getClientTokenHash(id) {
    const params = [id];
    const { rows } = await pool.query(`SELECT client_token_hash FROM support_threads WHERE id = $1${companyClause(params)} LIMIT 1`, params);
    return rows.length ? rows[0].client_token_hash : undefined;
  },

  /**
   * Lista conversas para o agente (mais recentes primeiro), com contagem e
   * pré-visualização da última mensagem.
   * @param {{ status?: string }} [opts]
   * @returns {Promise<object[]>}
   */
  async listThreads(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`t.company_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`t.status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id = t.id) AS message_count,
        (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview
      FROM support_threads t
      ${where}
      ORDER BY t.last_message_at DESC
      LIMIT 200
    `, params);
    return rows.map(rowToSupportThread);
  },

  /** Insere uma mensagem — a empresa é herdada da conversa. @returns {Promise<object>} */
  async addMessage(msg) {
    const { rows } = await pool.query(`
      INSERT INTO support_messages (id, thread_id, sender, sender_id, sender_name, body, company_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,(SELECT company_id FROM support_threads WHERE id = $2),NOW())
      RETURNING *
    `, [msg.id, msg.thread_id, msg.sender, msg.sender_id ?? null, msg.sender_name, msg.body]);
    return rowToSupportMessage(rows[0]);
  },

  /** Todas as mensagens de uma conversa (ordem cronológica). */
  async listMessages(threadId) {
    const params = [threadId];
    const { rows } = await pool.query(
      `SELECT * FROM support_messages WHERE thread_id = $1${companyClause(params)} ORDER BY created_at ASC, id ASC`,
      params,
    );
    return rows.map(rowToSupportMessage);
  },

  /**
   * Marca a conversa como tendo nova atividade: bump de last_message_at/updated_at,
   * reabrindo-a (status 'open') quando `reopen` — ex.: cliente responde a uma resolvida.
   */
  async bumpThread(id, reopen = false) {
    const params = [id];
    const { rows } = await pool.query(`
      UPDATE support_threads
         SET last_message_at = NOW(), updated_at = NOW()${reopen ? `, status = 'open'` : ''}
       WHERE id = $1${companyClause(params)}
      RETURNING *
    `, params);
    return rows.length ? rowToSupportThread(rows[0]) : undefined;
  },

  /** Atualiza estado e/ou agente atribuído. */
  async updateThread(id, patch) {
    const sets = [];
    const params = [];
    if (patch.status !== undefined)            { params.push(patch.status);            sets.push(`status = $${params.length}`); }
    if (patch.assigned_agent_id !== undefined) { params.push(patch.assigned_agent_id); sets.push(`assigned_agent_id = $${params.length}`); }
    if (sets.length === 0) return this.findThreadById(id);
    params.push(id);
    const idClause = `id = $${params.length}${companyClause(params)}`;
    const { rows } = await pool.query(
      `UPDATE support_threads SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idClause} RETURNING *`,
      params,
    );
    return rows.length ? rowToSupportThread(rows[0]) : undefined;
  },

  /** Resumo para painel/sidebar. */
  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                   AS total,
        COUNT(*) FILTER (WHERE status = 'open')     AS open,
        COUNT(*) FILTER (WHERE status = 'resolved') AS resolved
      FROM support_threads${companyWhere(params)}
    `, params);
    return {
      total:    Number(rows[0].total),
      open:     Number(rows[0].open),
      resolved: Number(rows[0].resolved),
    };
  },
};

// ─── ClientRepository ─────────────────────────────────────────────────────────
// Registo de clientes/remetentes (spec § 3.12).

function rowToClient(row) {
  return {
    id:          row.id,
    name:        row.name,
    type:        row.type,
    email:       row.email ?? undefined,
    phone:       row.phone ?? undefined,
    tax_id:      row.tax_id ?? undefined,
    address:     row.address ?? undefined,
    notes:       row.notes ?? undefined,
    status:      row.status,
    order_count: row.order_count != null ? Number(row.order_count) : undefined,
    created_at:  isoOf(row.created_at),
    updated_at:  isoOf(row.updated_at),
  };
}

const ClientRepository = {
  /**
   * Lista clientes com pesquisa (nome/email/telefone/NUIT) e paginação.
   * @param {{ search?: string; status?: string; limit?: number; offset?: number }} [opts]
   * @returns {Promise<{ items: object[]; total: number }>}
   */
  async list(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`status = $${params.length}`); }
    if (opts.search) {
      params.push(`%${opts.search.toLowerCase()}%`);
      const p = `$${params.length}`;
      clauses.push(`(lower(name) LIKE ${p} OR lower(coalesce(email,'')) LIKE ${p} OR coalesce(phone,'') LIKE ${p} OR lower(coalesce(tax_id,'')) LIKE ${p})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRes = await pool.query(`SELECT COUNT(*) AS total FROM clients ${where}`, params);
    const total = Number(totalRes.rows[0].total);

    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.client_ref_id = c.id) AS order_count
      FROM clients c
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    return { items: rows.map(rowToClient), total };
  },

  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.client_ref_id = c.id) AS order_count
      FROM clients c WHERE c.id = $1${companyClause(params, 'c')} LIMIT 1
    `, params);
    return rows.length ? rowToClient(rows[0]) : undefined;
  },

  /** Procura por email (normalizado) — deduplicação por empresa. */
  async findByEmail(email) {
    const params = [email];
    const { rows } = await pool.query(
      `SELECT * FROM clients WHERE lower(email) = lower($1)${companyClause(params)} LIMIT 1`,
      params,
    );
    return rows.length ? rowToClient(rows[0]) : undefined;
  },

  async create(c) {
    const { rows } = await pool.query(`
      INSERT INTO clients (id, name, type, email, phone, tax_id, address, notes, status, company_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
      RETURNING *
    `, [
      c.id, c.name, c.type ?? 'individual', c.email ?? null, c.phone ?? null,
      c.tax_id ?? null, c.address ? JSON.stringify(c.address) : null, c.notes ?? null, c.status ?? 'active',
      c.company_id ?? writeCompanyId(),
    ]);
    return rowToClient(rows[0]);
  },

  async update(id, patch) {
    const sets = [];
    const params = [];
    const col = (name, value, json = false) => {
      params.push(json ? (value ? JSON.stringify(value) : null) : value);
      sets.push(`${name} = $${params.length}`);
    };
    if (patch.name    !== undefined) col('name', patch.name);
    if (patch.type    !== undefined) col('type', patch.type);
    if (patch.email   !== undefined) col('email', patch.email || null);
    if (patch.phone   !== undefined) col('phone', patch.phone || null);
    if (patch.tax_id  !== undefined) col('tax_id', patch.tax_id || null);
    if (patch.address !== undefined) col('address', patch.address, true);
    if (patch.notes   !== undefined) col('notes', patch.notes || null);
    if (patch.status  !== undefined) col('status', patch.status);
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    const idClause = `id = $${params.length}${companyClause(params)}`;
    const { rows } = await pool.query(
      `UPDATE clients SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idClause} RETURNING *`,
      params,
    );
    return rows.length ? rowToClient(rows[0]) : undefined;
  },

  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                    AS total,
        COUNT(*) FILTER (WHERE status = 'active')    AS active,
        COUNT(*) FILTER (WHERE type = 'business')    AS business
      FROM clients${companyWhere(params)}
    `, params);
    return { total: Number(rows[0].total), active: Number(rows[0].active), business: Number(rows[0].business) };
  },
};

// ─── PricingRepository ────────────────────────────────────────────────────────
// Zonas de tarifação (spec § 3.13).

function rowToZone(row) {
  return {
    id:           row.id,
    code:         row.code,
    name:         row.name,
    base_cents:   Number(row.base_cents),
    per_kg_cents: Number(row.per_kg_cents),
    included_kg:  Number(row.included_kg),
    // Tarifação por distância (§ 3.13). `?? 0` cobre a leitura de uma base onde
    // a migração ainda não correu — a zona simplesmente não cobra ao km.
    per_km_cents: Number(row.per_km_cents ?? 0),
    included_km:  Number(row.included_km ?? 0),
    active:       row.active,
    sort_order:   Number(row.sort_order),
    created_at:   isoOf(row.created_at),
    updated_at:   isoOf(row.updated_at),
  };
}

const PricingRepository = {
  /** @param {{ activeOnly?: boolean }} [opts] */
  async listZones(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.activeOnly) clauses.push('active = TRUE');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM pricing_zones ${where} ORDER BY sort_order ASC, name ASC`, params);
    return rows.map(rowToZone);
  },

  async findZoneByCode(code) {
    const params = [code];
    const { rows } = await pool.query(`SELECT * FROM pricing_zones WHERE code = $1${companyClause(params)} LIMIT 1`, params);
    return rows.length ? rowToZone(rows[0]) : undefined;
  },

  async findZoneById(id) {
    const params = [id];
    const { rows } = await pool.query(`SELECT * FROM pricing_zones WHERE id = $1${companyClause(params)} LIMIT 1`, params);
    return rows.length ? rowToZone(rows[0]) : undefined;
  },

  async createZone(z) {
    const { rows } = await pool.query(`
      INSERT INTO pricing_zones (id, code, name, base_cents, per_kg_cents, included_kg, per_km_cents, included_km, active, sort_order, company_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
      RETURNING *
    `, [z.id, z.code, z.name, z.base_cents, z.per_kg_cents, z.included_kg, z.per_km_cents ?? 0, z.included_km ?? 0, z.active ?? true, z.sort_order ?? 0, z.company_id ?? writeCompanyId()]);
    return rowToZone(rows[0]);
  },

  async updateZone(id, patch) {
    const sets = [];
    const params = [];
    const col = (name, value) => { params.push(value); sets.push(`${name} = $${params.length}`); };
    if (patch.name         !== undefined) col('name', patch.name);
    if (patch.base_cents   !== undefined) col('base_cents', patch.base_cents);
    if (patch.per_kg_cents !== undefined) col('per_kg_cents', patch.per_kg_cents);
    if (patch.included_kg  !== undefined) col('included_kg', patch.included_kg);
    if (patch.per_km_cents !== undefined) col('per_km_cents', patch.per_km_cents);
    if (patch.included_km  !== undefined) col('included_km', patch.included_km);
    if (patch.active       !== undefined) col('active', patch.active);
    if (patch.sort_order   !== undefined) col('sort_order', patch.sort_order);
    if (sets.length === 0) return this.findZoneById(id);
    params.push(id);
    const idClause = `id = $${params.length}${companyClause(params)}`;
    const { rows } = await pool.query(
      `UPDATE pricing_zones SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idClause} RETURNING *`,
      params,
    );
    return rows.length ? rowToZone(rows[0]) : undefined;
  },
};

// ─── InvoiceRepository ────────────────────────────────────────────────────────
// Faturação (spec § 3.14) + conformidade fiscal (spec § 3.19): numeração por
// série atribuída atomicamente e assinatura encadeada ao documento anterior.

function rowToInvoice(row) {
  return {
    id:             row.id,
    number:         row.number,
    doc_type:       row.doc_type ?? 'FT',
    series:         row.series ?? undefined,
    seq:            row.seq === null || row.seq === undefined ? undefined : Number(row.seq),
    order_id:       row.order_id ?? undefined,
    tracking_code:  row.tracking_code ?? undefined,
    client_ref_id:  row.client_ref_id ?? undefined,
    client_name:    row.client_name,
    client_tax_id:  row.client_tax_id ?? undefined,
    client_email:   row.client_email ?? undefined,
    client_address: row.client_address ?? undefined,
    issuer_name:    row.issuer_name ?? undefined,
    issuer_tax_id:  row.issuer_tax_id ?? undefined,
    items:          row.items ?? [],
    tax_summary:    row.tax_summary ?? [],
    subtotal_cents: Number(row.subtotal_cents),
    tax_rate_pct:   Number(row.tax_rate_pct),
    tax_cents:      Number(row.tax_cents),
    total_cents:    Number(row.total_cents),
    credited_cents: Number(row.credited_cents ?? 0),
    currency:       row.currency ?? 'MZN',
    status:         row.status,
    payment_method: row.payment_method ?? undefined,
    notes:          row.notes ?? undefined,
    // Inviolabilidade (spec § 3.19)
    hash:           row.hash ?? undefined,
    previous_hash:  row.previous_hash ?? undefined,
    hash_control:   row.hash_control ?? undefined,
    signed_at:      row.signed_at ? isoOf(row.signed_at) : undefined,
    issued_by:      row.issued_by ?? undefined,
    // Vencimento acordado no contrato (§ 3.35). Ausente numa fatura-recibo de
    // pronto pagamento — ver a nota em `dueDateFrom`.
    due_date:       row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : (row.due_date ?? undefined),
    // Retificação (NC/ND)
    related_invoice_id: row.related_invoice_id ?? undefined,
    related_number: row.related_number ?? undefined,
    void_reason:    row.void_reason ?? undefined,
    issued_at:      isoOf(row.issued_at),
    paid_at:        row.paid_at ? isoOf(row.paid_at) : undefined,
    voided_at:      row.voided_at ? isoOf(row.voided_at) : undefined,
    created_at:     isoOf(row.created_at),
    updated_at:     isoOf(row.updated_at),
  };
}

const InvoiceRepository = {
  /**
   * Fatura ativa (não anulada) de um pedido, se existir. Só documentos de VENDA:
   * uma nota de crédito partilha o `order_id` mas não é a fatura do pedido.
   */
  async findActiveByOrderId(orderId) {
    const params = [orderId];
    const { rows } = await pool.query(
      `SELECT * FROM invoices
        WHERE order_id = $1 AND status <> 'void' AND doc_type IN ('FT','FR')${companyClause(params)}
        ORDER BY issued_at DESC LIMIT 1`,
      params,
    );
    return rows.length ? rowToInvoice(rows[0]) : undefined;
  },

  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1${companyClause(params)} LIMIT 1`, params);
    return rows.length ? rowToInvoice(rows[0]) : undefined;
  },

  /**
   * Emite um documento fiscal numa transação (spec § 3.19):
   *   1. reserva o próximo número da série — o `ON CONFLICT DO UPDATE` bloqueia a
   *      linha da série, o que **serializa** as emissões concorrentes e garante
   *      uma sequência sem saltos nem duplicados;
   *   2. lê o hash do último documento da mesma cadeia (empresa+tipo+série), já
   *      committed porque a transação anterior teve de largar o bloqueio;
   *   3. assina e insere.
   *
   * A assinatura é calculada pelo chamador através de `sign(...)` — o núcleo
   * fiscal é puro e não conhece a base de dados.
   *
   * @param {object} doc
   * @param {(input: {number:string, issuedAt:string, signedAt:string, totalCents:number, previousHash:string}) => {hash:string,hash_control:string,previous_hash:string,signed_at:string}} sign
   * @param {(docType:string, series:string, year:number, seq:number) => string} formatNumber
   * @returns {Promise<object>}
   */
  async createDocument(doc, sign, formatNumber) {
    const cid = doc.company_id ?? writeCompanyId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const now = new Date();
      const year = now.getUTCFullYear();
      const seqRes = await client.query(`
        INSERT INTO document_series (id, company_id, doc_type, series, year, last_seq)
        VALUES ($1, $2, $3, $4, $5, 1)
        ON CONFLICT (company_id, doc_type, series, year)
        DO UPDATE SET last_seq = document_series.last_seq + 1, updated_at = NOW()
        RETURNING last_seq
      `, [`ds-${cid}-${doc.doc_type}-${doc.series}-${year}`, cid, doc.doc_type, doc.series, year]);
      const seq = Number(seqRes.rows[0].last_seq);
      const number = formatNumber(doc.doc_type, doc.series, year, seq);

      const prevRes = await client.query(`
        SELECT hash FROM invoices
         WHERE company_id = $1 AND doc_type = $2 AND series = $3 AND hash IS NOT NULL
         ORDER BY signed_at DESC, seq DESC LIMIT 1
      `, [cid, doc.doc_type, doc.series]);

      const issuedAt = now.toISOString();
      const signature = sign({
        number,
        issuedAt,
        signedAt: issuedAt,
        totalCents: doc.total_cents,
        previousHash: prevRes.rows[0]?.hash,
      });

      const { rows } = await client.query(`
        INSERT INTO invoices (
          id, number, doc_type, series, seq, order_id, tracking_code, client_ref_id,
          client_name, client_tax_id, client_email, client_address,
          issuer_name, issuer_tax_id, items, tax_summary,
          subtotal_cents, tax_rate_pct, tax_cents, total_cents, currency, status, notes,
          hash, previous_hash, hash_control, signed_at, issued_by,
          related_invoice_id, related_number, due_date,
          company_id, issued_at, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,
          $13,$14,$15,$16,
          $17,$18,$19,$20,$21,$22,$23,
          $24,$25,$26,$27,$28,
          $29,$30,$31,
          $32,$33,NOW(),NOW()
        ) RETURNING *
      `, [
        doc.id, number, doc.doc_type, doc.series, seq, doc.order_id ?? null, doc.tracking_code ?? null, doc.client_ref_id ?? null,
        doc.client_name, doc.client_tax_id ?? null, doc.client_email ?? null, doc.client_address ?? null,
        doc.issuer_name ?? null, doc.issuer_tax_id ?? null, JSON.stringify(doc.items ?? []), JSON.stringify(doc.tax_summary ?? []),
        doc.subtotal_cents, doc.tax_rate_pct, doc.tax_cents, doc.total_cents, doc.currency ?? 'MZN', doc.status ?? 'issued', doc.notes ?? null,
        signature.hash, signature.previous_hash, signature.hash_control, signature.signed_at, doc.issued_by ?? null,
        doc.related_invoice_id ?? null, doc.related_number ?? null, doc.due_date ?? null,
        cid, issuedAt,
      ]);

      await client.query('COMMIT');
      return rowToInvoice(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Soma já creditada (notas de crédito) sobre um documento. */
  async addCredited(id, cents) {
    const params = [cents, id];
    const { rows } = await pool.query(
      `UPDATE invoices SET credited_cents = credited_cents + $1, updated_at = NOW()
        WHERE id = $2${companyClause(params)} RETURNING *`,
      params,
    );
    return rows.length ? rowToInvoice(rows[0]) : undefined;
  },

  /** Documentos de um período, para o mapa de IVA e a exportação de auditoria. */
  async listForPeriod({ from, to, includeVoid = true } = {}) {
    const params = [from, to];
    const voidClause = includeVoid ? '' : ` AND status <> 'void'`;
    const { rows } = await pool.query(
      `SELECT * FROM invoices
        WHERE issued_at >= $1 AND issued_at < $2${voidClause}${companyClause(params)}
        ORDER BY doc_type, series, seq NULLS LAST, issued_at`,
      params,
    );
    return rows.map(rowToInvoice);
  },

  /**
   * Apuramento por taxa no período. A nota de crédito entra com sinal negativo —
   * é o número que vai para a declaração periódica.
   */
  async getTaxSummaryForPeriod({ from, to }) {
    const params = [from, to];
    const { rows } = await pool.query(`
      SELECT (e->>'rate_pct')::numeric                                       AS rate_pct,
             e->>'exemption_code'                                            AS exemption_code,
             SUM(((e->>'base_cents')::bigint) * CASE WHEN i.doc_type = 'NC' THEN -1 ELSE 1 END) AS base_cents,
             SUM(((e->>'tax_cents')::bigint)  * CASE WHEN i.doc_type = 'NC' THEN -1 ELSE 1 END) AS tax_cents,
             COUNT(DISTINCT i.id)                                            AS documents
        FROM invoices i, LATERAL jsonb_array_elements(i.tax_summary) e
       WHERE i.issued_at >= $1 AND i.issued_at < $2 AND i.status <> 'void'${companyClause(params, 'i')}
       GROUP BY 1, 2
       ORDER BY 1 DESC
    `, params);
    return rows.map((r) => ({
      rate_pct:       Number(r.rate_pct),
      exemption_code: r.exemption_code ?? undefined,
      base_cents:     Number(r.base_cents),
      tax_cents:      Number(r.tax_cents),
      documents:      Number(r.documents),
    }));
  },

  /** Contagem por tipo de documento no período (cabeçalho do mapa de IVA). */
  async countByTypeForPeriod({ from, to }) {
    const params = [from, to];
    const { rows } = await pool.query(`
      SELECT doc_type,
             COUNT(*)                                          AS total,
             COUNT(*) FILTER (WHERE status = 'void')           AS voided,
             COALESCE(SUM(total_cents) FILTER (WHERE status <> 'void'), 0) AS total_cents
        FROM invoices
       WHERE issued_at >= $1 AND issued_at < $2${companyClause(params)}
       GROUP BY doc_type ORDER BY doc_type
    `, params);
    return rows.map((r) => ({
      doc_type: r.doc_type, total: Number(r.total), voided: Number(r.voided), total_cents: Number(r.total_cents),
    }));
  },

  /** Cadeias existentes (empresa+tipo+série) — entrada do relatório de integridade. */
  async listChains() {
    const params = [];
    const { rows } = await pool.query(
      `SELECT company_id, doc_type, series, COUNT(*) AS documents
         FROM invoices${companyWhere(params)}
        GROUP BY 1,2,3 ORDER BY 2,3`,
      params,
    );
    return rows.map((r) => ({ company_id: r.company_id, doc_type: r.doc_type, series: r.series, documents: Number(r.documents) }));
  },

  /** Documentos de uma cadeia, pela ordem em que foram assinados. */
  async listChainDocuments(docType, series) {
    const params = [docType, series];
    const { rows } = await pool.query(
      `SELECT * FROM invoices
        WHERE doc_type = $1 AND series = $2${companyClause(params)}
        ORDER BY signed_at NULLS FIRST, seq NULLS FIRST`,
      params,
    );
    return rows.map(rowToInvoice);
  },

  /**
   * Lista documentos com filtro de estado/tipo e pesquisa + paginação.
   * @param {{ status?: string; doc_type?: string; search?: string; limit?: number; offset?: number }} [opts]
   */
  async list(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`status = $${params.length}`); }
    if (opts.doc_type) { params.push(opts.doc_type); clauses.push(`doc_type = $${params.length}`); }
    if (opts.search) {
      params.push(`%${opts.search.toLowerCase()}%`);
      const p = `$${params.length}`;
      clauses.push(`(lower(number) LIKE ${p} OR lower(client_name) LIKE ${p} OR lower(coalesce(tracking_code,'')) LIKE ${p})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRes = await pool.query(`SELECT COUNT(*) AS total FROM invoices ${where}`, params);
    const total = Number(totalRes.rows[0].total);

    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const { rows } = await pool.query(
      `SELECT * FROM invoices ${where} ORDER BY issued_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map(rowToInvoice), total };
  },

  /** Atualiza estado/pagamento. */
  async update(id, patch) {
    const sets = [];
    const params = [];
    const col = (name, value) => { params.push(value); sets.push(`${name} = $${params.length}`); };
    // Os VALORES de um documento assinado nunca mudam (spec § 3.19): só o estado
    // de pagamento/anulação é que evolui.
    if (patch.status         !== undefined) col('status', patch.status);
    if (patch.payment_method !== undefined) col('payment_method', patch.payment_method);
    if (patch.paid_at        !== undefined) col('paid_at', patch.paid_at);
    if (patch.voided_at      !== undefined) col('voided_at', patch.voided_at);
    if (patch.void_reason    !== undefined) col('void_reason', patch.void_reason);
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    const idClause = `id = $${params.length}${companyClause(params)}`;
    const { rows } = await pool.query(
      `UPDATE invoices SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idClause} RETURNING *`,
      params,
    );
    return rows.length ? rowToInvoice(rows[0]) : undefined;
  },

  async getStats() {
    const params = [];
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE doc_type <> 'NC')                          AS total,
        COUNT(*) FILTER (WHERE doc_type <> 'NC' AND status = 'issued')    AS issued,
        COUNT(*) FILTER (WHERE doc_type <> 'NC' AND status = 'paid')      AS paid,
        COUNT(*) FILTER (WHERE doc_type <> 'NC' AND status = 'void')      AS void,
        COUNT(*) FILTER (WHERE doc_type = 'NC'  AND status <> 'void')     AS credit_notes,
        COALESCE(SUM(total_cents) FILTER (WHERE doc_type <> 'NC' AND status = 'issued'), 0) AS issued_total,
        COALESCE(SUM(total_cents) FILTER (WHERE doc_type <> 'NC' AND status = 'paid'), 0)   AS paid_total,
        COALESCE(SUM(total_cents) FILTER (WHERE doc_type = 'NC'  AND status <> 'void'), 0)  AS credited_total
      FROM invoices${companyWhere(params)}
    `, params);
    const r = rows[0];
    return {
      total: Number(r.total), issued: Number(r.issued), paid: Number(r.paid), void: Number(r.void),
      credit_notes: Number(r.credit_notes),
      issued_total_cents: Number(r.issued_total), paid_total_cents: Number(r.paid_total),
      credited_total_cents: Number(r.credited_total),
    };
  },

  /**
   * Dívida em aberto de um cliente, em centavos (§ 3.35).
   *
   * Conta as faturas de VENDA emitidas e não pagas, e desconta as notas de
   * crédito emitidas ao mesmo cliente: sem esse desconto, um cliente a quem se
   * creditou uma devolução continuava a aparecer a dever o valor devolvido, e o
   * limite de crédito travava-o por dinheiro que já não existe.
   *
   * @param {string} clientRefId
   * @returns {Promise<number>}
   */
  async outstandingForClient(clientRefId) {
    if (!clientRefId) return 0;
    const params = [clientRefId];
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(total_cents) FILTER (WHERE doc_type IN ('FT','FR') AND status = 'issued'), 0) AS devido,
        COALESCE(SUM(total_cents) FILTER (WHERE doc_type = 'NC' AND status <> 'void'), 0)          AS creditado
      FROM invoices
      WHERE client_ref_id = $1${companyClause(params)}
    `, params);
    return Math.max(0, Number(rows[0].devido) - Number(rows[0].creditado));
  },
};

// ─── ContractRepository ───────────────────────────────────────────────────────
// Contratos de cliente (spec § 3.35). As tarifas negociadas vivem em JSONB na
// própria linha — ver a nota em migrations/contracts.js.

/**
 * @param {object} row
 * @returns {object}
 */
function rowToContract(row) {
  return {
    id:                   row.id,
    client_ref_id:        row.client_ref_id,
    code:                 row.code,
    status:               row.status,
    // DATE volta do driver como Date; a camada de aplicação compara strings
    // YYYY-MM-DD, e converter aqui evita que cada chamador se lembre de o fazer.
    starts_on:            row.starts_on instanceof Date ? row.starts_on.toISOString().slice(0, 10) : row.starts_on,
    ends_on:              row.ends_on instanceof Date ? row.ends_on.toISOString().slice(0, 10) : (row.ends_on ?? null),
    discount_pct:         Number(row.discount_pct),
    minimum_charge_cents: Number(row.minimum_charge_cents),
    payment_terms_days:   Number(row.payment_terms_days),
    credit_limit_cents:   Number(row.credit_limit_cents),
    zone_rates:           row.zone_rates ?? [],
    notes:                row.notes ?? null,
    created_at:           row.created_at,
    updated_at:           row.updated_at,
  };
}

const ContractRepository = {
  /**
   * @param {{ client_ref_id?: string, status?: string }} [opts]
   * @returns {Promise<object[]>}
   */
  async list(opts = {}) {
    const params = [];
    const clauses = [];
    if (opts.client_ref_id) { params.push(opts.client_ref_id); clauses.push(`client_ref_id = $${params.length}`); }
    if (opts.status)        { params.push(opts.status);        clauses.push(`status = $${params.length}`); }

    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM client_contracts ${where} ORDER BY starts_on DESC, created_at DESC`,
      params,
    );
    return rows.map(rowToContract);
  },

  /** Todos os contratos de um cliente — a resolução por data é da aplicação. */
  async listByClient(clientRefId) {
    return ContractRepository.list({ client_ref_id: clientRefId });
  },

  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(
      `SELECT * FROM client_contracts WHERE id = $1${companyClause(params)} LIMIT 1`,
      params,
    );
    return rows.length ? rowToContract(rows[0]) : undefined;
  },

  async findByCode(code) {
    const params = [code];
    const { rows } = await pool.query(
      `SELECT * FROM client_contracts WHERE code = $1${companyClause(params)} LIMIT 1`,
      params,
    );
    return rows.length ? rowToContract(rows[0]) : undefined;
  },

  async create(contract) {
    const { rows } = await pool.query(`
      INSERT INTO client_contracts (
        id, company_id, client_ref_id, code, status, starts_on, ends_on,
        discount_pct, minimum_charge_cents, payment_terms_days, credit_limit_cents,
        zone_rates, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      contract.id,
      contract.company_id ?? writeCompanyId(),
      contract.client_ref_id,
      contract.code,
      contract.status,
      contract.starts_on,
      contract.ends_on ?? null,
      contract.discount_pct ?? 0,
      contract.minimum_charge_cents ?? 0,
      contract.payment_terms_days ?? 0,
      contract.credit_limit_cents ?? 0,
      JSON.stringify(contract.zone_rates ?? []),
      contract.notes ?? null,
      contract.created_at,
      contract.updated_at,
    ]);
    return rowToContract(rows[0]);
  },

  async update(id, contract) {
    const params = [
      contract.code,
      contract.status,
      contract.starts_on,
      contract.ends_on ?? null,
      contract.discount_pct ?? 0,
      contract.minimum_charge_cents ?? 0,
      contract.payment_terms_days ?? 0,
      contract.credit_limit_cents ?? 0,
      JSON.stringify(contract.zone_rates ?? []),
      contract.notes ?? null,
      contract.updated_at,
      id,
    ];
    const { rows } = await pool.query(`
      UPDATE client_contracts SET
        code                 = $1,
        status               = $2,
        starts_on            = $3,
        ends_on              = $4,
        discount_pct         = $5,
        minimum_charge_cents = $6,
        payment_terms_days   = $7,
        credit_limit_cents   = $8,
        zone_rates           = $9,
        notes                = $10,
        updated_at           = $11
      WHERE id = $12${companyClause(params)}
      RETURNING *
    `, params);
    return rows.length ? rowToContract(rows[0]) : undefined;
  },
};

// ─── CompanyProfileRepository ─────────────────────────────────────────────────
// Marca da empresa (spec § 3.17): cabeçalho dos documentos PDF e emissor fiscal.
// Acesso sempre com a empresa explícita — quem chama já a tem no contexto.

function rowToProfile(row) {
  return {
    company_id:   row.company_id,
    legal_name:   row.legal_name,
    trade_name:   row.trade_name ?? undefined,
    tax_id:       row.tax_id ?? undefined,
    address:      row.address ?? undefined,
    city:         row.city ?? undefined,
    country:      row.country,
    phone:        row.phone ?? undefined,
    email:        row.email ?? undefined,
    website:      row.website ?? undefined,
    logo:         row.logo ?? undefined,
    brand_color:  row.brand_color,
    bank_details: row.bank_details ?? undefined,
    footer_note:  row.footer_note ?? undefined,
    created_at:   isoOf(row.created_at),
    updated_at:   isoOf(row.updated_at),
  };
}

const CompanyProfileRepository = {
  async findByCompany(companyId) {
    const { rows } = await pool.query('SELECT * FROM company_profiles WHERE company_id = $1 LIMIT 1', [companyId]);
    return rows.length ? rowToProfile(rows[0]) : undefined;
  },

  /**
   * Cria ou atualiza o perfil. Só os campos presentes no patch são tocados —
   * gravar o formulário sem logótipo não apaga o logótipo existente.
   *
   * @param {string} companyId
   * @param {object} patch
   * @param {string} [fallbackName] Nome a usar se a linha ainda não existir
   */
  async upsert(companyId, patch = {}, fallbackName) {
    const OPTIONAL = [
      'trade_name', 'tax_id', 'address', 'city', 'country',
      'phone', 'email', 'website', 'logo', 'brand_color', 'bank_details', 'footer_note',
    ];

    // `legal_name` é NOT NULL: entra sempre no INSERT, com o nome da empresa
    // como rede de segurança.
    const insertCols = ['company_id', 'legal_name'];
    const params = [companyId, patch.legal_name ?? fallbackName ?? companyId];
    const sets = [];
    if (patch.legal_name !== undefined) sets.push('legal_name = $2');

    for (const name of OPTIONAL) {
      if (patch[name] === undefined) continue;
      params.push(patch[name]);
      insertCols.push(name);
      sets.push(`${name} = $${params.length}`);
    }

    const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
    const update = sets.length ? `${sets.join(', ')}, updated_at = NOW()` : 'updated_at = NOW()';

    const { rows } = await pool.query(`
      INSERT INTO company_profiles (${insertCols.join(', ')}, created_at, updated_at)
      VALUES (${placeholders}, NOW(), NOW())
      ON CONFLICT (company_id) DO UPDATE SET ${update}
      RETURNING *
    `, params);
    return rowToProfile(rows[0]);
  },
};

// ─── PasswordResetRepository ──────────────────────────────────────────────────
// Recuperação de senha (spec § 3.22). Guarda-se sempre o HASH do token; o valor
// em claro só existe no email que o utilizador recebe.

function rowToResetToken(row) {
  return {
    id:             row.id,
    user_id:        row.user_id,
    company_id:     row.company_id ?? undefined,
    token_hash:     row.token_hash,
    expires_at:     isoOf(row.expires_at),
    used_at:        row.used_at ? isoOf(row.used_at) : undefined,
    invalidated_at: row.invalidated_at ? isoOf(row.invalidated_at) : undefined,
    requested_ip:   row.requested_ip ?? undefined,
    created_at:     isoOf(row.created_at),
  };
}

const PasswordResetRepository = {
  /**
   * Cria o token e **invalida todos os anteriores** do mesmo utilizador: pedir
   * um link novo tem de tornar o antigo inútil, senão um email antigo
   * reencaminhado continuaria a abrir a porta.
   */
  async create(token) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE password_reset_tokens SET invalidated_at = NOW()
          WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [token.user_id],
      );
      const { rows } = await client.query(`
        INSERT INTO password_reset_tokens (id, user_id, company_id, token_hash, expires_at, requested_ip)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [token.id, token.user_id, token.company_id ?? null, token.token_hash, token.expires_at, token.requested_ip ?? null]);
      await client.query('COMMIT');
      return rowToResetToken(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Procura pelo hash — nunca há forma de procurar pelo token em claro. */
  async findByHash(tokenHash) {
    const { rows } = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash = $1 LIMIT 1', [tokenHash],
    );
    return rows.length ? rowToResetToken(rows[0]) : undefined;
  },

  /**
   * Consome o token e troca a senha na MESMA transação: ou acontecem as duas
   * coisas, ou nenhuma. Devolve undefined se o token já tiver sido usado entre
   * a leitura e aqui (corrida entre dois cliques no mesmo link).
   */
  async consume(tokenId, userId, passwordHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const consumed = await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
          WHERE id = $1 AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > NOW()
          RETURNING *`,
        [tokenId],
      );
      if (consumed.rows.length === 0) { await client.query('ROLLBACK'); return undefined; }

      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
      // Os restantes pedidos pendentes deixam de valer.
      await client.query(
        `UPDATE password_reset_tokens SET invalidated_at = NOW()
          WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [userId],
      );
      await client.query('COMMIT');
      return rowToResetToken(consumed.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Pedidos recentes de um utilizador — trava o abuso do formulário. */
  async countRecent(userId, sinceIso) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS total FROM password_reset_tokens WHERE user_id = $1 AND created_at >= $2',
      [userId, sinceIso],
    );
    return Number(rows[0].total);
  },

  /** Limpeza dos expirados — manutenção, não corre sozinha. */
  async pruneExpired() {
    const { rowCount } = await pool.query(
      'DELETE FROM password_reset_tokens WHERE expires_at < NOW() - INTERVAL \'7 days\'',
    );
    return rowCount;
  },
};

// ─── AuditRepository ──────────────────────────────────────────────────────────
// Registo de auditoria (spec § 3.21). APPEND-ONLY: não existe update nem delete
// neste repositório, de propósito.

function rowToAuditEvent(row) {
  return {
    id:            row.id,
    company_id:    row.company_id,
    seq:           Number(row.seq),
    occurred_at:   isoOf(row.occurred_at),
    actor_id:      row.actor_id ?? undefined,
    actor_email:   row.actor_email ?? undefined,
    actor_role:    row.actor_role ?? undefined,
    action:        row.action,
    entity_type:   row.entity_type ?? undefined,
    entity_id:     row.entity_id ?? undefined,
    entity_label:  row.entity_label ?? undefined,
    summary:       row.summary,
    metadata:      row.metadata ?? {},
    outcome:       row.outcome,
    status_code:   row.status_code === null || row.status_code === undefined ? undefined : Number(row.status_code),
    method:        row.method ?? undefined,
    path:          row.path ?? undefined,
    ip:            row.ip ?? undefined,
    user_agent:    row.user_agent ?? undefined,
    request_id:    row.request_id ?? undefined,
    duration_ms:   row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
    hash:          row.hash,
    previous_hash: row.previous_hash,
  };
}

const AuditRepository = {
  /**
   * Acrescenta um evento à cadeia da empresa.
   *
   * O bloqueio consultivo por empresa (`pg_advisory_xact_lock`) serializa as
   * escritas do MESMO tenant durante a transação: é o que garante uma sequência
   * sem buracos e um encadeamento sem bifurcações. Empresas diferentes não se
   * bloqueiam entre si.
   *
   * @param {object} event
   * @param {(e:object)=>string} sign assinatura (núcleo puro do serviço)
   * @param {string} genesisHash
   */
  async append(event, sign, genesisHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${event.company_id}`]);

      const previous = await client.query(
        'SELECT seq, hash FROM audit_events WHERE company_id = $1 ORDER BY seq DESC LIMIT 1',
        [event.company_id],
      );
      const seq = previous.rows.length ? Number(previous.rows[0].seq) + 1 : 1;
      const previousHash = previous.rows.length ? previous.rows[0].hash : genesisHash;
      const occurredAt = new Date().toISOString();

      const signed = { ...event, seq, occurred_at: occurredAt, previous_hash: previousHash };
      const hash = sign(signed);

      const { rows } = await client.query(`
        INSERT INTO audit_events (
          id, company_id, seq, occurred_at, actor_id, actor_email, actor_role,
          action, entity_type, entity_id, entity_label, summary, metadata, outcome,
          status_code, method, path, ip, user_agent, request_id, duration_ms,
          hash, previous_hash, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
        RETURNING *
      `, [
        signed.id, signed.company_id, seq, occurredAt, signed.actor_id, signed.actor_email, signed.actor_role,
        signed.action, signed.entity_type, signed.entity_id, signed.entity_label, signed.summary,
        JSON.stringify(signed.metadata ?? {}), signed.outcome,
        signed.status_code, signed.method, signed.path, signed.ip, signed.user_agent, signed.request_id, signed.duration_ms,
        hash, previousHash,
      ]);

      await client.query('COMMIT');
      return rowToAuditEvent(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /** Lista com filtros. Filtra pela empresa em contexto (SUPERADMIN vê todas). */
  async list(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.from) { params.push(opts.from); clauses.push(`occurred_at >= $${params.length}`); }
    if (opts.to) { params.push(opts.to); clauses.push(`occurred_at < $${params.length}`); }
    if (opts.action) { params.push(opts.action); clauses.push(`action = $${params.length}`); }
    if (opts.actor) { params.push(opts.actor); clauses.push(`(actor_id = $${params.length} OR actor_email = $${params.length})`); }
    if (opts.entity_type) { params.push(opts.entity_type); clauses.push(`entity_type = $${params.length}`); }
    if (opts.entity_id) { params.push(opts.entity_id); clauses.push(`entity_id = $${params.length}`); }
    if (opts.outcome) { params.push(opts.outcome); clauses.push(`outcome = $${params.length}`); }
    if (opts.search) {
      params.push(`%${String(opts.search).toLowerCase()}%`);
      const p = `$${params.length}`;
      clauses.push(`(lower(summary) LIKE ${p} OR lower(action) LIKE ${p} OR lower(coalesce(actor_email,'')) LIKE ${p} OR lower(coalesce(entity_label,'')) LIKE ${p})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = Number((await pool.query(`SELECT COUNT(*) AS total FROM audit_events ${where}`, params)).rows[0].total);
    const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const { rows } = await pool.query(
      `SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC, seq DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: rows.map(rowToAuditEvent), total };
  },

  /** Resumo do período: volume, recusas, erros e atores distintos. */
  async stats(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.from) { params.push(opts.from); clauses.push(`occurred_at >= $${params.length}`); }
    if (opts.to) { params.push(opts.to); clauses.push(`occurred_at < $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT COUNT(*)::int                                          AS total,
             COUNT(*) FILTER (WHERE outcome = 'denied')::int        AS denied,
             COUNT(*) FILTER (WHERE outcome = 'error')::int         AS errors,
             COUNT(DISTINCT actor_id)::int                          AS actors,
             MIN(occurred_at)                                       AS first_at,
             MAX(occurred_at)                                       AS last_at
        FROM audit_events ${where}
    `, params);
    const r = rows[0];

    const top = await pool.query(
      `SELECT action, COUNT(*)::int AS total FROM audit_events ${where} GROUP BY action ORDER BY total DESC LIMIT 8`,
      params,
    );

    return {
      total: Number(r.total), denied: Number(r.denied), errors: Number(r.errors), actors: Number(r.actors),
      first_at: r.first_at ? isoOf(r.first_at) : undefined,
      last_at: r.last_at ? isoOf(r.last_at) : undefined,
      top_actions: top.rows.map((a) => ({ action: a.action, total: Number(a.total) })),
    };
  },

  async distinctActions() {
    const params = [];
    const { rows } = await pool.query(
      `SELECT DISTINCT action FROM audit_events${companyWhere(params)} ORDER BY action`, params,
    );
    return rows.map((r) => r.action);
  },

  /** Empresas com eventos — entrada da verificação de integridade. */
  async listCompanies() {
    const params = [];
    const { rows } = await pool.query(
      `SELECT DISTINCT company_id FROM audit_events${companyWhere(params)} ORDER BY company_id`, params,
    );
    return rows.map((r) => r.company_id);
  },

  /** Cadeia completa de uma empresa, por ordem de sequência. */
  async listChain(companyId) {
    const { rows } = await pool.query(
      'SELECT * FROM audit_events WHERE company_id = $1 ORDER BY seq', [companyId],
    );
    return rows.map(rowToAuditEvent);
  },
};

// ─── DocumentSeriesRepository ─────────────────────────────────────────────────
// Séries de numeração (spec § 3.19). Uma empresa pode ter várias séries por tipo
// de documento (ex.: uma por loja); cada uma numera de forma independente.

function rowToSeries(row) {
  return {
    id:         row.id,
    company_id: row.company_id,
    doc_type:   row.doc_type,
    series:     row.series,
    year:       Number(row.year),
    last_seq:   Number(row.last_seq),
    active:     row.active,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  };
}

const DocumentSeriesRepository = {
  async list(year) {
    const params = [year];
    const { rows } = await pool.query(
      `SELECT * FROM document_series WHERE year = $1${companyClause(params)} ORDER BY doc_type, series`,
      params,
    );
    return rows.map(rowToSeries);
  },

  /** Regista uma série nova a zeros (a numeração começa na primeira emissão). */
  async ensure({ company_id, doc_type, series, year }) {
    const cid = company_id ?? writeCompanyId();
    const { rows } = await pool.query(`
      INSERT INTO document_series (id, company_id, doc_type, series, year, last_seq)
      VALUES ($1,$2,$3,$4,$5,0)
      ON CONFLICT (company_id, doc_type, series, year) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [`ds-${cid}-${doc_type}-${series}-${year}`, cid, doc_type, series, year]);
    return rowToSeries(rows[0]);
  },

  async setActive(id, active) {
    const params = [active, id];
    const { rows } = await pool.query(
      `UPDATE document_series SET active = $1, updated_at = NOW() WHERE id = $2${companyClause(params)} RETURNING *`,
      params,
    );
    return rows.length ? rowToSeries(rows[0]) : undefined;
  },
};

// ─── CompanyRepository ────────────────────────────────────────────────────────
// Entidade de topo do multi-tenant (spec § 2.4). Sem filtro de empresa: a gestão
// de empresas é da plataforma (SUPERADMIN) e do registo público.

function rowToCompany(row) {
  return {
    id:         row.id,
    name:       row.name,
    slug:       row.slug ?? undefined,
    status:     row.status,
    plan:       row.plan ?? undefined,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  };
}

const CompanyRepository = {
  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1 LIMIT 1', [id]);
    return rows.length ? rowToCompany(rows[0]) : undefined;
  },

  async findBySlug(slug) {
    const { rows } = await pool.query('SELECT * FROM companies WHERE slug = $1 LIMIT 1', [slug]);
    return rows.length ? rowToCompany(rows[0]) : undefined;
  },

  async list() {
    const { rows } = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
    return rows.map(rowToCompany);
  },

  async create(c) {
    const { rows } = await pool.query(`
      INSERT INTO companies (id, name, slug, status, plan, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
      RETURNING *
    `, [c.id, c.name, c.slug ?? null, c.status ?? 'active', c.plan ?? null]);
    return rowToCompany(rows[0]);
  },

  async update(id, patch) {
    const sets = [];
    const params = [];
    const col = (name, value) => { params.push(value); sets.push(`${name} = $${params.length}`); };
    if (patch.name   !== undefined) col('name', patch.name);
    if (patch.status !== undefined) col('status', patch.status);
    if (patch.plan   !== undefined) col('plan', patch.plan);
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE companies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return rows.length ? rowToCompany(rows[0]) : undefined;
  },

  /** Contagem de utilizadores/pedidos + plano por empresa (resumo do SUPERADMIN). */
  async getStats() {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.status,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id)  AS users,
        (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) AS orders,
        s.plan_code, s.status AS subscription_status, p.name AS plan_name, p.price_cents
      FROM companies c
      LEFT JOIN subscriptions s ON s.company_id = c.id
      LEFT JOIN plans p         ON p.code = s.plan_code
      ORDER BY c.created_at DESC
    `);
    return rows.map((r) => ({
      id: r.id, name: r.name, status: r.status,
      users: Number(r.users), orders: Number(r.orders),
      plan_code:           r.plan_code ?? undefined,
      plan_name:           r.plan_name ?? undefined,
      subscription_status: r.subscription_status ?? undefined,
      price_cents:         r.price_cents === null || r.price_cents === undefined ? undefined : Number(r.price_cents),
    }));
  },
};

// ─── Planos, subscrições, uso e faturas de subscrição (SaaS — spec § 2.5) ─────
// Camada de negócio da PLATAFORMA sobre as empresas. `plans` é catálogo global
// (sem empresa). `subscriptions`/`usage_counters` são sempre acedidos com a
// empresa explícita (o caminho da quota já a tem). Só `subscription_invoices`
// usa o filtro por contexto: o ADMIN vê as suas, o SUPERADMIN (sem empresa no
// contexto) vê todas.

function rowToPlan(row) {
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    code:                 row.code,
    name:                 row.name,
    description:          row.description ?? undefined,
    price_cents:          Number(row.price_cents),
    currency:             row.currency,
    trial_days:           Number(row.trial_days),
    max_orders_per_month: num(row.max_orders_per_month),
    max_users:            num(row.max_users),
    max_warehouses:       num(row.max_warehouses),
    features:             row.features ?? {},
    self_serve:           row.self_serve,
    active:               row.active,
    sort_order:           Number(row.sort_order),
    created_at:           isoOf(row.created_at),
    updated_at:           isoOf(row.updated_at),
  };
}

const PlanRepository = {
  async list(opts = {}) {
    const where = opts.activeOnly ? 'WHERE active = TRUE' : '';
    const { rows } = await pool.query(`SELECT * FROM plans ${where} ORDER BY sort_order, price_cents`);
    return rows.map(rowToPlan);
  },

  async findByCode(code) {
    const { rows } = await pool.query('SELECT * FROM plans WHERE code = $1 LIMIT 1', [code]);
    return rows.length ? rowToPlan(rows[0]) : undefined;
  },

  async create(p) {
    const { rows } = await pool.query(`
      INSERT INTO plans (code, name, description, price_cents, currency, trial_days,
                         max_orders_per_month, max_users, max_warehouses, features, self_serve, active, sort_order,
                         created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
      RETURNING *
    `, [
      p.code, p.name, p.description ?? null, p.price_cents ?? 0, p.currency ?? 'MZN', p.trial_days ?? 14,
      p.max_orders_per_month ?? null, p.max_users ?? null, p.max_warehouses ?? null,
      JSON.stringify(p.features ?? {}), p.self_serve ?? true, p.active ?? true, p.sort_order ?? 0,
    ]);
    return rowToPlan(rows[0]);
  },

  async update(code, patch) {
    const sets = [];
    const params = [];
    const col = (name, value) => { params.push(value); sets.push(`${name} = $${params.length}`); };
    if (patch.name                 !== undefined) col('name', patch.name);
    if (patch.description          !== undefined) col('description', patch.description);
    if (patch.price_cents          !== undefined) col('price_cents', patch.price_cents);
    if (patch.trial_days           !== undefined) col('trial_days', patch.trial_days);
    if (patch.max_orders_per_month !== undefined) col('max_orders_per_month', patch.max_orders_per_month);
    if (patch.max_users            !== undefined) col('max_users', patch.max_users);
    if (patch.max_warehouses       !== undefined) col('max_warehouses', patch.max_warehouses);
    if (patch.features             !== undefined) col('features', JSON.stringify(patch.features));
    if (patch.self_serve           !== undefined) col('self_serve', patch.self_serve);
    if (patch.active               !== undefined) col('active', patch.active);
    if (patch.sort_order           !== undefined) col('sort_order', patch.sort_order);
    if (sets.length === 0) return this.findByCode(code);
    params.push(code);
    const { rows } = await pool.query(
      `UPDATE plans SET ${sets.join(', ')}, updated_at = NOW() WHERE code = $${params.length} RETURNING *`,
      params,
    );
    return rows.length ? rowToPlan(rows[0]) : undefined;
  },
};

function rowToSubscription(row) {
  return {
    id:                   row.id,
    company_id:           row.company_id,
    plan_code:            row.plan_code,
    status:               row.status,
    trial_ends_at:        row.trial_ends_at ? isoOf(row.trial_ends_at) : undefined,
    current_period_start: isoOf(row.current_period_start),
    current_period_end:   isoOf(row.current_period_end),
    past_due_since:       row.past_due_since ? isoOf(row.past_due_since) : undefined,
    canceled_at:          row.canceled_at ? isoOf(row.canceled_at) : undefined,
    created_at:           isoOf(row.created_at),
    updated_at:           isoOf(row.updated_at),
  };
}

const SubscriptionRepository = {
  async findByCompany(companyId) {
    const { rows } = await pool.query('SELECT * FROM subscriptions WHERE company_id = $1 LIMIT 1', [companyId]);
    return rows.length ? rowToSubscription(rows[0]) : undefined;
  },

  async create(s) {
    const { rows } = await pool.query(`
      INSERT INTO subscriptions (id, company_id, plan_code, status, trial_ends_at,
                                 current_period_start, current_period_end, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      ON CONFLICT (company_id) DO NOTHING
      RETURNING *
    `, [s.id, s.company_id, s.plan_code, s.status, s.trial_ends_at ?? null, s.current_period_start, s.current_period_end]);
    // Corrida no registo: a linha já existe — devolve a vencedora.
    return rows.length ? rowToSubscription(rows[0]) : this.findByCompany(s.company_id);
  },

  async update(id, patch) {
    const sets = [];
    const params = [];
    const col = (name, value) => { params.push(value); sets.push(`${name} = $${params.length}`); };
    if (patch.plan_code            !== undefined) col('plan_code', patch.plan_code);
    if (patch.status               !== undefined) col('status', patch.status);
    if (patch.trial_ends_at        !== undefined) col('trial_ends_at', patch.trial_ends_at);
    if (patch.current_period_start !== undefined) col('current_period_start', patch.current_period_start);
    if (patch.current_period_end   !== undefined) col('current_period_end', patch.current_period_end);
    if (patch.past_due_since       !== undefined) col('past_due_since', patch.past_due_since);
    if (patch.canceled_at          !== undefined) col('canceled_at', patch.canceled_at);
    if (sets.length === 0) return undefined;
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE subscriptions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return rows.length ? rowToSubscription(rows[0]) : undefined;
  },

  /** Contagem de recursos sujeitos a limite de plano, numa só ida à base. */
  async countResources(companyId) {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users      WHERE company_id = $1) AS users,
        (SELECT COUNT(*) FROM warehouses WHERE company_id = $1) AS warehouses,
        (SELECT COUNT(*) FROM drivers    WHERE company_id = $1) AS drivers
    `, [companyId]);
    const r = rows[0];
    return { users: Number(r.users), warehouses: Number(r.warehouses), drivers: Number(r.drivers) };
  },

  /** Visão da plataforma: subscrição + empresa + plano (consola SUPERADMIN). */
  async listWithDetails() {
    const { rows } = await pool.query(`
      SELECT s.*, c.name AS company_name, c.status AS company_status,
             p.name AS plan_name, p.price_cents
      FROM subscriptions s
      JOIN companies c ON c.id = s.company_id
      LEFT JOIN plans p ON p.code = s.plan_code
      ORDER BY c.created_at DESC
    `);
    return rows.map((r) => ({
      ...rowToSubscription(r),
      company_name:   r.company_name,
      company_status: r.company_status,
      plan_name:      r.plan_name ?? r.plan_code,
      price_cents:    Number(r.price_cents ?? 0),
    }));
  },
};

const UsageRepository = {
  /** Consumo do período (0 quando ainda não houve registo). */
  async get(companyId, period, metric) {
    const { rows } = await pool.query(
      'SELECT count FROM usage_counters WHERE company_id = $1 AND period = $2 AND metric = $3 LIMIT 1',
      [companyId, period, metric],
    );
    return rows.length ? Number(rows[0].count) : 0;
  },

  /** Incremento atómico — o contador é a fonte de verdade da quota mensal. */
  async increment(companyId, period, metric, by = 1) {
    const { rows } = await pool.query(`
      INSERT INTO usage_counters (company_id, period, metric, count, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (company_id, period, metric)
      DO UPDATE SET count = usage_counters.count + $4, updated_at = NOW()
      RETURNING count
    `, [companyId, period, metric, by]);
    return Number(rows[0].count);
  },
};

function rowToSubscriptionInvoice(row) {
  return {
    id:             row.id,
    number:         row.number,
    company_id:     row.company_id,
    company_name:   row.company_name,
    plan_code:      row.plan_code,
    plan_name:      row.plan_name,
    period_start:   isoOf(row.period_start),
    period_end:     isoOf(row.period_end),
    subtotal_cents: Number(row.subtotal_cents),
    tax_rate_pct:   Number(row.tax_rate_pct),
    tax_cents:      Number(row.tax_cents),
    total_cents:    Number(row.total_cents),
    status:         row.status,
    payment_method: row.payment_method ?? undefined,
    payment_ref:    row.payment_ref ?? undefined,
    seq:            row.seq === null || row.seq === undefined ? undefined : Number(row.seq),
    hash:           row.hash ?? undefined,
    previous_hash:  row.previous_hash ?? undefined,
    hash_control:   row.hash_control ?? undefined,
    signed_at:      row.signed_at ? isoOf(row.signed_at) : undefined,
    issued_at:      isoOf(row.issued_at),
    paid_at:        row.paid_at ? isoOf(row.paid_at) : undefined,
    voided_at:      row.voided_at ? isoOf(row.voided_at) : undefined,
    created_at:     isoOf(row.created_at),
    updated_at:     isoOf(row.updated_at),
  };
}

const SubscriptionInvoiceRepository = {
  /**
   * Emite a fatura do período numa transação (numeração SB{ano}/{seq}) e
   * **assina-a encadeada** na anterior (spec § 3.19) — as faturas que a
   * plataforma emite às empresas são documentos fiscais da plataforma e seguem
   * a mesma regra de inviolabilidade das faturas das empresas.
   *
   * Idempotente por (empresa, início do período): a renovação preguiçosa pode
   * correr em pedidos concorrentes e só uma fatura deve sobreviver.
   *
   * @param {object} inv
   * @param {(input:{number:string,issuedAt:string,signedAt:string,totalCents:number,previousHash?:string}) => {hash:string,hash_control:string,previous_hash:string,signed_at:string}} [sign]
   */
  async createWithNumber(inv, sign) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const year = now.getUTCFullYear();
      const seqRes = await client.query(`
        INSERT INTO subscription_invoice_counters (year, last_seq) VALUES ($1, 1)
        ON CONFLICT (year) DO UPDATE SET last_seq = subscription_invoice_counters.last_seq + 1
        RETURNING last_seq
      `, [year]);
      const seq = Number(seqRes.rows[0].last_seq);
      const number = `SB${year}/${String(seq).padStart(4, '0')}`;

      let signature = { hash: null, previous_hash: null, hash_control: null, signed_at: null };
      if (typeof sign === 'function') {
        const prevRes = await client.query(
          `SELECT hash FROM subscription_invoices WHERE hash IS NOT NULL ORDER BY signed_at DESC, seq DESC LIMIT 1`,
        );
        const issuedAt = now.toISOString();
        signature = sign({
          number, issuedAt, signedAt: issuedAt,
          totalCents: inv.total_cents, previousHash: prevRes.rows[0]?.hash,
        });
      }

      const { rows } = await client.query(`
        INSERT INTO subscription_invoices (
          id, number, seq, company_id, company_name, plan_code, plan_name, period_start, period_end,
          subtotal_cents, tax_rate_pct, tax_cents, total_cents, status,
          hash, previous_hash, hash_control, signed_at,
          issued_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'issued',$14,$15,$16,$17,NOW(),NOW(),NOW())
        RETURNING *
      `, [
        inv.id, number, seq, inv.company_id, inv.company_name, inv.plan_code, inv.plan_name,
        inv.period_start, inv.period_end, inv.subtotal_cents, inv.tax_rate_pct, inv.tax_cents, inv.total_cents,
        signature.hash, signature.previous_hash, signature.hash_control, signature.signed_at,
      ]);
      await client.query('COMMIT');
      return rowToSubscriptionInvoice(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        const existing = await this.findActiveByPeriod(inv.company_id, inv.period_start);
        if (existing) return existing;
      }
      throw err;
    } finally {
      client.release();
    }
  },

  async findActiveByPeriod(companyId, periodStart) {
    const { rows } = await pool.query(
      `SELECT * FROM subscription_invoices WHERE company_id = $1 AND period_start = $2 AND status <> 'void' LIMIT 1`,
      [companyId, periodStart],
    );
    return rows.length ? rowToSubscriptionInvoice(rows[0]) : undefined;
  },

  async findById(id) {
    const params = [id];
    const { rows } = await pool.query(
      `SELECT * FROM subscription_invoices WHERE id = $1${companyClause(params)} LIMIT 1`, params,
    );
    return rows.length ? rowToSubscriptionInvoice(rows[0]) : undefined;
  },

  /** Lista as faturas da empresa em contexto (todas, para o SUPERADMIN). */
  async list(opts = {}) {
    const clauses = [];
    const params = [];
    const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`company_id = $${params.length}`); }
    if (opts.company_id) { params.push(opts.company_id); clauses.push(`company_id = $${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const { rows } = await pool.query(
      `SELECT * FROM subscription_invoices ${where} ORDER BY issued_at DESC LIMIT ${limit}`, params,
    );
    return rows.map(rowToSubscriptionInvoice);
  },

  /**
   * Anula as faturas por pagar a partir de um período (mudança de plano: o ciclo
   * em curso deixa de valer ao preço antigo).
   */
  async voidOutstandingFrom(companyId, fromPeriodStart) {
    const { rows } = await pool.query(`
      UPDATE subscription_invoices
         SET status = 'void', voided_at = NOW(), updated_at = NOW()
       WHERE company_id = $1 AND status = 'issued' AND period_start >= $2
       RETURNING *
    `, [companyId, fromPeriodStart]);
    return rows.map(rowToSubscriptionInvoice);
  },

  async update(id, patch) {
    const sets = [];
    const params = [];
    const col = (name, value) => { params.push(value); sets.push(`${name} = $${params.length}`); };
    if (patch.status         !== undefined) col('status', patch.status);
    if (patch.payment_method !== undefined) col('payment_method', patch.payment_method);
    if (patch.payment_ref    !== undefined) col('payment_ref', patch.payment_ref);
    if (patch.paid_at        !== undefined) col('paid_at', patch.paid_at);
    if (patch.voided_at      !== undefined) col('voided_at', patch.voided_at);
    if (sets.length === 0) return this.findById(id);
    params.push(id);
    const idClause = `id = $${params.length}${companyClause(params)}`;
    const { rows } = await pool.query(
      `UPDATE subscription_invoices SET ${sets.join(', ')}, updated_at = NOW() WHERE ${idClause} RETURNING *`,
      params,
    );
    return rows.length ? rowToSubscriptionInvoice(rows[0]) : undefined;
  },

  /** Receita da plataforma (SUPERADMIN): MRR e faturação por cobrar. */
  async getPlatformStats() {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COALESCE(SUM(p.price_cents), 0)
           FROM subscriptions s JOIN plans p ON p.code = s.plan_code
          WHERE s.status IN ('active', 'past_due'))                                        AS mrr_cents,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'trialing')                     AS trialing,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'active')                       AS active,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'past_due')                     AS past_due,
        (SELECT COUNT(*) FROM subscriptions WHERE status = 'canceled')                     AS canceled,
        (SELECT COALESCE(SUM(total_cents), 0) FROM subscription_invoices WHERE status = 'issued') AS outstanding_cents,
        (SELECT COALESCE(SUM(total_cents), 0) FROM subscription_invoices WHERE status = 'paid')   AS collected_cents
    `);
    const r = rows[0];
    return {
      mrr_cents:         Number(r.mrr_cents),
      trialing:          Number(r.trialing),
      active:            Number(r.active),
      past_due:          Number(r.past_due),
      canceled:          Number(r.canceled),
      outstanding_cents: Number(r.outstanding_cents),
      collected_cents:   Number(r.collected_cents),
    };
  },
};

const HrRepository = {
  async listDepartments() {
    const params = [];
    const { rows } = await pool.query(`SELECT d.*, COUNT(e.id)::int AS employee_count
      FROM hr_departments d LEFT JOIN hr_employees e ON e.department_id=d.id AND e.company_id=d.company_id
      ${companyWhere(params, 'd')} GROUP BY d.id ORDER BY d.name`, params);
    return rows.map((r) => ({ ...r, created_at: isoOf(r.created_at), updated_at: isoOf(r.updated_at) }));
  },
  async createDepartment(d) {
    const { rows } = await pool.query(`INSERT INTO hr_departments
      (id,company_id,name,code,manager_name,description,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.id, writeCompanyId(), d.name, d.code, d.manager_name ?? null, d.description ?? null, d.status ?? 'active']);
    return rows[0];
  },
  async listEmployees(opts = {}) {
    const clauses = []; const params = []; const cid = readCompanyId();
    if (cid) { params.push(cid); clauses.push(`e.company_id=$${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`e.status=$${params.length}`); }
    if (opts.departmentId) { params.push(opts.departmentId); clauses.push(`e.department_id=$${params.length}`); }
    if (opts.search) { params.push(`%${String(opts.search).toLowerCase()}%`); const p=`$${params.length}`; clauses.push(`(lower(e.full_name) LIKE ${p} OR lower(e.employee_number) LIKE ${p} OR lower(coalesce(e.email,'')) LIKE ${p})`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number((await pool.query(`SELECT COUNT(*) AS total FROM hr_employees e ${where}`, params)).rows[0].total);
    const limit=Math.min(Math.max(Number(opts.limit)||20,1),100), offset=Math.max(Number(opts.offset)||0,0);
    const { rows } = await pool.query(`SELECT e.*,d.name AS department_name FROM hr_employees e
      LEFT JOIN hr_departments d ON d.id=e.department_id AND d.company_id=e.company_id ${where}
      ORDER BY e.full_name LIMIT ${limit} OFFSET ${offset}`, params);
    return { items: rows.map((r)=>({ ...r, created_at:isoOf(r.created_at), updated_at:isoOf(r.updated_at) })), total };
  },
  async findEmployee(id) {
    const params=[id]; const { rows }=await pool.query(`SELECT e.*,d.name AS department_name FROM hr_employees e
      LEFT JOIN hr_departments d ON d.id=e.department_id AND d.company_id=e.company_id WHERE e.id=$1${companyClause(params,'e')} LIMIT 1`,params);
    return rows[0];
  },
  /**
   * TODOS os colaboradores ativos da empresa, sem paginação.
   * A folha salarial não pode usar `listEmployees`: essa lista está limitada a
   * 100 por página e uma empresa com mais gente ficava com pessoas de fora da
   * folha, em silêncio.
   */
  async listActiveEmployeesForPayroll() {
    const params=[];
    const { rows }=await pool.query(
      `SELECT id, employee_number, full_name, salary_cents FROM hr_employees
        WHERE status='active'${companyClause(params)} ORDER BY full_name`, params);
    return rows.map((r)=>({ ...r, salary_cents: Number(r.salary_cents) }));
  },
  async createEmployee(e) {
    const { rows }=await pool.query(`INSERT INTO hr_employees
      (id,company_id,employee_number,full_name,email,phone,tax_id,birth_date,gender,address,emergency_contact,department_id,shift_id,job_title,employment_type,hire_date,salary_cents,bank_details,status,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [e.id,writeCompanyId(),e.employee_number,e.full_name,e.email??null,e.phone??null,e.tax_id??null,e.birth_date??null,e.gender??null,JSON.stringify(e.address??{}),JSON.stringify(e.emergency_contact??{}),e.department_id??null,e.shift_id??null,e.job_title,e.employment_type,e.hire_date,e.salary_cents??0,JSON.stringify(e.bank_details??{}),e.status??'active',e.notes??null]);
    return rows[0];
  },
  async updateEmployee(id, patch) {
    const allowed=['full_name','email','phone','tax_id','birth_date','gender','department_id','shift_id','job_title','employment_type','hire_date','salary_cents','status','notes'];
    const sets=[]; const params=[]; for(const key of allowed){if(patch[key]!==undefined){params.push(patch[key]);sets.push(`${key}=$${params.length}`);}}
    if(!sets.length) return this.findEmployee(id); params.push(id);
    const { rows }=await pool.query(`UPDATE hr_employees SET ${sets.join(',')},updated_at=NOW() WHERE id=$${params.length}${companyClause(params)} RETURNING *`,params); return rows[0];
  },
  async listLeaves(opts={}) {
    const params=[]; const clauses=[]; const cid=readCompanyId(); if(cid){params.push(cid);clauses.push(`l.company_id=$${params.length}`);} if(opts.status){params.push(opts.status);clauses.push(`l.status=$${params.length}`);}
    const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:''; const { rows }=await pool.query(`SELECT l.*,e.full_name AS employee_name,e.employee_number FROM hr_leave_requests l JOIN hr_employees e ON e.id=l.employee_id AND e.company_id=l.company_id ${where} ORDER BY l.created_at DESC`,params); return rows;
  },
  async createLeave(l) { const {rows}=await pool.query(`INSERT INTO hr_leave_requests(id,company_id,employee_id,type,start_date,end_date,days,reason,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,[l.id,writeCompanyId(),l.employee_id,l.type,l.start_date,l.end_date,l.days,l.reason??null]);return rows[0]; },
  async findLeave(id){const params=[id];const {rows}=await pool.query(`SELECT * FROM hr_leave_requests WHERE id=$1${companyClause(params)} LIMIT 1`,params);return rows[0];},
  /** Licenças do colaborador que se cruzam com o período (pendentes ou aprovadas). */
  async findOverlappingLeaves(employeeId,startDate,endDate){
    const params=[employeeId,startDate,endDate];
    const {rows}=await pool.query(
      `SELECT * FROM hr_leave_requests
        WHERE employee_id=$1 AND status IN ('pending','approved')
          AND start_date <= $3 AND end_date >= $2${companyClause(params)}`,params);
    return rows;
  },
  /**
   * Decide a licença — SÓ a partir de `pending`, para uma decisão não poder ser
   * revertida em cadeia depois de o saldo já ter sido consumido.
   */
  async decideLeave(id,status,notes,userId){const params=[status,notes??null,userId??null,id];const {rows}=await pool.query(`UPDATE hr_leave_requests SET status=$1,decision_notes=$2,decided_by=$3,decided_at=NOW(),updated_at=NOW() WHERE id=$4 AND status='pending'${companyClause(params)} RETURNING *`,params);return rows[0];},
  async findLeaveBalance(employeeId,year){const params=[employeeId,year];const {rows}=await pool.query(`SELECT *,entitled_days+carried_days-used_days AS available_days FROM hr_leave_balances WHERE employee_id=$1 AND year=$2${companyClause(params)} LIMIT 1`,params);return rows[0];},
  /**
   * Desconta dias do saldo de férias de forma ATÓMICA: a própria condição do
   * UPDATE garante que não se gasta mais do que há, mesmo com duas aprovações
   * em simultâneo. Devolve undefined quando não havia saldo suficiente.
   */
  async consumeLeaveBalance(employeeId,year,days){
    const params=[days,employeeId,year];
    const {rows}=await pool.query(
      `UPDATE hr_leave_balances SET used_days=used_days+$1,updated_at=NOW()
        WHERE employee_id=$2 AND year=$3 AND entitled_days+carried_days-used_days >= $1${companyClause(params)}
        RETURNING *,entitled_days+carried_days-used_days AS available_days`,params);
    return rows[0];
  },
  async listAttendance(opts={}){const params=[];const clauses=[];const cid=readCompanyId();if(cid){params.push(cid);clauses.push(`a.company_id=$${params.length}`);}if(opts.date){params.push(opts.date);clauses.push(`a.work_date=$${params.length}`);}if(opts.employeeId){params.push(opts.employeeId);clauses.push(`a.employee_id=$${params.length}`);}const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';const {rows}=await pool.query(`SELECT a.*,e.full_name AS employee_name,e.employee_number FROM hr_attendance a JOIN hr_employees e ON e.id=a.employee_id AND e.company_id=a.company_id ${where} ORDER BY a.work_date DESC,e.full_name`,params);return rows;},
  /** Turno por id — base do cálculo de assiduidade (spec § 3.18). */
  async findShift(id){const params=[id];const {rows}=await pool.query(`SELECT * FROM hr_shifts WHERE id=$1${companyClause(params)} LIMIT 1`,params);return rows[0];},
  /** Turnos ativos da empresa; havendo só um, vale para toda a gente. */
  async listActiveShifts(){const params=[];const {rows}=await pool.query(`SELECT * FROM hr_shifts WHERE active=TRUE${companyClause(params)} ORDER BY created_at`,params);return rows;},
  async findAttendance(employeeId,workDate){const params=[employeeId,workDate];const {rows}=await pool.query(`SELECT * FROM hr_attendance WHERE employee_id=$1 AND work_date=$2${companyClause(params)} LIMIT 1`,params);return rows[0];},
  async createAttendance(a){const {rows}=await pool.query(`INSERT INTO hr_attendance(id,company_id,employee_id,work_date,clock_in,clock_out,break_minutes,worked_minutes,late_minutes,overtime_minutes,status,notes,adjusted_by,adjusted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[a.id,writeCompanyId(),a.employee_id,a.work_date,a.clock_in??null,a.clock_out??null,a.break_minutes??60,a.worked_minutes??0,a.late_minutes??0,a.overtime_minutes??0,a.status??'present',a.notes??null,a.adjusted_by??null,a.adjusted_at??null]);return rows[0];},
  async updateAttendance(id,a){const params=[a.clock_in??null,a.clock_out??null,a.break_minutes??60,a.worked_minutes??0,a.late_minutes??0,a.overtime_minutes??0,a.status??'present',a.notes??null,a.adjusted_by??null,a.adjusted_at??null,id];const {rows}=await pool.query(`UPDATE hr_attendance SET clock_in=$1,clock_out=$2,break_minutes=$3,worked_minutes=$4,late_minutes=$5,overtime_minutes=$6,status=$7,notes=$8,adjusted_by=$9,adjusted_at=$10,updated_at=NOW() WHERE id=$11${companyClause(params)} RETURNING *`,params);return rows[0];},
  async attendanceStats(date){const params=[];const clauses=[];const cid=readCompanyId();if(cid){params.push(cid);clauses.push(`company_id=$${params.length}`);}if(date){params.push(date);clauses.push(`work_date=$${params.length}`);}const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';const r=(await pool.query(`SELECT COUNT(*)::int AS present,COUNT(*) FILTER(WHERE late_minutes>0)::int AS late,COALESCE(SUM(worked_minutes),0)::int AS worked_minutes,COALESCE(SUM(overtime_minutes),0)::int AS overtime_minutes FROM hr_attendance ${where}`,params)).rows[0];return r;},
  async listPayroll(){const params=[];const {rows}=await pool.query(`SELECT * FROM hr_payroll_runs${companyWhere(params)} ORDER BY period DESC`,params);return rows.map(r=>({...r,gross_cents:Number(r.gross_cents),deductions_cents:Number(r.deductions_cents),net_cents:Number(r.net_cents)}));},
  async findPayrollByPeriod(period){const params=[period];const {rows}=await pool.query(`SELECT * FROM hr_payroll_runs WHERE period=$1${companyClause(params)} LIMIT 1`,params);return rows[0];},
  async getPayroll(id){const params=[id];const {rows}=await pool.query(`SELECT * FROM hr_payroll_runs WHERE id=$1${companyClause(params)} LIMIT 1`,params);if(!rows[0])return undefined;const p=[id];const items=(await pool.query(`SELECT i.*,e.full_name AS employee_name,e.employee_number FROM hr_payroll_items i JOIN hr_employees e ON e.id=i.employee_id AND e.company_id=i.company_id WHERE i.payroll_id=$1${companyClause(p,'i')} ORDER BY e.full_name`,p)).rows;return{...rows[0],gross_cents:Number(rows[0].gross_cents),deductions_cents:Number(rows[0].deductions_cents),net_cents:Number(rows[0].net_cents),items};},
  async createPayroll(run,items){const c=await pool.connect();try{await c.query('BEGIN');await c.query(`INSERT INTO hr_payroll_runs(id,company_id,period,status,employee_count,gross_cents,deductions_cents,net_cents) VALUES($1,$2,$3,'draft',$4,$5,$6,$7)`,[run.id,writeCompanyId(),run.period,items.length,run.gross_cents,run.deductions_cents,run.net_cents]);for(const i of items)await c.query(`INSERT INTO hr_payroll_items(id,company_id,payroll_id,employee_id,base_salary_cents,allowances_cents,bonus_cents,overtime_cents,tax_cents,social_security_cents,other_deductions_cents,gross_cents,deductions_cents,net_cents) VALUES($1,$2,$3,$4,$5,0,0,0,0,0,0,$5,0,$5)`,[i.id,writeCompanyId(),run.id,i.employee_id,i.base_salary_cents]);await c.query('COMMIT');return this.getPayroll(run.id);}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}},
  async updatePayrollItem(payrollId,employeeId,i){const params=[i.allowances_cents,i.bonus_cents,i.overtime_cents,i.tax_cents,i.social_security_cents,i.other_deductions_cents,i.gross_cents,i.deductions_cents,i.net_cents,i.notes??null,payrollId,employeeId];const {rows}=await pool.query(`UPDATE hr_payroll_items SET allowances_cents=$1,bonus_cents=$2,overtime_cents=$3,tax_cents=$4,social_security_cents=$5,other_deductions_cents=$6,gross_cents=$7,deductions_cents=$8,net_cents=$9,notes=$10,updated_at=NOW() WHERE payroll_id=$11 AND employee_id=$12${companyClause(params)} RETURNING *`,params);return rows[0];},
  async refreshPayrollTotals(id){const params=[id];const cid=readCompanyId();let filter='';if(cid){params.push(cid);filter=` AND company_id=$2`;}const totals=(await pool.query(`SELECT COUNT(*)::int AS n,COALESCE(SUM(gross_cents),0) AS gross,COALESCE(SUM(deductions_cents),0) AS deductions,COALESCE(SUM(net_cents),0) AS net FROM hr_payroll_items WHERE payroll_id=$1${filter}`,params)).rows[0];await pool.query(`UPDATE hr_payroll_runs SET employee_count=$1,gross_cents=$2,deductions_cents=$3,net_cents=$4,updated_at=NOW() WHERE id=$5${cid?' AND company_id=$6':''}`,[Number(totals.n),Number(totals.gross),Number(totals.deductions),Number(totals.net),id,...(cid?[cid]:[])]);return this.getPayroll(id);},
  async setPayrollStatus(id,status,userId){const field=status==='approved'?'approved':'paid';const params=[status,userId,id];const {rows}=await pool.query(`UPDATE hr_payroll_runs SET status=$1,${field}_by=$2,${field}_at=NOW(),updated_at=NOW() WHERE id=$3${companyClause(params)} RETURNING *`,params);return rows[0];},
  async listJobs(){const params=[];const {rows}=await pool.query(`SELECT j.*,d.name AS department_name,COUNT(c.id)::int AS candidate_count FROM hr_jobs j LEFT JOIN hr_departments d ON d.id=j.department_id AND d.company_id=j.company_id LEFT JOIN hr_candidates c ON c.job_id=j.id AND c.company_id=j.company_id${companyWhere(params,'j')} GROUP BY j.id,d.name ORDER BY j.created_at DESC`,params);return rows;},
  async createJob(j){const {rows}=await pool.query(`INSERT INTO hr_jobs(id,company_id,title,department_id,location,employment_type,openings,status,description,requirements,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10) RETURNING *`,[j.id,writeCompanyId(),j.title,j.department_id??null,j.location??null,j.employment_type,j.openings,j.description??null,j.requirements??null,j.created_by??null]);return rows[0];},
  async listCandidates(jobId){const params=[];const clauses=[];const cid=readCompanyId();if(cid){params.push(cid);clauses.push(`c.company_id=$${params.length}`);}if(jobId){params.push(jobId);clauses.push(`c.job_id=$${params.length}`);}const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';const {rows}=await pool.query(`SELECT c.*,j.title AS job_title FROM hr_candidates c JOIN hr_jobs j ON j.id=c.job_id AND j.company_id=c.company_id ${where} ORDER BY c.created_at DESC`,params);return rows;},
  async createCandidate(c){const {rows}=await pool.query(`INSERT INTO hr_candidates(id,company_id,job_id,full_name,email,phone,stage,source,notes,rating) VALUES($1,$2,$3,$4,$5,$6,'applied',$7,$8,$9) RETURNING *`,[c.id,writeCompanyId(),c.job_id,c.full_name,c.email??null,c.phone??null,c.source??null,c.notes??null,c.rating??null]);return rows[0];},
  async updateCandidateStage(id,stage,notes,userId){const params=[stage,notes??null,userId??null,id];const {rows}=await pool.query(`UPDATE hr_candidates SET stage=$1,notes=COALESCE($2,notes),stage_changed_by=$3,stage_changed_at=NOW(),updated_at=NOW() WHERE id=$4${companyClause(params)} RETURNING *`,params);return rows[0];},
  async listPerformance(){const params=[];const {rows}=await pool.query(`SELECT r.*,e.full_name AS employee_name,e.employee_number,e.job_title FROM hr_performance_reviews r JOIN hr_employees e ON e.id=r.employee_id AND e.company_id=r.company_id${companyWhere(params,'r')} ORDER BY r.created_at DESC`,params);return rows.map(r=>({...r,final_score:Number(r.final_score)}));},
  async findPerformance(employeeId,period){const params=[employeeId,period];const {rows}=await pool.query(`SELECT * FROM hr_performance_reviews WHERE employee_id=$1 AND period=$2${companyClause(params)} LIMIT 1`,params);return rows[0];},
  async createPerformance(r){const {rows}=await pool.query(`INSERT INTO hr_performance_reviews(id,company_id,employee_id,period,scores,final_score,goals,feedback,development_plan,status,reviewer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING *`,[r.id,writeCompanyId(),r.employee_id,r.period,JSON.stringify(r.scores),r.final_score,JSON.stringify(r.goals??[]),r.feedback??null,r.development_plan??null,r.reviewer_id??null]);return rows[0];},
  async completePerformance(id,userId){const params=[userId,id];const {rows}=await pool.query(`UPDATE hr_performance_reviews SET status='completed',completed_by=$1,completed_at=NOW(),updated_at=NOW() WHERE id=$2 AND status='draft'${companyClause(params)} RETURNING *`,params);return rows[0];},
  async stats(){const params=[];const where=companyWhere(params);const {rows}=await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='active')::int AS active,COUNT(*) FILTER(WHERE status='on_leave')::int AS on_leave,COALESCE(SUM(salary_cents) FILTER(WHERE status='active'),0)::bigint AS payroll_cents FROM hr_employees${where}`,params);const p=[];const pending=Number((await pool.query(`SELECT COUNT(*) AS n FROM hr_leave_requests${companyWhere(p)}${p.length?' AND':' WHERE'} status='pending'`,p)).rows[0].n);return {...rows[0],payroll_cents:Number(rows[0].payroll_cents),pending_leaves:pending};}
};

const FinanceRepository={
 async listAccounts(){const p=[];const{rows}=await pool.query(`SELECT * FROM finance_accounts${companyWhere(p)} ORDER BY code`,p);return rows;},
 async createAccount(a){const{rows}=await pool.query(`INSERT INTO finance_accounts(id,company_id,code,name,category,parent_id,active) VALUES($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,[a.id,writeCompanyId(),a.code,a.name,a.category,a.parent_id??null]);return rows[0];},
 async listEntries(o={}){const p=[];const c=[];const cid=readCompanyId();if(cid){p.push(cid);c.push(`e.company_id=$${p.length}`);}if(o.type){p.push(o.type);c.push(`e.type=$${p.length}`);}if(o.status){if(o.status==='overdue')c.push(`e.status='open' AND e.due_date<CURRENT_DATE`);else{p.push(o.status);c.push(`e.status=$${p.length}`);}}if(o.search){p.push(`%${String(o.search).toLowerCase()}%`);const q=`$${p.length}`;c.push(`(lower(e.description) LIKE ${q} OR lower(coalesce(e.party_name,'')) LIKE ${q} OR lower(coalesce(e.document_number,'')) LIKE ${q})`);}const w=c.length?`WHERE ${c.join(' AND ')}`:'';const{rows}=await pool.query(`SELECT e.*,a.code AS account_code,a.name AS account_name,CASE WHEN e.status='open' AND e.due_date<CURRENT_DATE THEN 'overdue' ELSE e.status END AS display_status FROM finance_entries e LEFT JOIN finance_accounts a ON a.id=e.account_id AND a.company_id=e.company_id ${w} ORDER BY e.due_date DESC,e.created_at DESC`,p);return rows;},
 async findEntry(id){const p=[id];const{rows}=await pool.query(`SELECT * FROM finance_entries WHERE id=$1${companyClause(p)} LIMIT 1`,p);return rows[0];},
 async createEntry(e){const{rows}=await pool.query(`INSERT INTO finance_entries(id,company_id,type,description,party_name,document_number,account_id,amount_cents,due_date,status,created_by,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11) RETURNING *`,[e.id,writeCompanyId(),e.type,e.description,e.party_name??null,e.document_number??null,e.account_id??null,e.amount_cents,e.due_date,e.created_by??null,e.notes??null]);return rows[0];},
 async settleEntry(id,d,userId){const p=[d.payment_method,d.payment_reference??null,userId,id];const{rows}=await pool.query(`UPDATE finance_entries SET status='paid',payment_method=$1,payment_reference=$2,settled_by=$3,paid_at=NOW(),updated_at=NOW() WHERE id=$4 AND status='open'${companyClause(p)} RETURNING *`,p);return rows[0];},
 async voidEntry(id,userId){const p=[userId,id];const{rows}=await pool.query(`UPDATE finance_entries SET status='void',voided_by=$1,voided_at=NOW(),updated_at=NOW() WHERE id=$2 AND status='open'${companyClause(p)} RETURNING *`,p);return rows[0];},
 async summary(){const p=[];const{rows}=await pool.query(`SELECT COALESCE(SUM(amount_cents) FILTER(WHERE type='receivable' AND status='paid'),0) AS income,COALESCE(SUM(amount_cents) FILTER(WHERE type='payable' AND status='paid'),0) AS expense,COALESCE(SUM(amount_cents) FILTER(WHERE type='receivable' AND status='open'),0) AS receivable,COALESCE(SUM(amount_cents) FILTER(WHERE type='payable' AND status='open'),0) AS payable,COALESCE(SUM(amount_cents) FILTER(WHERE status='open' AND due_date<CURRENT_DATE),0) AS overdue FROM finance_entries${companyWhere(p)}`,p);const r=rows[0];return{cash_balance_cents:Number(r.income)-Number(r.expense),income_paid_cents:Number(r.income),expense_paid_cents:Number(r.expense),receivable_open_cents:Number(r.receivable),payable_open_cents:Number(r.payable),overdue_cents:Number(r.overdue)};}
};
/** Modais de duas/três rodas (§ 3.33) — usado para agregar a frota de última milha. */
const MODAL_TWO_THREE_WHEELS = new Set(
  require('../domain/delivery-modals').listModals().filter((m) => m.wheels <= 3).map((m) => m.code),
);

const FleetRepository={
 async listVehicles(){const p=[];const{rows}=await pool.query(`SELECT *,CASE WHEN insurance_expiry<CURRENT_DATE OR inspection_expiry<CURRENT_DATE THEN TRUE ELSE FALSE END AS document_expired,CASE WHEN insurance_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE+30 OR inspection_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE+30 THEN TRUE ELSE FALSE END AS document_expiring FROM fleet_vehicles${companyWhere(p)} ORDER BY plate`,p);return rows;},
 async findVehicle(id){const p=[id];const{rows}=await pool.query(`SELECT * FROM fleet_vehicles WHERE id=$1${companyClause(p)} LIMIT 1`,p);return rows[0];},
 async createVehicle(v){const{rows}=await pool.query(`INSERT INTO fleet_vehicles(id,company_id,plate,make,model,year,vehicle_type,fuel_type,odometer_km,status,insurance_expiry,inspection_expiry,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[v.id,writeCompanyId(),v.plate,v.make,v.model,v.year??null,v.vehicle_type??null,v.fuel_type,v.odometer_km??0,v.status??'available',v.insurance_expiry??null,v.inspection_expiry??null,v.notes??null]);return rows[0];},
 async latestFullFuel(vehicleId){const p=[vehicleId];const{rows}=await pool.query(`SELECT * FROM fleet_fuel_entries WHERE vehicle_id=$1 AND full_tank=TRUE${companyClause(p)} ORDER BY odometer_km DESC LIMIT 1`,p);return rows[0];},
 async createFuel(f){const c=await pool.connect();try{await c.query('BEGIN');const{rows}=await c.query(`INSERT INTO fleet_fuel_entries(id,company_id,vehicle_id,fuel_date,odometer_km,volume_ml,cost_cents,full_tank,station,driver_id,consumption_l_per_100km,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[f.id,writeCompanyId(),f.vehicle_id,f.fuel_date,f.odometer_km,f.volume_ml,f.cost_cents,f.full_tank,f.station??null,f.driver_id??null,f.consumption_l_per_100km??null,f.created_by??null]);await c.query(`UPDATE fleet_vehicles SET odometer_km=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3`,[f.odometer_km,f.vehicle_id,writeCompanyId()]);await c.query('COMMIT');return rows[0];}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}},
 async listFuel(vehicleId){const p=[];let w=companyWhere(p,'f');if(vehicleId){p.push(vehicleId);w+=`${w?' AND':' WHERE'} f.vehicle_id=$${p.length}`;}const{rows}=await pool.query(`SELECT f.*,v.plate,v.make,v.model FROM fleet_fuel_entries f JOIN fleet_vehicles v ON v.id=f.vehicle_id AND v.company_id=f.company_id${w} ORDER BY f.fuel_date DESC,f.created_at DESC`,p);return rows.map(r=>({...r,consumption_l_per_100km:r.consumption_l_per_100km==null?null:Number(r.consumption_l_per_100km)}));},
 async stats(){const p=[];const v=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status!='inactive')::int active,COUNT(*) FILTER(WHERE status='maintenance')::int maintenance FROM fleet_vehicles${companyWhere(p)}`,p)).rows[0];const q=[];const f=(await pool.query(`SELECT COALESCE(SUM(cost_cents),0) cost,COALESCE(SUM(volume_ml),0) volume,COALESCE(AVG(consumption_l_per_100km) FILTER(WHERE consumption_l_per_100km IS NOT NULL),0) consumption FROM fleet_fuel_entries${companyWhere(q)}`,q)).rows[0];
  // Contagem por modal (§ 3.33) agregada em SQL, não em JavaScript sobre a
  // lista toda: a frota de duas/três rodas é a que mais cresce e é a métrica
  // que a operação abre todos os dias.
  const m=[];const byModal=(await pool.query(`SELECT COALESCE(vehicle_type,'INDEFINIDO') modal,COUNT(*)::int total FROM fleet_vehicles${companyWhere(m)} GROUP BY 1 ORDER BY 2 DESC`,m)).rows;
  const two=byModal.filter(r=>MODAL_TWO_THREE_WHEELS.has(r.modal)).reduce((s,r)=>s+Number(r.total),0);
  return{total:Number(v.total),active:Number(v.active),maintenance:Number(v.maintenance),fuel_cost_cents:Number(f.cost),fuel_volume_ml:Number(f.volume),average_consumption:Number(f.consumption),by_modal:byModal.map(r=>({modal:r.modal,total:Number(r.total)})),two_three_wheelers:two};}
};
const HrOperationsRepository = {
  async list(table) { const params=[]; const {rows}=await pool.query(`SELECT * FROM ${table}${companyWhere(params)} ORDER BY created_at DESC`,params); return rows; },
  /**
   * Insere numa das tabelas de operações de RH (todas com o mesmo formato).
   *
   * Arrays e objetos são serializados para JSON: as colunas `work_days`,
   * `items` e `participant_ids` são JSONB e o driver `pg`, deixado à vontade,
   * converte um array JS num literal de array do Postgres (`{1,2}`) — que o
   * JSONB recusa (array não vazio dava erro; array vazio entrava como `{}`,
   * um objeto em vez de uma lista).
   */
  async create(table,data) {
    const record={...data,company_id:writeCompanyId()};
    const keys=Object.keys(record);
    const values=keys.map((k)=>{const v=record[k];return Array.isArray(v)||(v!==null&&typeof v==='object'&&!(v instanceof Date))?JSON.stringify(v):v;});
    const cols=keys.join(','); const args=keys.map((_,i)=>`$${i+1}`).join(',');
    const {rows}=await pool.query(`INSERT INTO ${table} (${cols}) VALUES (${args}) RETURNING *`,values);
    return rows[0];
  },
  async upsertLeaveBalance(data) { const {rows}=await pool.query(`INSERT INTO hr_leave_balances(id,company_id,employee_id,year,entitled_days,carried_days,used_days,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(company_id,employee_id,year) DO UPDATE SET entitled_days=EXCLUDED.entitled_days,carried_days=EXCLUDED.carried_days,used_days=EXCLUDED.used_days,updated_at=NOW() RETURNING *`,[data.id,writeCompanyId(),data.employee_id,data.year,data.entitled_days,data.carried_days,data.used_days,data.created_by]); return rows[0]; },
  async summary(){const cid=readCompanyId();const p=cid?[cid]:[];const where=cid?' WHERE company_id=$1':'';const [balances,time,documents,checklists,training,benefits]=await Promise.all([
    pool.query(`SELECT COALESCE(SUM(entitled_days+carried_days-used_days),0) value FROM hr_leave_balances${where}`,p),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN type='credit' THEN minutes ELSE -minutes END),0) value FROM hr_time_bank${where}`,p),
    pool.query(`SELECT COUNT(*) value FROM hr_documents${where}${cid?' AND':' WHERE'} expires_at IS NOT NULL AND expires_at<=CURRENT_DATE+30`,p),
    pool.query(`SELECT COALESCE(SUM(jsonb_array_length(items)),0) total,COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(items) i WHERE (i->>'completed')::boolean)),0) done FROM hr_checklists${where}`,p),
    pool.query(`SELECT COUNT(*) value FROM hr_trainings${where}${cid?' AND':' WHERE'} status IN ('planned','in_progress')`,p),
    pool.query(`SELECT COALESCE(SUM(amount_cents),0) benefits,COALESCE(SUM(CASE WHEN kind='advance' THEN balance_cents ELSE 0 END),0) advances FROM hr_benefits${where}${cid?' AND':' WHERE'} status='active'`,p),
  ]);return{leave_available_days:Number(balances.rows[0].value),time_bank_minutes:Number(time.rows[0].value),documents_expiring:Number(documents.rows[0].value),checklist_items:Number(checklists.rows[0].total),checklist_done:Number(checklists.rows[0].done),active_trainings:Number(training.rows[0].value),active_benefits_cents:Number(benefits.rows[0].benefits),advance_balance_cents:Number(benefits.rows[0].advances)};}
};

const HrPortalRepository = {
  async findEmployeeByUser(userId){const params=[userId];const{rows}=await pool.query(`SELECT e.*,d.name department_name FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id AND d.company_id=e.company_id WHERE e.user_id=$1${companyClause(params,'e')} LIMIT 1`,params);return rows[0];},
  async provisionAccount({user,employeeId}){const c=await pool.connect();try{await c.query('BEGIN');const cid=writeCompanyId();const found=await c.query('SELECT id,user_id FROM hr_employees WHERE id=$1 AND company_id=$2 FOR UPDATE',[employeeId,cid]);if(!found.rows[0]){const e=new Error('Colaborador não encontrado.');e.code='EMPLOYEE_NOT_FOUND';throw e;}if(found.rows[0].user_id){const e=new Error('O colaborador já possui uma conta.');e.code='EMPLOYEE_LINKED';throw e;}await c.query('INSERT INTO users(id,name,email,password_hash,role,company_id) VALUES($1,$2,$3,$4,\'EMPLOYEE\',$5)',[user.id,user.name,user.email,user.password_hash,cid]);await c.query('UPDATE hr_employees SET user_id=$1,email=COALESCE(email,$2),updated_at=NOW() WHERE id=$3 AND company_id=$4',[user.id,user.email,employeeId,cid]);await c.query('COMMIT');return{id:user.id,email:user.email,role:'EMPLOYEE',employee_id:employeeId};}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}},
  async dashboard(employeeId){const cid=writeCompanyId();const p=[employeeId,cid];const [profile,balances,attendance,leaves,timeBank,documents,trainings,benefits,performance,payslips]=await Promise.all([
    pool.query('SELECT e.id,e.employee_number,e.full_name,e.email,e.phone,e.job_title,e.employment_type,e.hire_date,e.status,d.name department_name FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id AND d.company_id=e.company_id WHERE e.id=$1 AND e.company_id=$2',p),
    pool.query('SELECT *,entitled_days+carried_days-used_days available_days FROM hr_leave_balances WHERE employee_id=$1 AND company_id=$2 ORDER BY year DESC',p),
    pool.query('SELECT * FROM hr_attendance WHERE employee_id=$1 AND company_id=$2 ORDER BY work_date DESC LIMIT 31',p),
    pool.query('SELECT * FROM hr_leave_requests WHERE employee_id=$1 AND company_id=$2 ORDER BY created_at DESC',p),
    pool.query("SELECT *,SUM(CASE WHEN type='credit' THEN minutes ELSE -minutes END) OVER() balance_minutes FROM hr_time_bank WHERE employee_id=$1 AND company_id=$2 ORDER BY entry_date DESC",p),
    pool.query('SELECT id,type,title,reference,issued_at,expires_at,status,file_url,created_at FROM hr_documents WHERE employee_id=$1 AND company_id=$2 ORDER BY created_at DESC',p),
    pool.query("SELECT * FROM hr_trainings WHERE company_id=$2 AND participant_ids ? $1 ORDER BY start_date DESC",p),
    pool.query('SELECT * FROM hr_benefits WHERE employee_id=$1 AND company_id=$2 ORDER BY created_at DESC',p),
    pool.query("SELECT id,period,scores,final_score,goals,feedback,development_plan,completed_at FROM hr_performance_reviews WHERE employee_id=$1 AND company_id=$2 AND status='completed' ORDER BY completed_at DESC",p),
    pool.query("SELECT i.*,r.period,r.status FROM hr_payroll_items i JOIN hr_payroll_runs r ON r.id=i.payroll_id AND r.company_id=i.company_id WHERE i.employee_id=$1 AND i.company_id=$2 AND r.status IN ('approved','paid') ORDER BY r.period DESC",p),
  ]);return{profile:profile.rows[0],leave_balance:balances.rows[0]||null,attendance:attendance.rows,leaves:leaves.rows,time_bank_minutes:Number(timeBank.rows[0]?.balance_minutes||0),time_bank:timeBank.rows,documents:documents.rows,trainings:trainings.rows,benefits:benefits.rows.map(r=>({...r,amount_cents:Number(r.amount_cents),balance_cents:Number(r.balance_cents)})),performance:performance.rows,payslips:payslips.rows.map(r=>({...r,base_salary_cents:Number(r.base_salary_cents),gross_cents:Number(r.gross_cents),deductions_cents:Number(r.deductions_cents),net_cents:Number(r.net_cents)}))};}
};

module.exports = { OrderRepository, DriverRepository, UserRepository, UserLocationRepository, WarehouseRepository, SettlementRepository, SupportRepository, ClientRepository, ContractRepository, PricingRepository, InvoiceRepository, DocumentSeriesRepository, AuditRepository, PasswordResetRepository, CompanyRepository, CompanyProfileRepository, PlanRepository, SubscriptionRepository, UsageRepository, SubscriptionInvoiceRepository, HrRepository, HrOperationsRepository, HrPortalRepository, FinanceRepository, FleetRepository };
