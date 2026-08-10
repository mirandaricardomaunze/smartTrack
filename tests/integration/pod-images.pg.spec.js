/**
 * @file pod-images.pg.spec.js
 * @description Testes de integração: as imagens do comprovativo fora da linha do pedido.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.28
 *
 * O que estes testes protegem, contra a base real (`track`):
 *   1. A listagem NUNCA devolve bytes de imagem — era isso que fazia um ecrã de
 *      25 pedidos arrastar centenas de MB.
 *   2. A prova continua lá: guardada em `order_pod_images`, legível pelo detalhe.
 *   3. Uma mudança de estado posterior não apaga a prova. Foi o risco introduzido
 *      ao separar as duas coisas, e é o que aqui se fecha.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate -- --reset-core`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';
import { PodFactory, PodImagesFactory, dataUrlOfSize } from '../harness/factories/pod.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`).OrderRepository : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const HEAVY = 'order-itest-podimg-0001'; // entrega com imagens pesadas
const LIGHT = 'order-itest-podimg-0002'; // entrega só com assinatura
const PLAIN = 'order-itest-podimg-0003'; // sem entrega — não deve ter imagens
const IDS = [HEAVY, LIGHT, PLAIN];

async function seedOrder(id, code, status) {
  const base = OrderFactory.build({ id, tracking_code: code, current_status: status });
  const now = new Date().toISOString();
  await repo.create({
    ...base,
    value:   1990,
    history: [{ status, description: 'seed', location: 'Maputo - MPM', timestamp: now }],
  });
}

async function cleanup() {
  for (const id of IDS) {
    await pool.query('DELETE FROM order_pod_images WHERE order_id = $1', [id]);
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  }
}

describe.skipIf(!disponivel)('api-gateway · imagens do POD fora do pedido · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await seedOrder(HEAVY, 'TRK-PODIMG-0001', 'out_for_delivery');
    await seedOrder(LIGHT, 'TRK-PODIMG-0002', 'out_for_delivery');
    await seedOrder(PLAIN, 'TRK-PODIMG-0003', 'created');

    const heavy = PodImagesFactory.buildHeavy(400_000);
    await svc.deliverOrder(HEAVY, {
      recipient_name: 'Recebedor Pesado',
      signature: heavy.signature,
      photo:     heavy.photo,
    });

    const pod = PodFactory.buildSignatureOnly({ recipient_name: 'Recebedor Leve' });
    await svc.deliverOrder(LIGHT, { recipient_name: pod.recipient_name, signature: pod.signature });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should keep the order row free of image bytes', async () => {
    const { rows } = await pool.query('SELECT pod FROM orders WHERE id = $1', [HEAVY]);
    const stored = rows[0].pod;

    expect(stored.signature).toBeUndefined();
    expect(stored.photo).toBeUndefined();
    expect(stored.has_signature).toBe(true);
    expect(stored.has_photo).toBe(true);
    // Metadados intactos — separar as imagens não é perder contexto.
    expect(stored.recipient_name).toBe('Recebedor Pesado');
    expect(JSON.stringify(stored).length).toBeLessThan(2_000);
  });

  it('should store the images in their own table, readable on demand', async () => {
    const images = await repo.findPodImages(HEAVY);
    expect(images.signature).toHaveLength(400_000);
    expect(images.photo).toHaveLength(400_000);
  });

  it('should never ship image bytes through the paginated list', async () => {
    const { items } = await repo.list({ limit: 200 });
    const payload = JSON.stringify(items);

    expect(items.length).toBeGreaterThan(0);
    expect(payload).not.toContain(dataUrlOfSize(1_000).slice(0, 200));
    for (const item of items) {
      expect(item.pod?.signature).toBeUndefined();
      expect(item.pod?.photo).toBeUndefined();
    }
  });

  it('should expose the images by order id, through the service', async () => {
    const images = await svc.getPodImages(LIGHT);
    expect(images.signature).toContain('data:image/png');
    expect(images.photo).toBeUndefined();
  });

  it('should expose the images by tracking code, for the public portal', async () => {
    const images = await svc.getPodImagesByCode('TRK-PODIMG-0002');
    expect(images.signature).toContain('data:image/png');
  });

  it('should return nothing for an order that was never delivered', async () => {
    expect(await svc.getPodImages(PLAIN)).toEqual({});
  });

  it('should refuse an unknown order instead of returning an empty proof', async () => {
    await expect(svc.getPodImages('order-que-nao-existe'))
      .rejects.toMatchObject({ name: 'OrderNotFoundError' });
  });

  it('should preserve the proof when the order is updated afterwards', async () => {
    // Este é o risco de separar as duas coisas: uma atualização de metadados que
    // chegue sem imagens não pode apagar o que já estava guardado.
    const order = await repo.findById(LIGHT);
    await repo.update({ ...order, updated_at: new Date().toISOString() });

    const images = await repo.findPodImages(LIGHT);
    expect(images.signature).toContain('data:image/png');

    const reloaded = await repo.findById(LIGHT);
    expect(reloaded.pod.has_signature).toBe(true);
  });
});
