/**
 * @file clients.pg.spec.js
 * @description Testes de integração do registo de clientes contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.12
 *
 * Prova, contra a base real (`track`): criar cliente (com deduplicação por email),
 * pesquisar/paginar, ligar um pedido via `client_ref_id` e ver o histórico +
 * agregados no detalhe, atualizar, desativar e o resumo (stats). Dados via factories.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona clients + client_ref_id)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { ClientFactory } from '../harness/factories/client.factory';
import { OrderFactory }  from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/clients.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMAIL = 'cliente-itest@exemplo.mz';
const O1 = 'order-itest-cli-0001';
const O2 = 'order-itest-cli-0002';

async function cleanup() {
  for (const id of [O1, O2]) await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  await pool.query('DELETE FROM clients WHERE email = $1', [EMAIL]);
  await pool.query('DELETE FROM clients WHERE name LIKE $1', ['Cliente ITEST%']);
}

describe.skipIf(!disponivel)('api-gateway · clientes / remetentes · PostgreSQL', () => {
  let clientId;

  beforeAll(async () => { await cleanup(); });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should create a client and normalize the email', async () => {
    const dto = ClientFactory.build({ name: 'Cliente ITEST Um', email: EMAIL.toUpperCase() });
    const c = await svc.createClient(dto);
    clientId = c.id;
    expect(c.status).toBe('active');
    expect(c.email).toBe(EMAIL);         // normalizado para minúsculas
    expect(c.type).toBe('individual');
  });

  it('should reject a duplicate email', async () => {
    await expect(svc.createClient(ClientFactory.build({ name: 'Cliente ITEST Dup', email: EMAIL })))
      .rejects.toMatchObject({ name: 'DuplicateClientEmailError', statusCode: 409 });
  });

  it('should reject an invalid email', async () => {
    await expect(svc.createClient(ClientFactory.build({ name: 'Cliente ITEST Mau', email: 'sem-arroba' })))
      .rejects.toMatchObject({ name: 'ClientValidationError', statusCode: 400 });
  });

  it('should find the client via search', async () => {
    const { items, total } = await svc.listClients({ search: 'ITEST Um', page: 1, pageSize: 10 });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(items.some((c) => c.id === clientId)).toBe(true);
  });

  it('should link orders and surface the history with aggregates', async () => {
    const now = new Date().toISOString();
    const base1 = OrderFactory.build({ id: O1, tracking_code: 'TRK-ITESTCLI-0001', current_status: 'delivered' });
    const base2 = OrderFactory.build({ id: O2, tracking_code: 'TRK-ITESTCLI-0002', current_status: 'in_transit' });
    await repo.OrderRepository.create({ ...base1, client_ref_id: clientId, value: 5000, history: [{ status: 'delivered', description: 'seed', location: 'Maputo', timestamp: now }] });
    await repo.OrderRepository.create({ ...base2, client_ref_id: clientId, value: 3000, history: [] });

    const detail = await svc.getClient(clientId);
    expect(detail.orders.map((o) => o.id).sort()).toEqual([O1, O2].sort());
    expect(detail.order_metrics.total).toBe(2);
    expect(detail.order_metrics.delivered).toBe(1);
    expect(detail.order_metrics.total_value_cents).toBe(8000);
    expect(detail.order_count).toBe(2); // agregado do repositório
  });

  it('should update the client', async () => {
    const updated = await svc.updateClient(clientId, { phone: '+258849999999', type: 'business', tax_id: '400123456' });
    expect(updated.phone).toBe('+258849999999');
    expect(updated.type).toBe('business');
    expect(updated.tax_id).toBe('400123456');
  });

  it('should deactivate the client', async () => {
    const c = await svc.deactivateClient(clientId);
    expect(c.status).toBe('inactive');
    const activeOnly = await svc.listClients({ status: 'active', search: 'ITEST Um' });
    expect(activeOnly.items.some((x) => x.id === clientId)).toBe(false);
  });

  it('should report stats', async () => {
    const stats = await svc.getStats();
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.active).toBe('number');
    expect(typeof stats.business).toBe('number');
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });
});
