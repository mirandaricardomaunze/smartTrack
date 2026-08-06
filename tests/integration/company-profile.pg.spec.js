/**
 * @file company-profile.pg.spec.js
 * @description Testes de integração do perfil/marca da empresa contra PostgreSQL.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * Prova, contra a base real (`track`): o perfil nasce com o nome da empresa; a
 * atualização parcial não apaga o que não foi enviado (nomeadamente o logótipo);
 * o NUIT, a cor e o logótipo são validados antes de irem parar a um documento; o
 * **emissor das faturas passa a ser a empresa** e fica congelado no documento; e
 * cada empresa vê apenas o seu perfil. Dados via factories do harness.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/api-gateway && npm run migrate`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { CompanyFactory } from '../harness/factories/company.factory';
import { CompanyProfileFactory, TINY_LOGO_DATA_URL } from '../harness/factories/company-profile.factory';
import { FiscalDocumentFactory } from '../harness/factories/fiscal.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const companies = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/companies.service`) : null;
const invoices  = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/invoices.service`) : null;
const repo      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`) : null;
const tenant    = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool      = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const COMPANY_A = 'company-itest-brand-a';
const COMPANY_B = 'company-itest-brand-b';

function asCompany(companyId, fn) {
  return tenant.runWithCompany(companyId, fn);
}

async function cleanup() {
  const ids = [COMPANY_A, COMPANY_B];
  await pool.query('DELETE FROM invoices WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM document_series WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM company_profiles WHERE company_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
}

describe.skipIf(!disponivel)('api-gateway · perfil da empresa · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_A, name: 'Transportes Marca A', slug: COMPANY_A }));
    await repo.CompanyRepository.create(CompanyFactory.build({ id: COMPANY_B, name: 'Transportes Marca B', slug: COMPANY_B }));
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should create a minimal profile from the company name', async () => {
    const profile = await companies.getProfile(COMPANY_A);
    expect(profile).toMatchObject({ company_id: COMPANY_A, legal_name: 'Transportes Marca A', country: 'Moçambique' });
    expect(profile.brand_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('should store the full identity and brand', async () => {
    const dto = CompanyProfileFactory.build({ legal_name: 'Transportes Marca A, Lda.' });
    const saved = await companies.updateProfile(COMPANY_A, dto);

    expect(saved).toMatchObject({
      legal_name: 'Transportes Marca A, Lda.',
      tax_id: dto.tax_id,
      city: dto.city,
      brand_color: dto.brand_color,
    });
    expect(saved.logo).toBe(TINY_LOGO_DATA_URL);
  });

  it('should not wipe the logo on a partial update', async () => {
    const saved = await companies.updateProfile(COMPANY_A, { phone: '+258 84 000 0000' });

    expect(saved.phone).toBe('+258 84 000 0000');
    expect(saved.logo).toBe(TINY_LOGO_DATA_URL);        // preservado
    expect(saved.legal_name).toBe('Transportes Marca A, Lda.');
  });

  it('should clear the logo only when explicitly emptied', async () => {
    const cleared = await companies.updateProfile(COMPANY_A, { logo: '' });
    expect(cleared.logo).toBeUndefined();

    await companies.updateProfile(COMPANY_A, { logo: TINY_LOGO_DATA_URL }); // repõe
  });

  it('should normalise a NUIT written with separators', async () => {
    const saved = await companies.updateProfile(COMPANY_A, { tax_id: '400 123 456' });
    expect(saved.tax_id).toBe('400123456');
  });

  it.each([
    ['NUIT curto', { tax_id: '12345' }],
    ['cor inválida', { brand_color: 'azul' }],
    ['e-mail inválido', { email: 'nao-e-email' }],
    ['designação vazia', { legal_name: '   ' }],
    ['logótipo que não é imagem', { logo: 'data:text/html;base64,AAAA' }],
  ])('should reject %s', async (_label, patch) => {
    await expect(companies.updateProfile(COMPANY_A, patch))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('should reject a logo above the size ceiling', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(400_001)}`;
    await expect(companies.updateProfile(COMPANY_A, { logo: huge }))
      .rejects.toThrowError(/demasiado grande/i);
  });

  it('should issue invoices in the name of the company, not the platform', async () => {
    const invoice = await asCompany(COMPANY_A, () => invoices.issueDocument(FiscalDocumentFactory.build({ series: 'B' })));

    expect(invoice.issuer_name).toBe('Transportes Marca A, Lda.');
    expect(invoice.issuer_tax_id).toBe('400123456');
  });

  it('should freeze the issuer on the document even after the profile changes', async () => {
    const invoice = await asCompany(COMPANY_A, () => invoices.issueDocument(FiscalDocumentFactory.build({ series: 'B' })));
    await companies.updateProfile(COMPANY_A, { legal_name: 'Transportes Marca A — Nova Denominação' });

    const stored = await asCompany(COMPANY_A, () => invoices.getInvoice(invoice.id));
    // O documento guarda o emissor de quando foi assinado (§ 3.19, imutabilidade)…
    expect(stored.issuer_name).toBe('Transportes Marca A, Lda.');
    // …mas o cabeçalho corrente para novos documentos já é o novo.
    expect(stored.issuer.name).toBe('Transportes Marca A — Nova Denominação');
  });

  it('should carry the brand into the invoice header for the PDF', async () => {
    const invoice = await asCompany(COMPANY_A, () => invoices.issueDocument(FiscalDocumentFactory.build({ series: 'B' })));
    const detail = await asCompany(COMPANY_A, () => invoices.getInvoice(invoice.id));

    expect(detail.issuer.logo).toBe(TINY_LOGO_DATA_URL);
    expect(detail.issuer.brand_color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(detail.issuer.bank_details).toBeTruthy();
  });

  it('should fall back to the environment issuer without a company in context', async () => {
    const issuer = await invoices.resolveIssuer();
    expect(issuer.name).toBe(invoices.getIssuer().name);
  });

  it('should keep profiles isolated between companies', async () => {
    const profileB = await companies.getProfile(COMPANY_B);
    expect(profileB.legal_name).toBe('Transportes Marca B');
    expect(profileB.logo).toBeUndefined();

    const invoiceB = await asCompany(COMPANY_B, () => invoices.issueDocument(FiscalDocumentFactory.build({ series: 'B' })));
    expect(invoiceB.issuer_name).toBe('Transportes Marca B');
  });
});
