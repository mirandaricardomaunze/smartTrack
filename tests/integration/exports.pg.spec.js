/**
 * @file exports.pg.spec.js
 * @description Exportação em Excel contra a base real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * A montagem das folhas é pura e está coberta em exports.service.spec.ts. O que
 * só a base mostra é o percurso inteiro: consulta → folha → ZIP → ficheiro que
 * se abre. Um Excel corrompido falha com uma mensagem que não diz porquê, e
 * quem o recebeu por email não tem como diagnosticar — por isso o teste
 * descomprime o ficheiro e lê o valor lá dentro.
 *
 * Pré-requisitos: PostgreSQL a atender + `npm run migrate`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const zlib = require('node:zlib');
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const exports_ = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/exports.service`) : null;
const tenant   = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/tenant-context`) : null;
const pool     = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const EMPRESA = 'company-itest-xlsx';
const CLIENTE = 'client-itest-xlsx';

/** O `&` é o carácter que corromperia o XML se escapasse ao escritor. */
const NOME_CLIENTE = 'Silva & Filhos, Lda';

const naEmpresa = (fn) => tenant.runWithCompany(EMPRESA, fn);

/** Descomprime uma entrada do ZIP pelo nome, a partir do diretório central. */
function lerEntrada(buf, nomeProcurado) {
  const eocd = buf.length - 22;
  const entradas = buf.readUInt16LE(eocd + 10);
  let ponteiro = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entradas; i += 1) {
    const compSize = buf.readUInt32LE(ponteiro + 20);
    const nomeLen = buf.readUInt16LE(ponteiro + 28);
    const extraLen = buf.readUInt16LE(ponteiro + 30);
    const comentLen = buf.readUInt16LE(ponteiro + 32);
    const localOffset = buf.readUInt32LE(ponteiro + 42);
    const nome = buf.subarray(ponteiro + 46, ponteiro + 46 + nomeLen).toString('utf8');

    if (nome === nomeProcurado) {
      const inicio = localOffset + 30
        + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      return zlib.inflateRawSync(buf.subarray(inicio, inicio + compSize)).toString('utf8');
    }
    ponteiro += 46 + nomeLen + extraLen + comentLen;
  }
  return null;
}

async function limpar() {
  if (!disponivel) return;
  await pool.query('DELETE FROM invoices WHERE company_id = $1', [EMPRESA]);
  await pool.query('DELETE FROM companies WHERE id = $1', [EMPRESA]);
}

describe.skipIf(!disponivel)('exportação Excel · PostgreSQL', () => {
  beforeAll(async () => {
    await limpar();
    await pool.query(
      `INSERT INTO companies (id, name, slug, status) VALUES ($1,'Exportações ITEST',$1,'active')`,
      [EMPRESA],
    );
    await pool.query(`
      INSERT INTO invoices (id, number, doc_type, client_ref_id, client_name, items,
        subtotal_cents, tax_rate_pct, tax_cents, total_cents, status, due_date,
        issued_at, created_at, updated_at, company_id)
      VALUES ('inv-xlsx-1','FT2026/X1','FT',$1,$2,'[]'::jsonb,
        123456, 16, 0, 123456, 'issued', '2026-01-15', NOW(), NOW(), NOW(), $3)
    `, [CLIENTE, NOME_CLIENTE, EMPRESA]);
  });

  afterAll(async () => {
    if (!disponivel) return;
    await limpar();
    await pool.end();
  });

  it('should carry the real debt from the database into the sheet', async () => {
    const { filename, buffer } = await naEmpresa(() => exports_.exportReport('contas-a-receber'));
    const folha = lerEntrada(buffer, 'xl/worksheets/sheet1.xml');

    expect(filename).toMatch(/^contas-a-receber-\d{4}-\d{2}-\d{2}\.xlsx$/);
    // 123456 centavos chegam à folha como 1234.56 meticais, e como NÚMERO: é a
    // diferença que faz alguém pedir Excel em vez de CSV.
    expect(folha).toContain('<v>1234.56</v>');
  });

  it('should not corrupt the file over an ampersand in a client name', async () => {
    const { buffer } = await naEmpresa(() => exports_.exportReport('contas-a-receber'));
    const folha = lerEntrada(buffer, 'xl/worksheets/sheet1.xml');

    expect(folha).toContain('Silva &amp; Filhos, Lda');
    expect(folha).not.toContain('Silva & Filhos');
  });

  it('should build every report the router offers', async () => {
    // Cada um destes atravessa consultas diferentes; um que rebentasse só se
    // descobriria quando alguém carregasse no botão.
    for (const relatorio of ['rentabilidade', 'contas-a-receber', 'desempenho', 'ocorrencias']) {
      const { filename, buffer } = await naEmpresa(() => exports_.exportReport(relatorio));

      expect(filename.endsWith('.xlsx')).toBe(true);
      expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');   // assinatura ZIP
      expect(lerEntrada(buffer, 'xl/workbook.xml')).toContain('<sheet ');
    }
  });

  it('should produce a valid file for a company with no data at all', async () => {
    // Devolver erro obrigaria quem exporta a distinguir "correu mal" de "não há
    // nada" — e "nada a receber" é uma resposta legítima.
    const { buffer } = await tenant.runWithCompany('company-itest-xlsx-vazia',
      () => exports_.exportReport('contas-a-receber'));

    expect(lerEntrada(buffer, 'xl/worksheets/sheet1.xml')).toContain('Cliente');
  });

  it('should refuse a report it does not know', async () => {
    await expect(naEmpresa(() => exports_.exportReport('inventado')))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
