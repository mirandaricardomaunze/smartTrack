/**
 * @file inventory.pg.spec.js
 * @description Transferências entre filiais e contagens, contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.36
 *
 * O que aqui se prova não se prova sem base: que durante o percurso a encomenda
 * não conta na ocupação de nenhum dos dois armazéns; que o que não chega fica em
 * trânsito e sinalizado em vez de desaparecer; que o que chega sem estar no
 * manifesto é recebido na mesma; e que uma contagem compara com o que o sistema
 * dizia quando abriu, não com o que diz quando fecha.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const inventory  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/inventory.service`) : null;
const warehouses = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/warehouses.service`) : null;
const repos      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const pool       = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const ORIGEM  = 'warehouse-itest-inv-a';
const DESTINO = 'warehouse-itest-inv-b';
const CODIGOS = ['TRK920000001BR', 'TRK920000002BR', 'TRK920000003BR'];

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM warehouse_transfer_items WHERE tracking_code = ANY($1::text[])', [CODIGOS]);
  await pool.query('DELETE FROM warehouse_transfers WHERE origin_id = ANY($1::text[]) OR destination_id = ANY($1::text[])', [[ORIGEM, DESTINO]]);
  await pool.query('DELETE FROM warehouse_counts WHERE warehouse_id = ANY($1::text[])', [[ORIGEM, DESTINO]]);
  await pool.query('DELETE FROM warehouse_movements WHERE warehouse_id = ANY($1::text[])', [[ORIGEM, DESTINO]]);
  await pool.query('DELETE FROM orders WHERE tracking_code = ANY($1::text[])', [CODIGOS]);
  await pool.query('DELETE FROM warehouses WHERE id = ANY($1::text[])', [[ORIGEM, DESTINO]]);
}

/** Encomenda já pousada no armazém `wid`, pronta para transferir. */
async function semearNoArmazem(codigo, wid) {
  const base = OrderFactory.build({ tracking_code: codigo, current_status: 'at_warehouse' });
  const now = new Date().toISOString();
  return repos.OrderRepository.create({
    ...base,
    id: `order-itest-inv-${codigo.slice(-4)}`,
    warehouse_id: wid,
    value: 5000,
    history: [{ status: 'at_warehouse', description: 'seed', location: 'Armazém', timestamp: now }],
  });
}

describe.skipIf(!disponivel)('inventário e transferências · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    for (const [id, code, name] of [[ORIGEM, 'ITESTA', 'Filial A'], [DESTINO, 'ITESTB', 'Filial B']]) {
      await pool.query(
        `INSERT INTO warehouses (id, code, name, address, capacity, status, company_id)
         VALUES ($1,$2,$3,'{}'::jsonb,0,'active','company-default')`,
        [id, code, name],
      );
    }
  });

  beforeEach(async () => {
    if (!disponivel) return;
    await pool.query('DELETE FROM warehouse_transfer_items WHERE tracking_code = ANY($1::text[])', [CODIGOS]);
    await pool.query('DELETE FROM warehouse_transfers WHERE origin_id = ANY($1::text[])', [[ORIGEM, DESTINO]]);
    await pool.query('DELETE FROM warehouse_counts WHERE warehouse_id = ANY($1::text[])', [[ORIGEM, DESTINO]]);
    await pool.query('DELETE FROM orders WHERE tracking_code = ANY($1::text[])', [CODIGOS]);
    for (const codigo of CODIGOS) await semearNoArmazem(codigo, ORIGEM);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  // ── Abrir ──────────────────────────────────────────────────────────────────

  it('should refuse a transfer to the same warehouse', async () => {
    await expect(inventory.createTransfer({
      origin_id: ORIGEM, destination_id: ORIGEM, tracking_codes: [CODIGOS[0]],
    })).rejects.toThrow(/diferentes/i);
  });

  it('should refuse parcels that are not in the origin warehouse', async () => {
    // O operador procura por código e nada garante que o código que leu
    // pertence à unidade onde está. Move-se a encomenda semeada, em vez de
    // semear outra com o mesmo id.
    await pool.query('UPDATE orders SET warehouse_id = $1 WHERE tracking_code = $2', [DESTINO, CODIGOS[0]]);
    await expect(inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: [CODIGOS[0]],
    })).rejects.toThrow(/não estão no armazém de origem/i);
  });

  it('should refuse an empty manifest', async () => {
    await expect(inventory.createTransfer({ origin_id: ORIGEM, destination_id: DESTINO }))
      .rejects.toThrow(/pelo menos uma encomenda/i);
  });

  it('should open a transfer without moving anything yet', async () => {
    // Abrir é montar a lista, não despachar: a carga ainda está na origem.
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: CODIGOS,
    });

    expect(t.status).toBe('draft');
    expect(t.items).toHaveLength(3);
    expect(t.code).toMatch(/^TR\d{4}\//);

    const origem = await warehouses.getWarehouse(ORIGEM);
    expect(origem.occupancy).toBe(3);
  });

  // ── Despachar ──────────────────────────────────────────────────────────────

  it('should leave the parcels in no warehouse while they travel', async () => {
    // É este o buraco que a transferência veio tapar: entre sair e chegar, a
    // encomenda tem de estar em trânsito e fora da ocupação dos dois lados.
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: CODIGOS,
    });
    await inventory.dispatchTransfer(t.id);

    const { rows } = await pool.query(
      'SELECT current_status, warehouse_id FROM orders WHERE tracking_code = ANY($1::text[])',
      [CODIGOS],
    );
    expect(rows.every((r) => r.current_status === 'in_transit')).toBe(true);
    expect(rows.every((r) => r.warehouse_id === null)).toBe(true);

    expect((await warehouses.getWarehouse(ORIGEM)).occupancy).toBe(0);
    expect((await warehouses.getWarehouse(DESTINO)).occupancy).toBe(0);
  });

  it('should refuse to dispatch twice', async () => {
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: [CODIGOS[0]],
    });
    await inventory.dispatchTransfer(t.id);

    await expect(inventory.dispatchTransfer(t.id)).rejects.toThrow(/in_transit/);
  });

  // ── Receber e conferir ─────────────────────────────────────────────────────

  it('should receive everything when the manifest matches', async () => {
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: CODIGOS,
    });
    await inventory.dispatchTransfer(t.id);

    const { transfer, reconciliation } = await inventory.receiveTransfer(t.id, { scanned_codes: CODIGOS });

    expect(reconciliation.ok).toBe(true);
    expect(transfer.status).toBe('received');
    expect((await warehouses.getWarehouse(DESTINO)).occupancy).toBe(3);
  });

  it('should leave a parcel that did not arrive in transit, flagged as missing', async () => {
    // Não se inventa uma localização para uma encomenda perdida. Fica visível
    // como em falta até aparecer — é para isto que o manifesto serve.
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: CODIGOS,
    });
    await inventory.dispatchTransfer(t.id);

    const chegaram = [CODIGOS[0], CODIGOS[2]];
    const { transfer, reconciliation } = await inventory.receiveTransfer(t.id, { scanned_codes: chegaram });

    expect(reconciliation.missing).toEqual([CODIGOS[1]]);
    expect(transfer.items.find((i) => i.tracking_code === CODIGOS[1]).status).toBe('missing');

    const { rows } = await pool.query(
      'SELECT current_status, warehouse_id FROM orders WHERE tracking_code = $1',
      [CODIGOS[1]],
    );
    expect(rows[0].current_status).toBe('in_transit');
    expect(rows[0].warehouse_id).toBeNull();

    // E as que chegaram entraram na mesma — uma em falta não trava as outras.
    expect((await warehouses.getWarehouse(DESTINO)).occupancy).toBe(2);
  });

  it('should receive a parcel that arrived without being on the manifest', async () => {
    // A encomenda está ali. Recusá-la deixava-a em limbo.
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: [CODIGOS[0], CODIGOS[1]],
    });
    await inventory.dispatchTransfer(t.id);
    // A terceira viaja sem ir no manifesto: sai à mão e aparece na conferência.
    await require(`${ROOT}/backend/api-gateway/src/application/orders.service`)
      .leaveWarehouseForTransfer((await repos.OrderRepository.findByCode(CODIGOS[2])).id, {});

    const { transfer, reconciliation } = await inventory.receiveTransfer(t.id, { scanned_codes: CODIGOS });

    expect(reconciliation.unexpected).toEqual([CODIGOS[2]]);
    expect(transfer.items.find((i) => i.tracking_code === CODIGOS[2]).status).toBe('unexpected');
    expect((await warehouses.getWarehouse(DESTINO)).occupancy).toBe(3);
  });

  it('should refuse to receive a transfer that never left', async () => {
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: [CODIGOS[0]],
    });
    await expect(inventory.receiveTransfer(t.id, { scanned_codes: [CODIGOS[0]] }))
      .rejects.toThrow(/draft/);
  });

  // ── Inventário e contagem ──────────────────────────────────────────────────

  it('should report what is in the warehouse, with age', async () => {
    const inv = await inventory.getInventory(ORIGEM);

    expect(inv.warehouse.code).toBe('ITESTA');
    expect(inv.items).toHaveLength(3);
    expect(inv.buckets.fresh).toBe(3);
  });

  it('should freeze what the system said when the count opened', async () => {
    // Comparar no fim com o estado ATUAL acusaria como divergência tudo o que
    // entrou e saiu legitimamente durante a contagem.
    const contagem = await inventory.openCount(ORIGEM);
    expect(contagem.expected).toHaveLength(3);

    // Durante a contagem, uma encomenda sai legitimamente noutra transferência.
    const t = await inventory.createTransfer({
      origin_id: ORIGEM, destination_id: DESTINO, tracking_codes: [CODIGOS[2]],
    });
    await inventory.dispatchTransfer(t.id);

    const recarregada = await require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`)
      .CountRepository.findById(contagem.id);
    expect(recarregada.expected).toHaveLength(3);
  });

  it('should refuse a second open count on the same warehouse', async () => {
    // Duas contagens abertas dariam dois relatórios contraditórios sobre o
    // mesmo instante.
    await inventory.openCount(ORIGEM);
    await expect(inventory.openCount(ORIGEM)).rejects.toThrow(/já existe uma contagem aberta/i);
  });

  it('should accumulate scans across passes and report the discrepancies', async () => {
    const contagem = await inventory.openCount(ORIGEM);

    // A contagem faz-se em várias passagens, como o leitor de mão funciona.
    await inventory.addCountScans(contagem.id, { codes: [CODIGOS[0]] });
    await inventory.addCountScans(contagem.id, { codes: [CODIGOS[1], 'TRK999999999BR'] });

    const fechada = await inventory.closeCount(contagem.id, { notes: 'contagem mensal' });

    expect(fechada.status).toBe('closed');
    expect(fechada.result.missing).toEqual([CODIGOS[2]]);
    expect(fechada.result.unexpected).toEqual(['TRK999999999BR']);
    expect(fechada.result.ok).toBe(false);
  });

  it('should not move anything by itself when closing a count', async () => {
    // Uma contagem diz o que está diferente. Mover registos com base numa
    // leitura apagaria a prova do problema — a decisão é do responsável.
    const contagem = await inventory.openCount(ORIGEM);
    await inventory.addCountScans(contagem.id, { codes: [CODIGOS[0]] });
    await inventory.closeCount(contagem.id);

    expect((await warehouses.getWarehouse(ORIGEM)).occupancy).toBe(3);
  });
});
