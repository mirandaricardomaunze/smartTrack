/**
 * @file fiscal.types.ts
 * @description Tipos da conformidade fiscal — documentos, séries, IVA e auditoria.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.19 (Conformidade fiscal)
 *
 * Complementa `invoice.types.ts` (§ 3.14): ali está o documento comercial, aqui
 * está o que o torna um documento FISCAL — tipo, série, assinatura encadeada,
 * decomposição do IVA por taxa e motivo de isenção.
 * Valores monetários em centavos (MZN).
 */

/** Tipos de documento. A numeração e a cadeia são independentes por tipo+série. */
export enum DocType {
  /** Fatura — a liquidar depois. */
  FT = 'FT',
  /** Fatura-recibo — emitida já paga. */
  FR = 'FR',
  /** Nota de crédito — retifica a menos uma fatura anterior. */
  NC = 'NC',
  /** Nota de débito — retifica a mais uma fatura anterior. */
  ND = 'ND',
  /** Recibo — quitação de uma fatura emitida antes. */
  RC = 'RC',
}

/** Motivo da não liquidação do imposto. O texto por extenso é sempre obrigatório. */
export enum ExemptionCode {
  ISENTO = 'ISENTO',
  EXPORTACAO = 'EXPORTACAO',
  NAO_SUJEITO = 'NAO_SUJEITO',
  AUTOLIQUIDACAO = 'AUTOLIQUIDACAO',
  OUTRO = 'OUTRO',
}

/** Linha do documento. `total_cents` é a base tributável (sem imposto). */
export interface InvoiceLine {
  description: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
  tax_rate_pct: number;
  tax_cents: number;
  /** Obrigatórios quando `tax_rate_pct` é 0. */
  exemption_code?: ExemptionCode;
  exemption_reason?: string;
}

/** Uma taxa no resumo do documento — o que sai impresso e vai para a declaração. */
export interface TaxSummaryLine {
  rate_pct: number;
  base_cents: number;
  tax_cents: number;
  exemption_code?: ExemptionCode;
  exemption_reason?: string;
}

/** Assinatura que torna o documento inviolável (encadeada no anterior da série). */
export interface DocumentSignature {
  hash: string;
  previous_hash: string;
  /** 4 caracteres impressos no documento, para conferência contra o arquivo. */
  hash_control: string;
  signed_at: string;
}

/** Série de numeração: uma sequência independente por empresa/tipo/ano. */
export interface DocumentSeries {
  id: string;
  company_id: string;
  doc_type: DocType;
  series: string;
  year: number;
  last_seq: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Identificação do software emissor (exigida no documento e na exportação). */
export interface FiscalSoftware {
  name: string;
  version: string;
  /** '0' enquanto não houver certificação atribuída pela AT. */
  certificate: string;
}

/** Uma linha do mapa de IVA do período. */
export interface TaxReportLine extends TaxSummaryLine {
  documents: number;
  label: string;
}

/** Contagem de documentos por tipo no período. */
export interface TaxReportDocuments {
  doc_type: DocType;
  label: string;
  total: number;
  voided: number;
  total_cents: number;
}

/** Mapa de IVA — a base da declaração periódica. */
export interface TaxReport {
  period: string;
  from: string;
  to: string;
  issuer: { name: string; tax_id: string; address?: string; email?: string };
  lines: TaxReportLine[];
  documents: TaxReportDocuments[];
  totals: { base_cents: number; tax_cents: number; gross_cents: number };
}

/** Resultado da verificação de uma cadeia (tipo + série). */
export interface ChainIntegrity {
  doc_type: DocType;
  series: string;
  label: string;
  ok: boolean;
  checked: number;
  /** Documentos anteriores à conformidade fiscal, emitidos sem assinatura. */
  unsigned: number;
  broken: Array<{ number: string; reason: string }>;
  gaps: Array<{ expected: number; found: number }>;
}

export interface IntegrityReport {
  ok: boolean;
  checked_at: string;
  software: FiscalSoftware;
  chains: ChainIntegrity[];
}
