/**
 * @file support.pg.spec.js
 * @description Testes de integração do chat de suporte contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.9
 *
 * Prova, contra a base real (`track`): abrir uma conversa cria a thread + 1ª
 * mensagem e devolve um token; o token errado é recusado (401); o agente vê a
 * conversa na fila e responde (a thread sobe e passa a ter agente atribuído); o
 * cliente vê a resposta e, ao responder a uma conversa resolvida, reabre-a; o
 * contexto do pedido é resolvido pelo código de rastreio. Dados via factories.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona support_*)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { SupportThreadFactory } from '../harness/factories/support.factory';
import { OrderFactory }         from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/support.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const ORDER_ID = 'order-itest-sup-0001';
const TRACK    = 'TRK-ITESTSUP-0001';
const AGENT    = { sub: 'agent-itest-0001', email: 'suporte@smarttrack.co.mz', role: 'SUPPORT' };

async function cleanupThreadsFor(email) {
  // support_messages cai em cascata ao apagar a thread.
  await pool.query('DELETE FROM support_threads WHERE client_email = $1', [email]);
}

async function cleanup() {
  await cleanupThreadsFor('cliente-sup@exemplo.mz');
  await pool.query('DELETE FROM orders WHERE id = $1', [ORDER_ID]);
}

describe.skipIf(!disponivel)('api-gateway · chat de suporte · PostgreSQL', () => {
  let threadId;
  let token;

  beforeAll(async () => {
    await cleanup();
    const base = OrderFactory.build({ id: ORDER_ID, tracking_code: TRACK, current_status: 'in_transit' });
    await repo.OrderRepository.create({
      ...base, value: 1500,
      history: [{ status: 'in_transit', description: 'seed', location: 'Em trânsito', timestamp: new Date().toISOString() }],
    });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should open a thread, store the first message and resolve the order context', async () => {
    const dto = SupportThreadFactory.buildWithTracking(TRACK, { client_email: 'cliente-sup@exemplo.mz' });
    const { thread, access_token } = await svc.openThread(dto);
    threadId = thread.id;
    token = access_token;

    expect(typeof access_token).toBe('string');
    expect(access_token.length).toBeGreaterThan(20);
    expect(thread.status).toBe('open');
    expect(thread.order_id).toBe(ORDER_ID);      // contexto resolvido pelo código
    expect(thread.tracking_code).toBe(TRACK);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].sender).toBe('client');
    // O token nunca deve ser exposto no objeto da conversa.
    expect(thread).not.toHaveProperty('client_token_hash');
  });

  it('should let the client read the thread with a valid token', async () => {
    const view = await svc.getClientThread(threadId, token);
    expect(view.id).toBe(threadId);
    expect(view.messages).toHaveLength(1);
  });

  it('should reject reading with a wrong token', async () => {
    await expect(svc.getClientThread(threadId, 'token-errado'))
      .rejects.toMatchObject({ name: 'SupportAccessDeniedError', statusCode: 401 });
  });

  it('should surface the thread in the agent queue with order context', async () => {
    const list = await svc.listThreads({ status: 'open' });
    expect(list.some((t) => t.id === threadId)).toBe(true);

    const detail = await svc.getThread(threadId);
    expect(detail.order?.id).toBe(ORDER_ID);
    expect(detail.message_count).toBe(1);
  });

  it('should let the agent reply, bumping the thread and self-assigning', async () => {
    const detail = await svc.postAgentMessage(threadId, AGENT, { body: 'Olá! A sua encomenda está em trânsito.' });
    expect(detail.assigned_agent_id).toBe(AGENT.sub);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1].sender).toBe('agent');
    expect(detail.messages[1].sender_name).toBe('Suporte'); // nome do agente não é exposto
  });

  it('should let the client see the agent reply', async () => {
    const view = await svc.getClientThread(threadId, token);
    expect(view.messages).toHaveLength(2);
    expect(view.messages.map((m) => m.sender)).toEqual(['client', 'agent']);
  });

  it('should resolve the thread and reopen it when the client replies again', async () => {
    const resolved = await svc.updateThread(threadId, { status: 'resolved' });
    expect(resolved.status).toBe('resolved');

    const reopened = await svc.postClientMessage(threadId, token, { body: 'Obrigado, mas tenho outra dúvida.' });
    expect(reopened.status).toBe('open');
    expect(reopened.messages).toHaveLength(3);
  });

  it('should reject an empty client message', async () => {
    await expect(svc.postClientMessage(threadId, token, { body: '   ' }))
      .rejects.toMatchObject({ name: 'SupportValidationError', statusCode: 400 });
  });

  it('should report stats reflecting the open thread', async () => {
    const stats = await svc.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.open).toBeGreaterThanOrEqual(1);
    expect(typeof stats.resolved).toBe('number');
  });
});
