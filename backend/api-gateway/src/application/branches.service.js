/**
 * @file branches.service.js
 * @description Âmbito de filial — quem vê que base da operação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * A FILIAL É O ARMAZÉM. Não há entidade nova: `warehouses` já tem nome, morada,
 * GPS e código, e uma segunda tabela com os mesmos campos ficaria a divergir à
 * primeira base criada só num dos sítios.
 *
 * ISTO NÃO É UMA FRONTEIRA DE SEGURANÇA. A fronteira é a empresa (`company_id`,
 * imposta em SQL em todas as leituras); o âmbito de filial é uma lente sobre os
 * dados da própria empresa. Quem usar a atribuição de filiais para esconder algo
 * de um colega vai ser desmentido pelo primeiro relatório que ele abrir.
 */
'use strict';

const pool = require('../infrastructure/db');
const { readCompanyId, writeCompanyId } = require('../infrastructure/tenant-context');

// ─── Decisões puras ──────────────────────────────────────────────────────────

/**
 * Um utilizador está restrito? PURA.
 *
 * SEM FILIAIS ATRIBUÍDAS = VÊ TUDO. É o contrário do que a intuição sugere, e é
 * deliberado: no dia da migração ninguém tem filiais atribuídas, e exigir
 * atribuição trancaria toda a gente fora do sistema de uma só vez.
 *
 * @param {string[]|null|undefined} branches
 * @returns {boolean}
 */
function isRestricted(branches) {
  return Array.isArray(branches) && branches.length > 0;
}

/**
 * O utilizador pode ver esta encomenda? PURA.
 *
 * A ORIGEM **OU** A LOCALIZAÇÃO ATUAL. Uma encomenda entra por uma filial
 * (`branch_id`, que nunca muda) e viaja por outras (`warehouse_id`, que muda com
 * as transferências do § 3.36). Sem o OU, uma transferência a caminho seria
 * invisível precisamente à base que a tem de receber — e o § 3.36 obriga essa
 * base a conferir o que chega.
 *
 * UMA ENCOMENDA SEM FILIAL É VISÍVEL A TODOS: as anteriores a esta migração não
 * têm origem registada, e desaparecerem de vista seria pior do que serem vistas
 * a mais.
 *
 * @param {{ branch_id?: string|null, warehouse_id?: string|null }} order
 * @param {string[]|null} branches
 * @returns {boolean}
 */
function canSeeOrder(order, branches) {
  if (!isRestricted(branches)) return true;
  if (!order) return false;
  if (!order.branch_id && !order.warehouse_id) return true;

  return branches.includes(order.branch_id) || branches.includes(order.warehouse_id);
}

/**
 * Cláusula SQL do âmbito, acrescentada aos parâmetros existentes. PURA quanto ao
 * resultado — muta `params`, como as restantes cláusulas deste ficheiro fazem.
 *
 * A filtragem é em SQL e não em JavaScript porque a lista de encomendas é
 * paginada (§ 3.1): filtrar depois de paginar devolveria páginas com menos
 * linhas do que o pedido, e uma contagem que não bate certo com o que se vê.
 *
 * @param {string[]|null} branches
 * @param {Array} params
 * @param {string} [alias]
 * @returns {string} '' quando não há restrição
 */
function orderScopeClause(branches, params, alias = '') {
  if (!isRestricted(branches)) return '';
  const p = alias ? `${alias}.` : '';
  params.push(branches);
  const i = params.length;

  return ` AND (${p}branch_id = ANY($${i}) OR ${p}warehouse_id = ANY($${i})`
    + ` OR (${p}branch_id IS NULL AND ${p}warehouse_id IS NULL))`;
}

/**
 * Cláusula do âmbito para tabelas que têm base de afetação e não localização
 * (motoristas, viaturas). PURA quanto ao resultado.
 */
function resourceScopeClause(branches, params, column = 'branch_id') {
  if (!isRestricted(branches)) return '';
  params.push(branches);

  return ` AND (${column} = ANY($${params.length}) OR ${column} IS NULL)`;
}

/**
 * Reparte totais por filial, resolvendo os nomes. PURA.
 *
 * A linha "sem filial" NÃO é omitida: se 300 encomendas não tiverem origem
 * registada, a soma das filiais não bate com o total da empresa, e quem lê fica
 * a achar que perdeu encomendas.
 *
 * @param {Array<{ branch_id: string|null, total: number }>} rows
 * @param {Array<{ id: string, name: string }>} warehouses
 */
function labelBranchRows(rows, warehouses) {
  const nomes = new Map(warehouses.map((w) => [w.id, w.name]));

  return rows.map((r) => ({
    branch_id: r.branch_id ?? null,
    branch_name: r.branch_id ? (nomes.get(r.branch_id) ?? 'Filial removida') : 'Sem filial atribuída',
    ...r,
  }));
}

// ─── Leitura e escrita ───────────────────────────────────────────────────────

/**
 * Filiais de um utilizador, lidas da BASE e não do token.
 *
 * Gravado no token, retirar uma filial a alguém só faria efeito no próximo
 * início de sessão — e uma restrição que demora horas a aplicar-se não é uma
 * restrição. O índice `idx_user_branches_user` é o que torna esta escolha
 * sustentável.
 *
 * @param {string} userId
 * @returns {Promise<string[]>} vazio = sem restrição
 */
async function getUserBranches(userId) {
  if (!userId) return [];
  const params = [userId];
  let where = ' WHERE user_id = $1';

  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND company_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT warehouse_id FROM user_branches${where} ORDER BY warehouse_id`, params,
  );
  return rows.map((r) => r.warehouse_id);
}

/**
 * Substitui as filiais de um utilizador.
 *
 * Substitui em vez de acrescentar: o ecrã mostra o conjunto completo, e uma
 * escrita incremental deixaria filiais para trás sempre que alguém desmarcasse
 * uma caixa.
 *
 * @param {string} userId
 * @param {string[]} warehouseIds
 */
async function setUserBranches(userId, warehouseIds) {
  const lista = [...new Set((warehouseIds ?? []).filter(Boolean))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_branches WHERE user_id = $1', [userId]);

    for (const wid of lista) {
      await client.query(
        `INSERT INTO user_branches (user_id, warehouse_id, company_id) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, warehouse_id) DO NOTHING`,
        [userId, wid, writeCompanyId()],
      );
    }
    await client.query('COMMIT');
    return lista;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** As filiais da empresa — que são os armazéns ativos. */
async function listBranches() {
  const params = [];
  let where = " WHERE status = 'active'";

  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND company_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, code, name, address FROM warehouses${where} ORDER BY name`, params,
  );
  return rows;
}

/**
 * Operação repartida por filial de origem.
 *
 * Conta pela origem e não pela localização: é a origem que responde a "quanto
 * produz cada base", e a localização mudaria a resposta a meio do trânsito.
 */
async function getBranchBreakdown({ days = 30 } = {}) {
  const params = [days];
  let where = ' WHERE created_at >= NOW() - ($1 || \' days\')::interval';

  const cid = readCompanyId();
  if (cid) { params.push(cid); where += ` AND company_id = $${params.length}`; }

  const { rows } = await pool.query(`
    SELECT branch_id,
           COUNT(*)::int                                              AS total,
           COUNT(*) FILTER (WHERE current_status = 'delivered')::int  AS delivered,
           COUNT(*) FILTER (WHERE current_status = 'failed')::int     AS failed,
           COALESCE(SUM(value), 0)::bigint                            AS revenue_cents
      FROM orders${where}
     GROUP BY branch_id
     ORDER BY total DESC
  `, params);

  const armazens = await listBranches();
  return {
    days,
    branches: labelBranchRows(
      rows.map((r) => ({ ...r, revenue_cents: Number(r.revenue_cents) })),
      armazens,
    ),
  };
}

module.exports = {
  // Puros
  isRestricted,
  canSeeOrder,
  orderScopeClause,
  resourceScopeClause,
  labelBranchRows,
  // Leitura e escrita
  getUserBranches,
  setUserBranches,
  listBranches,
  getBranchBreakdown,
};
