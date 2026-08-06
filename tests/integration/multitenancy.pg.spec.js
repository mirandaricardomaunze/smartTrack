/**
 * @file multitenancy.pg.spec.js
 * @description Testes de integração do isolamento multiempresa contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4
 *
 * Prova, contra a base real (`track`), que os dados de uma empresa NÃO são visíveis
 * a outra: pedidos e clientes criados no contexto da empresa A não aparecem em
 * `findAll`/`list` no contexto da empresa B, nem podem ser lidos por id; o rastreio
 * público por código continua GLOBAL; e o auto-registo cria empresa + admin com a
 * empresa no token. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate` (provisiona companies + company_id)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory }   from '../harness/factories/company.factory';
import { OrderFactory }     from '../harness/factories/order.factory';
import { ClientFactory }    from '../harness/factories/client.factory';
import { WarehouseFactory } from '../harness/factories/warehouse.factory';
import { PricingZoneFactory } from '../harness/factories/pricing.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const repos = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const companiesSvc = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/companies.service`) : null;
const invoicesSvc = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const supportSvc = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/support.service`) : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const A = 'company-itest-A';
const B = 'company-itest-B';
const OA = 'order-itest-mt-A1';
const OB = 'order-itest-mt-B1';
const withCo = (cid, fn) => tenant.runWithCompany(cid, fn);

async function cleanup() {
  await pool.query('DELETE FROM invoices WHERE company_id = ANY($1::text[])', [[A, B]]);
  await pool.query('DELETE FROM invoice_counters WHERE company_id = ANY($1::text[])', [[A, B]]);
  // A numeração passou a viver em `document_series` (spec § 3.16): sem esta
  // limpeza a sequência de cada empresa continuava a subir entre execuções.
  await pool.query('DELETE FROM document_series WHERE company_id = ANY($1::text[])', [[A, B]]);
  await pool.query('DELETE FROM support_threads WHERE company_id = ANY($1::text[])', [[A, B]]);
  await pool.query('DELETE FROM pricing_zones WHERE company_id = ANY($1::text[])', [[A, B]]);
  await pool.query('DELETE FROM warehouses WHERE company_id = ANY($1::text[])', [[A, B]]);
  for (const id of [OA, OB]) await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  await pool.query('DELETE FROM clients WHERE company_id = ANY($1::text[])', [[A, B]]);
  await pool.query('DELETE FROM users WHERE company_id = ANY($1::text[])', [[A, B]]);
  await pool.query("DELETE FROM users WHERE email = 'dona@empresa-nova.mz'");
  await pool.query('DELETE FROM companies WHERE id = ANY($1::text[])', [[A, B]]);
  await pool.query("DELETE FROM companies WHERE slug LIKE 'transportadora-nova%'");
}

async function seedOrder(cid, id, code) {
  await withCo(cid, () => repos.OrderRepository.create({
    ...OrderFactory.build({ id, tracking_code: code, current_status: 'in_transit' }),
    value: 1000,
    history: [{ status: 'in_transit', description: 'seed', location: 'Maputo', timestamp: new Date().toISOString() }],
  }));
}

describe.skipIf(!disponivel)('api-gateway · isolamento multiempresa · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await repos.CompanyRepository.create(CompanyFactory.build({ id: A, name: 'Empresa A', slug: 'empresa-itest-a' }));
    await repos.CompanyRepository.create(CompanyFactory.build({ id: B, name: 'Empresa B', slug: 'empresa-itest-b' }));
    await seedOrder(A, OA, 'TRK-ITESTMT-A001');
    await seedOrder(B, OB, 'TRK-ITESTMT-B001');
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should write orders tagged with the context company', async () => {
    const oa = await pool.query('SELECT company_id FROM orders WHERE id = $1', [OA]);
    const ob = await pool.query('SELECT company_id FROM orders WHERE id = $1', [OB]);
    expect(oa.rows[0].company_id).toBe(A);
    expect(ob.rows[0].company_id).toBe(B);
  });

  it('should only list a company\'s own orders in findAll', async () => {
    const idsA = (await withCo(A, () => repos.OrderRepository.findAll())).map((o) => o.id);
    const idsB = (await withCo(B, () => repos.OrderRepository.findAll())).map((o) => o.id);
    expect(idsA).toContain(OA);
    expect(idsA).not.toContain(OB);
    expect(idsB).toContain(OB);
    expect(idsB).not.toContain(OA);
  });

  it('should not read another company\'s order by id', async () => {
    expect(await withCo(A, () => repos.OrderRepository.findById(OA))).toBeDefined();
    expect(await withCo(B, () => repos.OrderRepository.findById(OA))).toBeUndefined();
  });

  it('should keep public tracking-by-code GLOBAL (no company filter)', async () => {
    // Sem contexto de empresa (rota pública) o código resolve na mesma.
    const found = await repos.OrderRepository.findByCode('TRK-ITESTMT-A001');
    expect(found?.id).toBe(OA);
  });

  it('should isolate clients between companies', async () => {
    const ca = await withCo(A, () => companiesClientCreate('Cliente A'));
    const cb = await withCo(B, () => companiesClientCreate('Cliente B'));

    const listA = await withCo(A, () => repos.ClientRepository.list({}));
    const listB = await withCo(B, () => repos.ClientRepository.list({}));
    expect(listA.items.map((c) => c.id)).toContain(ca.id);
    expect(listA.items.map((c) => c.id)).not.toContain(cb.id);
    expect(listB.items.map((c) => c.id)).toContain(cb.id);

    // Não lê o cliente da outra empresa por id.
    expect(await withCo(B, () => repos.ClientRepository.findById(ca.id))).toBeUndefined();
  });

  it('should isolate warehouses and pricing zones between companies', async () => {
    const wa = await withCo(A, () => repos.WarehouseRepository.create(WarehouseFactory.build({ id: 'wh-mt-a', code: 'MT-A' })));
    const wb = await withCo(B, () => repos.WarehouseRepository.create(WarehouseFactory.build({ id: 'wh-mt-b', code: 'MT-B' })));
    const whA = (await withCo(A, () => repos.WarehouseRepository.findAll())).map((w) => w.id);
    expect(whA).toContain(wa.id);
    expect(whA).not.toContain(wb.id);

    // O mesmo código de zona pode coexistir em empresas diferentes (unicidade por empresa).
    await withCo(A, () => repos.PricingRepository.createZone({ ...PricingZoneFactory.build({ code: 'ZONA', name: 'Zona A' }), id: 'zone-mt-a' }));
    await withCo(B, () => repos.PricingRepository.createZone({ ...PricingZoneFactory.build({ code: 'ZONA', name: 'Zona B' }), id: 'zone-mt-b' }));
    const zonesA = await withCo(A, () => repos.PricingRepository.listZones({}));
    expect(zonesA.map((z) => z.name)).toContain('Zona A');
    expect(zonesA.map((z) => z.name)).not.toContain('Zona B');
  });

  it('should number invoices independently per company (FT.../0001 each)', async () => {
    const invA = await withCo(A, () => invoicesSvc.createInvoiceForOrder(OA));
    const invB = await withCo(B, () => invoicesSvc.createInvoiceForOrder(OB));
    expect(invA.number).toMatch(/\/0001$/);
    expect(invB.number).toMatch(/\/0001$/);

    const listA = await withCo(A, () => invoicesSvc.listInvoices({}));
    expect(listA.items.map((i) => i.id)).toContain(invA.id);
    expect(listA.items.map((i) => i.id)).not.toContain(invB.id);
  });

  it('should attribute a client-opened support thread to the order\'s company', async () => {
    // Cliente é público (sem contexto de empresa): a conversa herda a empresa do pedido.
    const { thread } = await supportSvc.openThread({
      client_name: 'Cliente MT', message: 'Olá', tracking_code: 'TRK-ITESTMT-A001',
    });
    const queueA = await withCo(A, () => supportSvc.listThreads({}));
    const queueB = await withCo(B, () => supportSvc.listThreads({}));
    expect(queueA.map((t) => t.id)).toContain(thread.id);
    expect(queueB.map((t) => t.id)).not.toContain(thread.id);
  });

  it('should register a company + first admin with the company in the token', async () => {
    const res = await companiesSvc.registerCompany({
      company_name: 'Transportadora Nova',
      admin_name: 'Dona Nova',
      admin_email: 'dona@empresa-nova.mz',
      password: 'segredo123',
    });
    expect(res.company.id).toMatch(/^company-/);
    expect(res.company.status).toBe('active');
    expect(res.user.company_id).toBe(res.company.id);
    expect(typeof res.token).toBe('string');
    // limpeza específica desta empresa
    await pool.query('DELETE FROM users WHERE company_id = $1', [res.company.id]);
    await pool.query('DELETE FROM companies WHERE id = $1', [res.company.id]);
  });
});

/** Helper: cria um cliente (a empresa vem do contexto ativo). */
function companiesClientCreate(name) {
  return repos.ClientRepository.create({
    ...ClientFactory.build({ name }),
    id: `client-itest-mt-${Math.random().toString(36).slice(2, 8)}`,
    address: undefined,
  });
}
