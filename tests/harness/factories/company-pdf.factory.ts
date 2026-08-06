/**
 * @file company-pdf.factory.ts
 * @description Test factory dos documentos PDF timbrados (entrada de `composeCompanyPdf`).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * Complementa `company-profile.factory.ts`: essa fabrica o registo que vai para a
 * base (`company_profiles`), esta fabrica o **perfil já lido pelo frontend** e as
 * tabelas/totais que compõem um documento.
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * NOTA SOBRE O LOGÓTIPO: o perfil de omissão sai **sem logótipo** de propósito.
 * `loadImageAsJpeg` depende de `new Image()` + canvas, e em jsdom uma imagem nunca
 * dispara `load` nem `error` — um logótipo aqui deixaria o teste pendurado. A
 * conversão do logótipo é exercitada no browser, não em teste unitário.
 */

/** Espelha `CompanyProfile` de `frontend/admin-panel/src/services/api.ts`. */
export interface TestPdfProfile {
  company_id: string;
  legal_name: string;
  trade_name?: string;
  tax_id?: string;
  address?: string;
  city?: string;
  country: string;
  phone?: string;
  email?: string;
  website?: string;
  logo?: string;
  brand_color: string;
  bank_details?: string;
  footer_note?: string;
  created_at: string;
  updated_at: string;
}

export interface TestPdfColumn {
  header: string;
  width: number;
  align?: 'left' | 'center' | 'right';
}

export interface TestPdfTotal {
  label: string;
  value: string;
  strong?: boolean;
}

export interface TestPdfTable {
  title?: string;
  columns: TestPdfColumn[];
  rows: string[][];
  totals?: TestPdfTotal[];
  emptyLabel?: string;
}

export interface TestPdfInput {
  profile: TestPdfProfile | null;
  title: string;
  reference?: string;
  subtitle?: string;
  badge?: string;
  meta?: TestPdfTotal[];
  parties?: Array<{ title: string; lines: string[] }>;
  tables?: TestPdfTable[];
  notes?: string[];
  signatures?: string[];
  legalNote?: string;
  filename: string;
}

const FIXED_DATE = '2026-01-01T00:00:00.000Z';

export class CompanyPdfFactory {
  /** Perfil completo — exercita todo o cabeçalho e o rodapé legal. */
  static profile(overrides: Partial<TestPdfProfile> = {}): TestPdfProfile {
    return {
      company_id:   'company-test',
      legal_name:   'Transportes Teste, Lda.',
      trade_name:   'Teste Express',
      tax_id:       '400123456',
      address:      'Av. 25 de Setembro, 1234',
      city:         'Maputo',
      country:      'Moçambique',
      phone:        '+258 21 000 000',
      email:        'faturacao@teste.co.mz',
      brand_color:  '#1D4ED8',
      bank_details: 'BCI · Conta 1234567890',
      footer_note:  'Capital social 100.000,00 MZN',
      created_at:   FIXED_DATE,
      updated_at:   FIXED_DATE,
      ...overrides,
    };
  }

  /**
   * Perfil com cor de marca CLARA. Existe para provar que o texto por cima das
   * faixas da marca continua legível — uma empresa pode escolher amarelo.
   */
  static lightBrandProfile(overrides: Partial<TestPdfProfile> = {}): TestPdfProfile {
    return CompanyPdfFactory.profile({ brand_color: '#FDE047', ...overrides });
  }

  /**
   * Perfil com tudo longo — designação social, endereço e rodapé.
   * Existe para provar que o cabeçalho não invade a coluna do número do
   * documento e que nada sai fora das margens.
   */
  static verboseProfile(overrides: Partial<TestPdfProfile> = {}): TestPdfProfile {
    return CompanyPdfFactory.profile({
      legal_name: 'Sociedade de Transportes, Logística e Distribuição Internacional de Moçambique, Limitada',
      trade_name: 'Grupo Logístico Integrado de Moçambique e Sul de África',
      address: 'Avenida 25 de Setembro, n.º 1234, 7.º andar, Bairro Central, Distrito Municipal KaMpfumo',
      footer_note: 'Capital social 100.000,00 MZN · Matriculada na Conservatória do Registo das Entidades Legais de Maputo sob o n.º 100123456',
      ...overrides,
    });
  }

  /** Tabela mínima com total em destaque — o esqueleto de uma fatura. */
  static table(overrides: Partial<TestPdfTable> = {}): TestPdfTable {
    return {
      columns: [
        { header: 'Descrição', width: 4 },
        { header: 'Total', width: 2, align: 'right' },
      ],
      rows: [['Serviço de entrega', '1 160,00 MZN']],
      totals: [{ label: 'Total', value: '1 160,00 MZN', strong: true }],
      ...overrides,
    };
  }

  /** Tabela sem movimento — verifica o texto de vazio em vez de um bloco branco. */
  static emptyTable(overrides: Partial<TestPdfTable> = {}): TestPdfTable {
    return CompanyPdfFactory.table({
      rows: [],
      totals: undefined,
      emptyLabel: 'Sem movimento no período.',
      ...overrides,
    });
  }

  /** Tabela longa o suficiente para forçar quebras de página. */
  static longTable(rowCount = 90, overrides: Partial<TestPdfTable> = {}): TestPdfTable {
    return CompanyPdfFactory.table({
      rows: Array.from({ length: rowCount }, (_, index) => [
        `Serviço de entrega número ${index + 1}`,
        '1 160,00 MZN',
      ]),
      ...overrides,
    });
  }

  /** Documento genérico — base de todos os outros. */
  static input(overrides: Partial<TestPdfInput> = {}): TestPdfInput {
    return {
      profile: CompanyPdfFactory.profile(),
      title: 'Fatura',
      reference: 'FT A2026/0001',
      tables: [CompanyPdfFactory.table()],
      filename: 'documento-teste.pdf',
      ...overrides,
    };
  }

  /** Fatura completa: cliente, metadados, selo de estado e assinatura fiscal. */
  static invoice(overrides: Partial<TestPdfInput> = {}): TestPdfInput {
    return CompanyPdfFactory.input({
      title: 'Fatura',
      reference: 'FT A2026/0002',
      badge: 'PAGA',
      meta: [
        { label: 'Data de emissão', value: '02/08/2026' },
        { label: 'Vencimento', value: '02/09/2026', strong: true },
      ],
      parties: [{ title: 'Cliente', lines: ['Cliente Teste', 'NUIT: 400999888'] }],
      legalNote: 'Assinatura do documento: A1b2 — Processado por computador.',
      ...overrides,
    });
  }

  /** Relatório longo — o caso que atravessa páginas. */
  static report(rowCount = 90, overrides: Partial<TestPdfInput> = {}): TestPdfInput {
    return CompanyPdfFactory.input({
      title: 'Relatório',
      reference: 'REL 2026/08',
      subtitle: 'Período de 01/08/2026 a 31/08/2026',
      tables: [CompanyPdfFactory.longTable(rowCount)],
      ...overrides,
    });
  }

  /**
   * O caso que estica o desenho: nomes longos no emissor, no cliente e nas
   * linhas, duas partes lado a lado e várias páginas. É o que apanha
   * transbordos e textos escritos por cima de textos.
   */
  static stressInput(overrides: Partial<TestPdfInput> = {}): TestPdfInput {
    return CompanyPdfFactory.input({
      profile: CompanyPdfFactory.verboseProfile(),
      title: 'Nota de crédito',
      reference: 'NC A2026/0000123',
      badge: 'ANULADA',
      subtitle: 'Retifica a fatura FT A2026/0000097, emitida a 12 de julho de 2026, por devolução parcial',
      meta: [
        { label: 'Data de emissão', value: '05/08/2026' },
        { label: 'Documento retificado', value: 'FT A2026/0000097', strong: true },
        { label: 'Motivo', value: 'Devolução parcial da mercadoria' },
        { label: 'Vencimento', value: '04/09/2026' },
      ],
      parties: [
        {
          title: 'Emitente',
          lines: ['Sociedade de Transportes, Logística e Distribuição Internacional de Moçambique, Limitada', 'NUIT: 400123456'],
        },
        {
          title: 'Cliente',
          lines: ['Empreendimentos Comerciais e Industriais da Beira, Sociedade Unipessoal Limitada', 'NUIT: 400999888', 'Rua do Bagamoyo, n.º 456, Beira, Sofala'],
        },
      ],
      tables: [CompanyPdfFactory.table({
        title: 'Linhas do documento',
        columns: [
          { header: 'Descrição do serviço prestado', width: 5 },
          { header: 'Quantidade', width: 2, align: 'right' },
          { header: 'Valor unitário', width: 2, align: 'right' },
          { header: 'Total com IVA incluído', width: 3, align: 'right' },
        ],
        rows: Array.from({ length: 60 }, (_, index) => [
          `Transporte rodoviário de carga geral entre Maputo e Nampula, guia de remessa n.º ${1000 + index}`,
          '1',
          '1 000,00 MZN',
          '1 160,00 MZN',
        ]),
        totals: [
          { label: 'Subtotal (sem IVA)', value: '60 000,00 MZN' },
          // Etiqueta gerada e comprida — encosta ao valor de propósito.
          { label: 'IVA 16% sobre 60 000,00 MZN de base tributável', value: '9 600,00 MZN' },
          { label: 'Isento sobre 0,00 MZN — artigo 9.º do CIVA', value: '0,00 MZN' },
          { label: 'Total a pagar até 04 de setembro de 2026', value: '69 600,00 MZN', strong: true },
        ],
      })],
      notes: ['Documento emitido ao abrigo do regime normal de IVA. A mercadoria devolvida foi conferida no armazém central.'],
      signatures: ['Entidade emitente', 'Cliente'],
      legalNote: 'Assinatura do documento: A1b2C3d4 — Processado por computador. Software não certificado pela Autoridade Tributária.',
      ...overrides,
    });
  }

  /** Recibo de remuneração — o documento que precisa das duas assinaturas. */
  static payslip(overrides: Partial<TestPdfInput> = {}): TestPdfInput {
    return CompanyPdfFactory.input({
      title: 'Recibo de remuneração',
      reference: '2026-08',
      signatures: ['Entidade empregadora', 'Colaborador'],
      ...overrides,
    });
  }
}
