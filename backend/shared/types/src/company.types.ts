/**
 * @file company.types.ts
 * @description Tipos de Empresa (multi-tenant).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4 (Multiempresa)
 *
 * Entidade de topo do isolamento: cada linha de dados pertence a uma empresa
 * (`company_id`). O SUPERADMIN da plataforma gere as empresas; utilizadores de
 * empresa só veem os dados da sua.
 */

export enum CompanyStatus {
  ACTIVE    = 'active',
  SUSPENDED = 'suspended',
}

export interface Company {
  id: string;
  name: string;
  slug?: string;
  status: CompanyStatus;
  plan?: string;
  created_at: string;   // ISO8601 UTC
  updated_at: string;   // ISO8601 UTC
}

/** Resposta do auto-registo SaaS. */
export interface CompanyRegistered {
  company: Company;
  token: string;
  user: { email: string; role: string; company_id: string | null };
}
