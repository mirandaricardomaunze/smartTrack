/**
 * @file company-profile.factory.ts
 * @description Test factory do perfil/marca da empresa (papel timbrado dos PDF).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.20 (Documentos PDF da empresa)
 *
 * Alinhado com backend/shared/types/src/company.types.ts.
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** GIF 1x1 transparente — o menor data URL de imagem válido. */
export const TINY_LOGO_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface TestCompanyProfileInput {
  legal_name: string;
  trade_name?: string;
  tax_id?: string;
  address?: string;
  city?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  logo?: string;
  brand_color?: string;
  bank_details?: string;
  footer_note?: string;
}

let _counter = 1;

export class CompanyProfileFactory {
  /** Perfil completo — é o caso que exercita todo o cabeçalho do documento. */
  static build(overrides: Partial<TestCompanyProfileInput> = {}): TestCompanyProfileInput {
    const n = _counter++;
    return {
      legal_name:   `Transportes ITEST ${n}, Lda.`,
      trade_name:   `ITEST Express ${n}`,
      tax_id:       '400123456',
      address:      'Av. 25 de Setembro, n.º 1234',
      city:         'Maputo',
      country:      'Moçambique',
      phone:        '+258 21 000 000',
      email:        `faturacao.itest.${n}@example.co.mz`,
      website:      'www.itest.co.mz',
      logo:         TINY_LOGO_DATA_URL,
      brand_color:  '#1D4ED8',
      bank_details: 'BCI · Conta 1234567890 · NIB 0008 0000 1234 5678 9101 5',
      footer_note:  'Capital social 100.000,00 MZN · Matriculada na Conservatória de Maputo',
      ...overrides,
    };
  }

  /** Só o obrigatório — prova que um documento sai mesmo sem marca preenchida. */
  static minimal(overrides: Partial<TestCompanyProfileInput> = {}): TestCompanyProfileInput {
    return { legal_name: `Transportes Mínimos ${_counter++}`, ...overrides };
  }
}
