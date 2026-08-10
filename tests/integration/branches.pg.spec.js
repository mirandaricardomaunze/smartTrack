/**
 * @file branches.pg.spec.js
 * @description Âmbito de filial contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * A decisão de visibilidade é pura e está coberta em branches.service.spec.ts.
 * O que só a base mostra é se a cláusula SQL faz mesmo o que a função pura
 * promete — e, sobretudo, que a lente de filial não abre uma brecha na fronteira
 * que conta: a empresa. Um âmbito que filtra por filial mas deixa passar dados
 * de outra empresa seria muito pior do que não existir.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const branches = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/branches.service`) : null;
const repos    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-branch';
const OUTRA   = 'company-itest-branch-2';
const MAPUTO  = 'wh-itest-maputo';
const BEIRA   = 'wh-itest-beira';
const UTILIZADOR = 'user-itest-branch';

/** Corre `fn` na empresa, com o âmbito de filial pedido. */
function comAmbito(companyId, filiais, fn) {
  return tenant.runWithCompany(companyId, async () => {
    tenant.setBranchScope(filiais);
    return fn();
  });
}

async function semearPedido({ id, branch, warehouse, empresa = EMPRESA }) {
  await pool.query(`
    INSERT INTO orders (id, client_id, tracking_code, current_status, origin, destination,
      value, history, created_at, updated_at, company_id, branch_id, warehouse_id)
    VALUES ($1,'cli-itest-branch',$2,'created','{}'::jsonb,'{}'::jsonb,0,'[]'::jsonb,
      NOW(),NOW(),$3,$4,$5)
  `, [id, `TRK9${id.slice(-8)}BR`, empresa, branch, warehouse]);
}

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM orders WHERE company_id = ANY($1)', [[EMPRESA, OUTRA]]);
  await pool.query('DELETE FROM user_branches WHERE user_id = $1', [UTILIZADOR]);
  await pool.query('DELETE FROM warehouses WHERE id = ANY($1)', [[MAPUTO, BEIRA]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[EMPRESA, OUTRA]]);
}

describe.skipIf(!disponivel)('âmbito de filial · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    for (const c of [EMPRESA, OUTRA]) {
      await pool.query(
        `INSERT INTO companies (id, name, slug, status) VALUES ($1,$1,$1,'active')`, [c],
      );
    }
    for (const [id, nome] of [[MAPUTO, 'Maputo — Sede'], [BEIRA, 'Beira']]) {
      await pool.query(
        `INSERT INTO warehouses (id, code, name, company_id, status) VALUES ($1,$1,$2,$3,'active')`,
        [id, nome, EMPRESA],
      );
    }

    await semearPedido({ id: 'ord-br-beira',    branch: BEIRA,  warehouse: BEIRA });
    await semearPedido({ id: 'ord-br-transito', branch: MAPUTO, warehouse: BEIRA });
    await semearPedido({ id: 'ord-br-fora',     branch: BEIRA,  warehouse: MAPUTO });
    await semearPedido({ id: 'ord-br-alheia',   branch: MAPUTO, warehouse: MAPUTO });
    await semearPedido({ id: 'ord-br-legado',   branch: null,   warehouse: null });
    // Mesma filial, empresa diferente: a armadilha que este teste existe para
    // apanhar.
    await semearPedido({ id: 'ord-br-outra-empresa', branch: BEIRA, warehouse: BEIRA, empresa: OUTRA });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should list only what the branch has to do with', async () => {
    const { items, total } = await comAmbito(EMPRESA, [BEIRA],
      () => repos.OrderRepository.list({ limit: 50 }));
    const ids = items.map((o) => o.id);

    expect(ids).toContain('ord-br-beira');
    expect(ids).toContain('ord-br-transito');   // a caminho, tem de ser conferida
    expect(ids).toContain('ord-br-fora');       // é da Beira, ainda que longe
    expect(ids).toContain('ord-br-legado');     // sem origem registada
    expect(ids).not.toContain('ord-br-alheia');
    // A contagem é feita com a mesma cláusula: uma que ignorasse o âmbito daria
    // uma paginação com páginas vazias no fim.
    expect(total).toBe(ids.length);
  });

  it('should not let the branch lens leak another company', async () => {
    // A fronteira que conta é a empresa. Este pedido tem a MESMA filial.
    const { items } = await comAmbito(EMPRESA, [BEIRA],
      () => repos.OrderRepository.list({ limit: 50 }));

    expect(items.map((o) => o.id)).not.toContain('ord-br-outra-empresa');
  });

  it('should show the whole company to a user with no branches', async () => {
    const { items } = await comAmbito(EMPRESA, null,
      () => repos.OrderRepository.list({ limit: 50 }));

    expect(items).toHaveLength(5);
  });

  it('should refuse to open a foreign order by id', async () => {
    // Sem isto, bastava escrever o id na barra de endereço: uma lista filtrada
    // com detalhe aberto não é uma lente, é uma ilusão.
    const alheia = await comAmbito(EMPRESA, [BEIRA],
      () => repos.OrderRepository.findById('ord-br-alheia'));
    const propria = await comAmbito(EMPRESA, [BEIRA],
      () => repos.OrderRepository.findById('ord-br-beira'));

    expect(alheia).toBeUndefined();
    expect(propria?.id).toBe('ord-br-beira');
  });

  it('should keep the screen filters from widening the scope', async () => {
    // O utilizador da Beira a pedir explicitamente o armazém de Maputo continua
    // a ver só o que é seu: o âmbito é uma restrição, não uma escolha.
    const { items } = await comAmbito(EMPRESA, [BEIRA],
      () => repos.OrderRepository.list({ warehouse_id: MAPUTO, limit: 50 }));

    expect(items.map((o) => o.id)).toEqual(['ord-br-fora']);
  });

  it('should stamp the origin branch on an order created by a single-branch user', async () => {
    const criada = await comAmbito(EMPRESA, [BEIRA], () => repos.OrderRepository.create({
      id: 'ord-br-nova', client_id: 'cli-itest-branch', tracking_code: 'TRK900000777BR',
      current_status: 'created', origin: {}, destination: {}, value: 0, history: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }));

    expect(criada.branch_id).toBe(BEIRA);
  });

  it('should leave the origin empty when the user covers more than one branch', async () => {
    // Escolher a primeira atribuiria receita à base errada, e uma atribuição
    // errada é pior do que nenhuma: tem o aspeto de um facto.
    const criada = await comAmbito(EMPRESA, [BEIRA, MAPUTO], () => repos.OrderRepository.create({
      id: 'ord-br-nova-2', client_id: 'cli-itest-branch', tracking_code: 'TRK900000778BR',
      current_status: 'created', origin: {}, destination: {}, value: 0, history: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }));

    expect(criada.branch_id).toBeNull();
  });

  it('should read a user scope back from the database, not from a token', async () => {
    // É o que permite retirar uma filial a alguém e isso valer já no pedido
    // seguinte, sem novo início de sessão.
    await tenant.runWithCompany(EMPRESA, () => branches.setUserBranches(UTILIZADOR, [BEIRA, MAPUTO]));
    expect(await tenant.runWithCompany(EMPRESA, () => branches.getUserBranches(UTILIZADOR)))
      .toEqual([BEIRA, MAPUTO].sort());

    await tenant.runWithCompany(EMPRESA, () => branches.setUserBranches(UTILIZADOR, [BEIRA]));
    expect(await tenant.runWithCompany(EMPRESA, () => branches.getUserBranches(UTILIZADOR)))
      .toEqual([BEIRA]);

    // Sem filiais = vê tudo (§ 3.45), e não "não vê nada".
    await tenant.runWithCompany(EMPRESA, () => branches.setUserBranches(UTILIZADOR, []));
    expect(await tenant.runWithCompany(EMPRESA, () => branches.getUserBranches(UTILIZADOR)))
      .toEqual([]);
  });

  it('should break the operation down by branch without losing the orphans', async () => {
    const { branches: linhas } = await tenant.runWithCompany(EMPRESA,
      () => branches.getBranchBreakdown({ days: 1 }));

    const semFilial = linhas.find((l) => l.branch_id === null);
    expect(semFilial.branch_name).toBe('Sem filial atribuída');
    expect(linhas.reduce((s, l) => s + l.total, 0)).toBe(7);
  });
});
