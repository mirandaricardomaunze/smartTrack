/**
 * @file saft.js
 * @description Exportação do ficheiro de auditoria fiscal (SAF-T, padrão OCDE).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Gera o XML que o contabilista ou o auditor recebe: cabeçalho da empresa,
 * tabela de clientes, tabela de taxas e os documentos de venda do período com
 * a respetiva assinatura. PURO — recebe os dados já lidos da base e devolve
 * uma string; não sabe o que é uma ligação a PostgreSQL.
 *
 * SOBRE O ESQUEMA: a estrutura segue o padrão SAF-T da OCDE (o mesmo tronco
 * usado em PT/AO). O esquema oficial de Moçambique deve ser confirmado junto da
 * AT antes de qualquer submissão — por isso o namespace e a versão são
 * configuráveis (`FISCAL_SAFT_NAMESPACE`, `FISCAL_SAFT_VERSION`) e o número de
 * certificado sai a `0` enquanto o software não estiver certificado.
 */
'use strict';

const { DocType, SOFTWARE, documentSign } = require('./fiscal');

const NAMESPACE = process.env.FISCAL_SAFT_NAMESPACE || 'urn:OECD:StandardAuditFile-Tax:MZ_1.0';
const VERSION = process.env.FISCAL_SAFT_VERSION || '1.0';

/** Escapa texto para XML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

/** Elemento simples; omitido quando o valor é vazio. */
function tag(name, value, indent = '') {
  if (value === undefined || value === null || value === '') return '';
  return `${indent}<${name}>${esc(value)}</${name}>\n`;
}

/** Centavos → decimal com 2 casas (o SAF-T usa unidades monetárias, não centavos). */
function amount(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/** Data ISO → AAAA-MM-DD. */
function date(iso) {
  return String(iso ?? '').slice(0, 10);
}

/** Data ISO → AAAA-MM-DDThh:mm:ss (sem milissegundos, como manda o padrão). */
function dateTime(iso) {
  return `${String(iso ?? '').slice(0, 19)}`;
}

/** 'A' = anulado, 'N' = normal — estado do documento no ficheiro. */
function documentStatus(invoice) {
  return invoice.status === 'void' ? 'A' : 'N';
}

/**
 * Monta o AuditFile do período.
 *
 * @param {object} input
 * @param {{name:string,tax_id:string,address?:string,city?:string,email?:string}} input.issuer
 * @param {{from:string,to:string}} input.period
 * @param {object[]} input.invoices Documentos com items[] e tax_summary[]
 * @param {object[]} [input.customers] Clientes referenciados
 * @param {string} [input.generatedAt]
 * @returns {string} XML
 */
function buildSaftXml(input) {
  const { issuer, period, invoices = [], customers = [] } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const fiscalYear = date(period.from).slice(0, 4);

  // ── Header ────────────────────────────────────────────────────────────────
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<AuditFile xmlns="${esc(NAMESPACE)}">\n`;
  xml += '  <Header>\n';
  xml += tag('AuditFileVersion', VERSION, '    ');
  xml += tag('CompanyID', issuer.tax_id, '    ');
  xml += tag('TaxRegistrationNumber', issuer.tax_id, '    ');
  xml += tag('TaxAccountingBasis', 'F', '    ');
  xml += tag('CompanyName', issuer.name, '    ');
  xml += '    <CompanyAddress>\n';
  xml += tag('AddressDetail', issuer.address, '      ');
  xml += tag('City', issuer.city || 'Maputo', '      ');
  xml += tag('Country', 'MZ', '      ');
  xml += '    </CompanyAddress>\n';
  xml += tag('FiscalYear', fiscalYear, '    ');
  xml += tag('StartDate', date(period.from), '    ');
  xml += tag('EndDate', date(period.to), '    ');
  xml += tag('CurrencyCode', 'MZN', '    ');
  xml += tag('DateCreated', date(generatedAt), '    ');
  xml += tag('TaxEntity', 'Global', '    ');
  xml += tag('ProductCompanyTaxID', issuer.tax_id, '    ');
  xml += tag('SoftwareCertificateNumber', SOFTWARE.certificate, '    ');
  xml += tag('ProductID', `${SOFTWARE.name}/${SOFTWARE.name}`, '    ');
  xml += tag('ProductVersion', SOFTWARE.version, '    ');
  xml += tag('Telephone', issuer.email, '    ');
  xml += '  </Header>\n';

  // ── MasterFiles ───────────────────────────────────────────────────────────
  xml += '  <MasterFiles>\n';
  for (const c of customers) {
    xml += '    <Customer>\n';
    xml += tag('CustomerID', c.id, '      ');
    xml += tag('AccountID', 'Desconhecido', '      ');
    xml += tag('CustomerTaxID', c.tax_id || '999999999', '      ');
    xml += tag('CompanyName', c.name, '      ');
    xml += '      <BillingAddress>\n';
    xml += tag('AddressDetail', c.address || 'Desconhecido', '        ');
    xml += tag('City', c.city || 'Desconhecido', '        ');
    xml += tag('Country', 'MZ', '        ');
    xml += '      </BillingAddress>\n';
    xml += tag('SelfBillingIndicator', '0', '      ');
    xml += '    </Customer>\n';
  }

  // Tabela de taxas efetivamente usadas no período.
  const rates = new Map();
  for (const inv of invoices) {
    for (const line of inv.tax_summary ?? []) {
      const key = `${line.rate_pct}:${line.exemption_code ?? ''}`;
      if (!rates.has(key)) rates.set(key, line);
    }
  }
  for (const line of rates.values()) {
    xml += '    <TaxTableEntry>\n';
    xml += tag('TaxType', 'IVA', '      ');
    xml += tag('TaxCountryRegion', 'MZ', '      ');
    xml += tag('TaxCode', line.rate_pct === 0 ? 'ISE' : 'NOR', '      ');
    xml += tag('Description', line.rate_pct === 0 ? (line.exemption_reason || 'Isento') : `IVA ${line.rate_pct}%`, '      ');
    xml += tag('TaxPercentage', Number(line.rate_pct).toFixed(2), '      ');
    xml += '    </TaxTableEntry>\n';
  }
  xml += '  </MasterFiles>\n';

  // ── SourceDocuments ───────────────────────────────────────────────────────
  const valid = invoices.filter((i) => i.status !== 'void');
  const totalCredit = valid
    .filter((i) => documentSign(i.doc_type) > 0)
    .reduce((s, i) => s + i.subtotal_cents, 0);
  const totalDebit = valid
    .filter((i) => documentSign(i.doc_type) < 0)
    .reduce((s, i) => s + i.subtotal_cents, 0);

  xml += '  <SourceDocuments>\n    <SalesInvoices>\n';
  xml += tag('NumberOfEntries', invoices.length, '      ');
  xml += tag('TotalDebit', amount(totalDebit), '      ');
  xml += tag('TotalCredit', amount(totalCredit), '      ');

  for (const inv of invoices) {
    xml += '      <Invoice>\n';
    xml += tag('InvoiceNo', inv.number, '        ');
    xml += '        <DocumentStatus>\n';
    xml += tag('InvoiceStatus', documentStatus(inv), '          ');
    xml += tag('InvoiceStatusDate', dateTime(inv.voided_at ?? inv.signed_at ?? inv.issued_at), '          ');
    xml += tag('Reason', inv.void_reason, '          ');
    xml += tag('SourceID', inv.issued_by || 'sistema', '          ');
    xml += tag('SourceBilling', 'P', '          ');
    xml += '        </DocumentStatus>\n';
    xml += tag('Hash', inv.hash, '        ');
    xml += tag('HashControl', inv.hash_control, '        ');
    xml += tag('Period', date(inv.issued_at).slice(5, 7), '        ');
    xml += tag('InvoiceDate', date(inv.issued_at), '        ');
    xml += tag('InvoiceType', inv.doc_type ?? DocType.FT, '        ');
    xml += '        <SpecialRegimes>\n';
    xml += tag('SelfBillingIndicator', '0', '          ');
    xml += tag('CashVATSchemeIndicator', '0', '          ');
    xml += tag('ThirdPartiesBillingIndicator', '0', '          ');
    xml += '        </SpecialRegimes>\n';
    xml += tag('SourceID', inv.issued_by || 'sistema', '        ');
    xml += tag('SystemEntryDate', dateTime(inv.signed_at ?? inv.created_at ?? inv.issued_at), '        ');
    xml += tag('CustomerID', inv.client_ref_id || 'consumidor-final', '        ');

    let lineNo = 1;
    for (const item of inv.items ?? []) {
      const rate = Number(item.tax_rate_pct ?? 0);
      xml += '        <Line>\n';
      xml += tag('LineNumber', lineNo++, '          ');
      xml += tag('Quantity', Number(item.quantity ?? 1).toFixed(2), '          ');
      xml += tag('UnitOfMeasure', 'UN', '          ');
      xml += tag('UnitPrice', amount(item.unit_cents), '          ');
      xml += tag('TaxPointDate', date(inv.issued_at), '          ');
      xml += tag('Description', item.description, '          ');
      // Crédito = venda; débito = retificação a menos (nota de crédito).
      xml += tag(documentSign(inv.doc_type) < 0 ? 'DebitAmount' : 'CreditAmount', amount(item.total_cents), '          ');
      xml += '          <Tax>\n';
      xml += tag('TaxType', 'IVA', '            ');
      xml += tag('TaxCountryRegion', 'MZ', '            ');
      xml += tag('TaxCode', rate === 0 ? 'ISE' : 'NOR', '            ');
      xml += tag('TaxPercentage', rate.toFixed(2), '            ');
      xml += '          </Tax>\n';
      if (rate === 0) xml += tag('TaxExemptionReason', item.exemption_reason, '          ');
      if (inv.related_number) xml += tag('References', inv.related_number, '          ');
      xml += '        </Line>\n';
    }

    xml += '        <DocumentTotals>\n';
    xml += tag('TaxPayable', amount(inv.tax_cents), '          ');
    xml += tag('NetTotal', amount(inv.subtotal_cents), '          ');
    xml += tag('GrossTotal', amount(inv.total_cents), '          ');
    xml += '        </DocumentTotals>\n';
    xml += '      </Invoice>\n';
  }

  xml += '    </SalesInvoices>\n  </SourceDocuments>\n</AuditFile>\n';
  return xml;
}

module.exports = { buildSaftXml, NAMESPACE, VERSION };
