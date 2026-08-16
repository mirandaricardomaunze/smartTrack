const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const API_VERSION = process.env.NEXT_PUBLIC_API_VERSION || 'v1';

// ────────────────────────────────────────────────────────────────────────────
// Interfaces de Entidades e DTOs do Domínio (sem 'any')
// ────────────────────────────────────────────────────────────────────────────

export interface HistoryItem {
  id?: string;
  order_id?: string;
  status: string;
  description: string;
  location?: string | { lat: number; lng: number; accuracy_meters?: number };
  event_origin?: 'DRIVER' | 'SYSTEM' | 'CARRIER_INTL' | 'ADMIN';
  user_id?: string;
  device_id?: string;
  device_timestamp?: string;
  timestamp: string;
  parent_hash?: string;
  hash?: string;
}

// ─── Comprovativo de Entrega (POD) ───────────────────────────────────────────

export type PodMethod = 'signature' | 'photo' | 'signature_photo';
export type DeliveryFailureReason = 'RECIPIENT_ABSENT' | 'WRONG_ADDRESS' | 'REFUSED' | 'OTHER';

/** Motivos de devolução ao remetente (spec § 3.37). */
export type ReturnReason = 'ATTEMPTS_EXHAUSTED' | 'REFUSED' | 'WRONG_ADDRESS' | 'SENDER_REQUEST' | 'OTHER';

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  ATTEMPTS_EXHAUSTED: 'Tentativas esgotadas',
  REFUSED:            'Encomenda recusada',
  WRONG_ADDRESS:      'Morada incorreta',
  SENDER_REQUEST:     'Pedido do remetente',
  OTHER:              'Outro motivo',
};

/** O que ficou registado na devolução — motivo, quem recebeu e a fatura ativa. */
export interface ReturnInfo {
  reason: ReturnReason;
  notes?: string;
  started_at: string;
  received_by?: string;
  received_at?: string;
  has_signature?: boolean;
  invoice_alert?: { invoice_id: string; number: string; status: string; total_cents: number; note: string };
}

/**
 * Comprovativo de entrega (spec § 3.28).
 *
 * A leitura devolve só metadados: `has_signature`/`has_photo` dizem que existe
 * prova, e as imagens vêm depois por `getOrderPod(id)`. `signature`/`photo`
 * permanecem no tipo porque são o que se ENVIA ao registar a entrega.
 */
export interface ProofOfDelivery {
  method: PodMethod;
  recipient_name: string;
  signature?: string; // data URL PNG — só na escrita
  photo?: string;     // data URL — só na escrita
  has_signature?: boolean;
  has_photo?: boolean;
  notes?: string;
  coords?: { lat: number; lng: number };
  captured_by?: string;
  captured_at: string;
}

/** Imagens do comprovativo, carregadas sob pedido. */
export interface PodImages {
  signature?: string;
  photo?: string;
}

export interface BackendOrder {
  id: string;
  client_id: string;
  client_phone?: string;
  client_email?: string;
  tracking_code: string;
  current_status: string;
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  driver_id?: string;
  pod?: ProofOfDelivery;
  delivery_otp?: { code_hash?: string; expires_at?: string; attempts?: number; verified_at?: string | null };
  cod_amount?: number;
  cod_status?: CodStatus;
  cod?: CodCollection;
  value: number;
  history?: HistoryItem[];
  // Reagendamento e devolução (spec § 3.37)
  delivery_attempts?: number;
  next_attempt_on?: string;
  return_info?: ReturnInfo;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  trackingCode: string;
  client: string;
  clientPhone?: string;
  clientEmail?: string;
  destination: string;
  driver?: string;
  status: string;
  value: number;
  updatedAt: string;
  pod?: ProofOfDelivery;
  /** Estado do código de entrega (OTP): emitido e/ou verificado. */
  otp?: { issued: boolean; verified: boolean };
  codAmount?: number;
  codStatus?: CodStatus;
  cod?: CodCollection;
  history?: HistoryItem[];
  /** Tentativas de entrega já feitas (spec § 3.37). */
  deliveryAttempts?: number;
  /** Dia combinado para a nova tentativa, YYYY-MM-DD. */
  nextAttemptOn?: string;
  returnInfo?: ReturnInfo;
}

export interface CreateOrderData {
  trackingCode: string;
  client: string;
  destination: string;
  value: number;
  codAmount?: number;
  clientPhone?: string;
  clientEmail?: string;
  clientRefId?: string;   // ligação a um cliente registado (spec § 3.12)
  weightGrams?: number;   // peso para tarifação (spec § 3.13)
  pricing?: QuoteBreakdown; // detalhe do orçamento aplicado
}

export type HrEmployeeStatus = 'active' | 'inactive' | 'on_leave';
export interface HrDepartment { id:string; name:string; code:string; manager_name?:string; description?:string; status:string; employee_count:number; }
export interface HrEmployee { id:string; employee_number:string; full_name:string; email?:string; phone?:string; tax_id?:string; department_id?:string; department_name?:string; shift_id?:string; job_title:string; employment_type:'permanent'|'fixed_term'|'temporary'|'intern'; hire_date:string; salary_cents:number; status:HrEmployeeStatus; notes?:string; }
export interface HrEmployeeList { items:HrEmployee[]; total:number; page:number; pageSize:number; }
export interface HrLeave { id:string; employee_id:string; employee_name:string; employee_number:string; type:string; start_date:string; end_date:string; days:number; reason?:string; status:'pending'|'approved'|'rejected'; decision_notes?:string; }
export interface HrStats { total:number; active:number; on_leave:number; payroll_cents:number; pending_leaves:number; }
export interface HrAttendance { id:string; employee_id:string; employee_name:string; employee_number:string; work_date:string; clock_in?:string; clock_out?:string; break_minutes:number; worked_minutes:number; late_minutes:number; overtime_minutes:number; status:string; notes?:string; }
export interface HrAttendanceStats { present:number; late:number; worked_minutes:number; overtime_minutes:number; }
export interface HrPayrollItem { id:string; employee_id:string; employee_name:string; employee_number:string; base_salary_cents:number; allowances_cents:number; bonus_cents:number; overtime_cents:number; tax_cents:number; social_security_cents:number; other_deductions_cents:number; gross_cents:number; deductions_cents:number; net_cents:number; notes?:string; }
export interface HrPayroll { id:string; period:string; status:'draft'|'approved'|'paid'; employee_count:number; gross_cents:number; deductions_cents:number; net_cents:number; items?:HrPayrollItem[]; created_at:string; }
export interface HrJob { id:string; title:string; department_id?:string; department_name?:string; location?:string; employment_type:string; openings:number; status:string; description?:string; candidate_count:number; }
export interface HrCandidate { id:string; job_id:string; job_title:string; full_name:string; email?:string; phone?:string; stage:'applied'|'screening'|'interview'|'offer'|'hired'|'rejected'; source?:string; notes?:string; }
export interface HrPerformance { id:string; employee_id:string; employee_name:string; employee_number:string; job_title:string; period:string; scores:Record<string,number>; final_score:number; goals:string[]; feedback?:string; development_plan?:string; status:'draft'|'completed'; }
export interface HrOperationsSummary { leave_available_days:number;time_bank_minutes:number;documents_expiring:number;checklist_items:number;checklist_done:number;active_trainings:number;active_benefits_cents:number;advance_balance_cents:number; }
export interface HrOperationRecord { id:string;employee_id?:string;name?:string;title?:string;type?:string;kind?:string;start_time?:string;end_time?:string;break_minutes?:number;work_days?:number[];active?:boolean;year?:number;entitled_days?:number;carried_days?:number;used_days?:number;minutes?:number;entry_date?:string;expires_at?:string;status?:string;amount_cents?:number;balance_cents?:number;items?:Array<{id:string;label:string;completed:boolean}>;participant_ids?:string[];created_at:string; }
export interface HrPortalDashboard { profile:Pick<HrEmployee,'id'|'employee_number'|'full_name'|'email'|'phone'|'job_title'|'employment_type'|'hire_date'|'status'|'department_name'>;leave_balance:(HrOperationRecord&{available_days:number})|null;time_bank_minutes:number;attendance:HrAttendance[];leaves:HrLeave[];payslips:Array<HrPayrollItem&{period:string;status:'approved'|'paid'}>;documents:HrOperationRecord[];trainings:HrOperationRecord[];benefits:HrOperationRecord[];performance:HrPerformance[]; }
export interface FinanceAccount { id:string;code:string;name:string;category:'asset'|'liability'|'equity'|'revenue'|'expense';active:boolean; }
export interface FinanceEntry { id:string;type:'payable'|'receivable';description:string;party_name?:string;document_number?:string;account_id?:string;account_code?:string;account_name?:string;amount_cents:number;due_date:string;status:string;display_status:string;paid_at?:string; }
export interface FinanceSummary { cash_balance_cents:number;income_paid_cents:number;expense_paid_cents:number;receivable_open_cents:number;payable_open_cents:number;overdue_cents:number; }
export interface FleetVehicle { id:string;plate:string;make:string;model:string;year?:number;vehicle_type?:string;fuel_type:string;odometer_km:number;status:string;insurance_expiry?:string;inspection_expiry?:string;document_expired:boolean;document_expiring:boolean; }
export interface FuelEntry { id:string;vehicle_id:string;plate:string;make:string;model:string;fuel_date:string;odometer_km:number;volume_ml:number;cost_cents:number;full_tank:boolean;station?:string;consumption_l_per_100km?:number|null; }
export interface FleetStats { total:number;active:number;maintenance:number;fuel_cost_cents:number;fuel_volume_ml:number;average_consumption:number;by_modal:Array<{modal:string;total:number}>;two_three_wheelers:number; }

// ─── Modais de entrega (spec § 3.33) ─────────────────────────────────────────

/**
 * Modal de entrega. Motociclo e mototriciclo são a última milha; o painel nunca
 * escreve estas capacidades à mão — lê-as de `GET /v1/fleet/modals`, que serve
 * o mesmo catálogo que o despacho usa para recusar uma rota pesada de mais.
 */
export type DeliveryModalCode = 'MOTO' | 'MOTOTRICICLO' | 'CARRO' | 'VAN' | 'CAMINHAO';

export interface DeliveryModalSpec {
  code: DeliveryModalCode;
  label: string;
  operator_label: string;
  capacity_kg: number;
  volume_l: number;
  max_dimension_cm: number;
  licence_categories: string[];
  default_fuel: string;
  wheels: number;
  weather_exposed: boolean;
  price_multiplier: number;
  sort_order: number;
}
export interface CreateHrEmployee { employee_number:string; full_name:string; email?:string; phone?:string; tax_id?:string; department_id?:string; shift_id?:string; job_title:string; employment_type:HrEmployee['employment_type']; hire_date:string; salary_cents:number; notes?:string; }

// ─── Tarifação (spec § 3.13) ─────────────────────────────────────────────────

export type ServiceLevel = 'normal' | 'express';

export interface PricingZone {
  id: string;
  code: string;
  name: string;
  base_cents: number;
  per_kg_cents: number;
  included_kg: number;
  /** Preço por km acima de `included_km`. 0 = a zona não cobra distância. */
  per_km_cents: number;
  included_km: number;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface QuoteBreakdown {
  zone_code: string;
  zone_name: string;
  service: ServiceLevel;
  vehicle_modal: DeliveryModalCode | null;
  weight_grams: number;
  /** Dimensões usadas no cálculo, quando foram dadas. */
  dimensions_cm: Dimensions | null;
  /** Peso derivado do volume. 0 sem dimensões. */
  volumetric_grams: number;
  /** O maior entre o real e o volumétrico — é este que a tabela cobra. */
  chargeable_grams: number;
  /** O volumétrico mandou? É o que justifica a fatura ao cliente. */
  charged_by_volume: boolean;
  distance_km: number | null;
  base_cents: number;
  weight_cents: number;
  distance_cents: number;
  service_cents: number;
  modal_cents: number;
  cod_surcharge_cents: number;
  total_cents: number;
  currency: 'MZN';
  modal_fits: boolean;
  modal_reason: string | null;
  suggested_modal: DeliveryModalCode | null;
  // Contrato aplicado (§ 3.35) — nulos quando o cliente paga a tabela pública.
  contract_id?: string | null;
  contract_code?: string | null;
  contract_discount_cents?: number;
  minimum_adjustment_cents?: number;
  negotiated_zone_rate?: boolean;
}

/** Dimensões de um volume, em centímetros. */
export interface Dimensions {
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface QuoteInput {
  weight_grams?: number;
  zone_code: string;
  service?: ServiceLevel;
  vehicle_modal?: DeliveryModalCode;
  cod_amount?: number;
  /** Ativa o peso volumétrico. Só conta com os três lados preenchidos. */
  dimensions_cm?: Dimensions;
  distance_km?: number;
  /** Aplica o contrato em vigor do cliente, se houver (§ 3.35). */
  client_ref_id?: string;
}

export interface CreateZoneData {
  code: string;
  name: string;
  base_cents: number;
  per_kg_cents: number;
  included_kg: number;
  per_km_cents?: number;
  included_km?: number;
  active?: boolean;
  sort_order?: number;
}

// ─── Empresas (multi-tenant, spec § 2.4) ─────────────────────────────────────

export type CompanyStatus = 'active' | 'suspended';

export interface Company {
  id: string;
  name: string;
  slug?: string;
  status: CompanyStatus;
  plan?: string;
  created_at: string;
  updated_at: string;
}

/** Resumo da consola SUPERADMIN. */
export interface CompanySummary {
  id: string;
  name: string;
  status: CompanyStatus;
  users: number;
  orders: number;
  /** Subscrição (spec § 2.5) — ausente em empresas sem plano atribuído. */
  plan_code?: string;
  plan_name?: string;
  subscription_status?: SubscriptionStatus;
  price_cents?: number;
}

/**
 * Perfil/marca da empresa (spec § 3.17) — cabeçalho dos documentos PDF e
 * emissor das faturas fiscais.
 */
export interface CompanyProfile {
  company_id: string;
  legal_name: string;
  trade_name?: string;
  /** NUIT — 9 dígitos. */
  tax_id?: string;
  address?: string;
  city?: string;
  country: string;
  phone?: string;
  email?: string;
  website?: string;
  /** Logótipo em data URL. */
  logo?: string;
  /** Cor da marca (#RRGGBB) — títulos e filetes dos documentos. */
  brand_color: string;
  bank_details?: string;
  footer_note?: string;
  created_at: string;
  updated_at: string;
}

export type CompanyProfileData = Partial<Omit<CompanyProfile, 'company_id' | 'created_at' | 'updated_at'>>;

export interface RegisterCompanyData {
  company_name: string;
  admin_name?: string;
  admin_email: string;
  password: string;
}

export interface CompanyRegistered {
  company: Company;
  token: string;
  user: { email: string; role: string; company_id: string | null };
}

// ─── Planos e subscrições — camada SaaS (spec § 2.5) ─────────────────────────
// Aqui a PLATAFORMA cobra a EMPRESA. Não confundir com Invoice (§ 3.14), que é
// a fatura do frete que a empresa emite ao seu cliente.

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type SubscriptionInvoiceStatus = 'issued' | 'paid' | 'void';
export type BillingMethod = 'mpesa' | 'emola' | 'manual_transfer';

export interface Plan {
  code: string;
  name: string;
  description?: string;
  /** Mensal, em centavos, IVA incluído. */
  price_cents: number;
  currency: string;
  trial_days: number;
  /** null = ilimitado. */
  max_orders_per_month: number | null;
  max_users: number | null;
  max_warehouses: number | null;
  features: Record<string, unknown>;
  /** false = plano por contrato (não aparece no upgrade self-service). */
  self_serve: boolean;
  active: boolean;
  sort_order: number;
}

export interface Subscription {
  id: string;
  company_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  trial_ends_at?: string;
  current_period_start: string;
  current_period_end: string;
  past_due_since?: string;
  canceled_at?: string;
}

export interface SubscriptionAccess {
  blocked: boolean;
  reason?: string;
  grace_ends_at?: string;
}

/** Estado de um limite do plano. `limit` null = ilimitado. */
export interface LimitUsage {
  used: number;
  limit: number | null;
  remaining: number | null;
  exceeded: boolean;
  percent: number | null;
}

export interface SubscriptionUsage {
  period: string;
  orders: LimitUsage;
  users: LimitUsage;
  warehouses: LimitUsage;
  drivers: LimitUsage;
}

export interface SubscriptionInvoice {
  id: string;
  number: string;
  company_id: string;
  company_name: string;
  plan_code: string;
  plan_name: string;
  period_start: string;
  period_end: string;
  subtotal_cents: number;
  tax_rate_pct: number;
  tax_cents: number;
  total_cents: number;
  status: SubscriptionInvoiceStatus;
  payment_method?: string;
  payment_ref?: string;
  /** Assinatura de inviolabilidade (spec § 3.19) — a plataforma também assina. */
  hash?: string;
  hash_control?: string;
  signed_at?: string;
  issued_at: string;
  paid_at?: string;
  voided_at?: string;
}

export interface SubscriptionState {
  subscription: Subscription;
  plan: Plan | null;
  access: SubscriptionAccess;
  usage: SubscriptionUsage;
  invoices: SubscriptionInvoice[];
}

export interface SubscriptionSummary extends Subscription {
  company_name: string;
  company_status: CompanyStatus;
  plan_name: string;
  price_cents: number;
}

export interface PlatformBillingStats {
  mrr_cents: number;
  trialing: number;
  active: number;
  past_due: number;
  canceled: number;
  outstanding_cents: number;
  collected_cents: number;
}

export interface CheckoutResult {
  invoice: SubscriptionInvoice;
  transaction_id: string | null;
  message: string;
}

// ─── Faturação (spec § 3.14) ─────────────────────────────────────────────────

export type InvoiceStatus = 'issued' | 'paid' | 'void';

export interface InvoiceItem {
  description: string;
  quantity: number;
  unit_cents: number;
  /** Base tributável da linha (sem imposto). */
  total_cents: number;
  /** Taxa aplicada à linha (spec § 3.19); ausente em documentos antigos. */
  tax_rate_pct?: number;
  tax_cents?: number;
  exemption_code?: ExemptionCode;
  exemption_reason?: string;
}

export interface InvoiceIssuer {
  name: string;
  tax_id: string;
  address: string;
  email: string;
}


// ─── Registo de auditoria (spec § 3.21) ──────────────────────────────────────

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEvent {
  id: string;
  company_id: string;
  /** Ordem dentro da empresa — buracos denunciam remoções. */
  seq: number;
  occurred_at: string;
  actor_id?: string;
  actor_email?: string;
  actor_role?: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  entity_label?: string;
  summary: string;
  metadata: Record<string, unknown>;
  outcome: AuditOutcome;
  status_code?: number;
  method?: string;
  path?: string;
  ip?: string;
  user_agent?: string;
  request_id?: string;
  duration_ms?: number;
  hash: string;
  previous_hash: string;
}

export interface AuditListResult { items: AuditEvent[]; total: number; page: number; pageSize: number }

export interface AuditStats {
  total: number; denied: number; errors: number; actors: number;
  first_at?: string; last_at?: string;
  top_actions: Array<{ action: string; total: number }>;
}

export interface AuditChainIntegrity {
  company_id: string; ok: boolean; checked: number;
  broken: Array<{ id: string; seq: number; reason: string }>;
  gaps: Array<{ expected: number; found: number }>;
}

export interface AuditIntegrityReport { ok: boolean; checked_at: string; chains: AuditChainIntegrity[] }

export interface AuditHealth { recorded: number; failed: number; last_error: string | null; last_failure_at: string | null }

export interface AuditFilters {
  from?: string; to?: string; action?: string; actor?: string;
  entity_type?: string; entity_id?: string; outcome?: AuditOutcome; search?: string;
  page?: number; pageSize?: number;
}

// ─── Conformidade fiscal (spec § 3.19) ───────────────────────────────────────

/** Tipos de documento — numeração e cadeia de assinatura independentes por tipo. */
export type DocType = 'FT' | 'FR' | 'NC' | 'ND' | 'RC';

export type ExemptionCode = 'ISENTO' | 'EXPORTACAO' | 'NAO_SUJEITO' | 'AUTOLIQUIDACAO' | 'OUTRO';

/** Uma taxa no resumo do documento (base + imposto). */
export interface TaxSummaryLine {
  rate_pct: number;
  base_cents: number;
  tax_cents: number;
  exemption_code?: ExemptionCode;
  exemption_reason?: string;
}

export interface DocumentSeries {
  id: string;
  company_id: string;
  doc_type: DocType;
  series: string;
  year: number;
  last_seq: number;
  active: boolean;
}

export interface FiscalSoftware {
  name: string;
  version: string;
  /** '0' enquanto o software não estiver certificado pela AT. */
  certificate: string;
}

export interface TaxReportLine extends TaxSummaryLine {
  documents: number;
  label: string;
}

export interface TaxReportDocuments {
  doc_type: DocType;
  label: string;
  total: number;
  voided: number;
  total_cents: number;
}

/** Mapa de IVA do período — base da declaração periódica. */
export interface TaxReport {
  period: string;
  from: string;
  to: string;
  issuer: InvoiceIssuer;
  lines: TaxReportLine[];
  documents: TaxReportDocuments[];
  totals: { base_cents: number; tax_cents: number; gross_cents: number };
}

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

export interface Invoice {
  id: string;
  number: string;
  /** Tipo fiscal do documento (spec § 3.19). */
  doc_type: DocType;
  series?: string;
  seq?: number;
  order_id?: string;
  tracking_code?: string;
  client_ref_id?: string;
  client_name: string;
  client_tax_id?: string;
  client_email?: string;
  client_address?: string;
  issuer_name?: string;
  issuer_tax_id?: string;
  items: InvoiceItem[];
  /** IVA discriminado por taxa — o que a lei exige no documento. */
  tax_summary: TaxSummaryLine[];
  subtotal_cents: number;
  tax_rate_pct: number;
  tax_cents: number;
  total_cents: number;
  /** Já retificado por notas de crédito. */
  credited_cents: number;
  currency: string;
  status: InvoiceStatus;
  payment_method?: string;
  notes?: string;
  // Inviolabilidade (spec § 3.19)
  hash?: string;
  previous_hash?: string;
  /** 4 caracteres impressos no documento, para conferência contra o arquivo. */
  hash_control?: string;
  signed_at?: string;
  issued_by?: string;
  // Retificação
  related_invoice_id?: string;
  related_number?: string;
  void_reason?: string;
  issued_at: string;
  paid_at?: string;
  voided_at?: string;
  created_at: string;
  updated_at: string;
  issuer?: InvoiceIssuer;
  software?: FiscalSoftware;
}

export interface InvoiceListResult {
  items: Invoice[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InvoiceStats {
  total: number;
  issued: number;
  paid: number;
  void: number;
  /** Notas de crédito emitidas (não contam como faturas). */
  credit_notes: number;
  issued_total_cents: number;
  paid_total_cents: number;
  credited_total_cents: number;
}

// ─── Mensagens ao cliente (SMS/email) ────────────────────────────────────────

export type MessageChannel = 'sms' | 'email';
export type MessageStatus = 'sent' | 'failed' | 'simulated';

export interface OutboundMessage {
  id: string;
  channel: MessageChannel;
  recipient: string;
  subject?: string;
  body: string;
  status: MessageStatus;
  provider: string;
  provider_message_id?: string;
  order_id?: string;
  tracking_code?: string;
  error?: string;
  created_at: string;
}

export interface MessagingStats {
  sms: number;
  email: number;
  sent: number;
  failed: number;
  simulated: number;
}

export interface MessagingProvider {
  sms: { simulated: boolean };
  email: { simulated: boolean };
}

// ─── Relatórios & analytics ──────────────────────────────────────────────────

export interface ReportOverview {
  total: number;
  delivered: number;
  active: number;
  failed: number;
  cancelled: number;
  success_rate_pct: number;
  avg_delivery_hours: number;
  within_48h_pct: number;
  total_value_cents: number;
  cod_collected_cash_cents: number;
  cod_collected_mobile_cents: number;
}

export interface ReportVolumePoint {
  date: string;
  created: number;
  delivered: number;
}

export interface ReportDriverRow {
  driver_id: string;
  name: string;
  delivered: number;
  failed: number;
  cod_cash_cents: number;
  success_rate_pct: number;
}

export interface ReportStatusRow {
  status: string;
  count: number;
}

export interface ReportsSummary {
  overview: ReportOverview;
  volume: ReportVolumePoint[];
  byDriver: ReportDriverRow[];
  status: ReportStatusRow[];
  generated_at: string;
}

// ─── Suporte (chat cliente↔agente) ───────────────────────────────────────────

export type SupportSender = 'client' | 'agent' | 'system' | 'bot';
export type SupportThreadStatus = 'open' | 'resolved';

export interface SupportMessage {
  id: string;
  thread_id: string;
  sender: SupportSender;
  sender_name: string;
  body: string;
  created_at: string;
}

export interface SupportThread {
  id: string;
  client_name: string;
  client_email?: string;
  subject: string;
  order_id?: string;
  tracking_code?: string;
  status: SupportThreadStatus;
  assigned_agent_id?: string;
  message_count?: number;
  last_message_preview?: string;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  messages?: SupportMessage[];
  order?: BackendOrder;
}

export interface SupportStats {
  total: number;
  open: number;
  resolved: number;
}

// ─── Clientes / Remetentes (spec § 3.12) ─────────────────────────────────────

export type ClientType = 'individual' | 'business';
export type ClientStatus = 'active' | 'inactive';

export interface ClientAddress {
  street?: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface Client {
  id: string;
  name: string;
  type: ClientType;
  email?: string;
  phone?: string;
  tax_id?: string;
  address?: ClientAddress;
  notes?: string;
  status: ClientStatus;
  order_count?: number;
  created_at: string;
  updated_at: string;
  orders?: BackendOrder[];
  order_metrics?: { total: number; delivered: number; total_value_cents: number };
}

export interface ClientListResult {
  items: Client[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Contratos de cliente (spec § 3.35) ──────────────────────────────────────

export type ContractStatus = 'draft' | 'active' | 'suspended' | 'ended';

/** Tarifa acordada para uma zona — substitui a tabela pública nessa zona. */
export interface ContractZoneRate {
  zone_code: string;
  base_cents?: number;
  per_kg_cents?: number;
  included_kg?: number;
}

export interface ContractInput {
  client_ref_id: string;
  code: string;
  status: ContractStatus;
  starts_on: string;
  /** null = sem termo. */
  ends_on: string | null;
  discount_pct: number;
  minimum_charge_cents: number;
  payment_terms_days: number;
  /** 0 = sem limite (não "limite zero"). */
  credit_limit_cents: number;
  zone_rates: ContractZoneRate[];
  notes?: string | null;
}

export interface Contract extends ContractInput {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface CreditStatus {
  ok: boolean;
  contract_id: string | null;
  contract_code: string | null;
  credit_limit_cents: number;
  outstanding_cents: number;
  projected_cents: number;
  /** null quando não há limite acordado. */
  available_cents: number | null;
}

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft:     'Rascunho',
  active:    'Em vigor',
  suspended: 'Suspenso',
  ended:     'Terminado',
};

export interface ClientStats {
  total: number;
  active: number;
  business: number;
}

export interface CreateClientData {
  name: string;
  type?: ClientType;
  email?: string;
  phone?: string;
  tax_id?: string;
  address?: ClientAddress;
  notes?: string;
}

// ─── COD (cobrança na entrega) e acerto de caixa ─────────────────────────────

export type CodMethod = 'CASH' | 'MPESA' | 'EMOLA' | 'MKESH';
export type CodStatus = 'none' | 'pending' | 'collected' | 'settled';
export type SettlementStatus = 'open' | 'reconciled';

export interface CodCollection {
  amount: number;
  method: CodMethod;
  collected_by?: string;
  collected_at: string;
}

export interface DriverSettlement {
  id: string;
  driver_id: string;
  status: SettlementStatus;
  order_count: number;
  expected_cash_cents: number;
  expected_mobile_cents: number;
  expected_total_cents: number;
  received_cash_cents: number | null;
  difference_cents: number | null;
  order_ids: string[];
  opened_at: string;
  opened_by?: string;
  reconciled_at?: string | null;
  reconciled_by?: string | null;
  notes?: string | null;
}

export interface SettlementStats {
  open: number;
  reconciled: number;
  pendingCashCents: number;
  driversPending: number;
}

export interface DriverCodSummary {
  driver_id: string;
  order_count: number;
  expected_cash_cents: number;
  expected_mobile_cents: number;
  expected_total_cents: number;
  orders: BackendOrder[];
}

export const COD_METHOD_LABELS: Record<CodMethod, string> = {
  CASH:  'Numerário',
  MPESA: 'M-Pesa',
  EMOLA: 'e-Mola',
  MKESH: 'M-Kesh',
};

export interface BackendDriver {
  id: string;
  name: string;
  email: string;
  phone: string;
  vehicle: {
    type: DeliveryModalCode;
    plate: string;
    capacity_kg: number;
    /** Categoria da carta que habilita o modal (§ 3.33). */
    licence_category?: string;
  };
  current_status: 'available' | 'on_route' | 'offline';
  performance_metrics: {
    padding?: number;
    punctuality: number;
    success_rate: number;
    customer_rating: number;
    total_deliveries: number;
  };
  gps?: {
    lat: number;
    lng: number;
    heading: number;
    speed: number;
    updatedAt: string;
  };
  /**
   * O motorista já tem conta para entrar na aplicação? (spec § 3.32)
   * Sem conta, o registo existe no painel mas ninguém executa as entregas.
   */
  has_access?: boolean;
}

// ─── Contas e acessos (spec § 3.32) ──────────────────────────────────────────

/** Papéis que uma conta de painel pode ter — os que os endpoints honram. */
export type PanelRole = 'ADMIN' | 'SUPPORT';

export type AccountRole = PanelRole | 'SUPERADMIN' | 'DRIVER' | 'EMPLOYEE' | 'CLIENT' | 'SYSTEM';

export interface AccessAccount {
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  company_id?: string;
  status: 'active' | 'blocked';
  blocked_at?: string;
  created_at: string;
}

export interface PasswordRecoveryAvailability {
  available: boolean;
  channel: 'email';
  /** O que dizer a quem perdeu a senha quando o canal não existe. */
  fallback: string;
}

export type StopStatus = 'pending' | 'delivered' | 'failed';

/** Status canônico de rota — espelha RouteStatus do routes-service. */
export type RouteStatus = 'PLANEJADA' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'CANCELADA';

// ─── Despacho automático (spec § 3.38) ───────────────────────────────────────

/** Uma parada proposta. `geolocated: false` = entrou por capacidade, sem mapa. */
export interface DispatchStop {
  order_id: string;
  tracking_code: string;
  address: string;
  lat?: number;
  lng?: number;
  weight_grams: number | null;
  geolocated: boolean;
}

export interface DispatchRoute {
  driver_id: string;
  driver_name: string;
  vehicle_modal: string;
  capacity_kg: number;
  load_kg: number;
  /** Paradas sem peso registado — não consomem capacidade nem são recusadas. */
  unknown_weight: number;
  stops: DispatchStop[];
}

/** Encomenda que o plano não conseguiu colocar, com o motivo nomeado. */
export interface DispatchLeftover {
  order_id: string;
  tracking_code: string;
  reason: string;
}

export interface DispatchPlan {
  routes: DispatchRoute[];
  unassigned: DispatchLeftover[];
  summary: { eligible_orders: number; planned_orders: number; unassigned: number; drivers_used: number };
}

// ─── Desempenho dos motoristas (spec § 3.43) ─────────────────────────────────

/** Relatórios que o backend sabe exportar em Excel (spec § 3.44). */
export type ExcelReport = 'rentabilidade' | 'contas-a-receber' | 'desempenho' | 'ocorrencias';

/** Uma filial — que é um armazém (spec § 3.45). */
export interface Branch {
  id: string;
  code: string;
  name: string;
  address?: Record<string, unknown>;
}

/**
 * Âmbito de filial de um utilizador.
 *
 * `restricted: false` com `branches: []` significa **vê a empresa inteira**, e
 * não "não vê nada" — o ecrã não pode tratar a lista vazia como ausência.
 */
export interface UserBranchScope {
  user_id: string;
  branches: string[];
  restricted: boolean;
}

export interface BranchBreakdownRow {
  branch_id: string | null;
  branch_name: string;
  total: number;
  delivered: number;
  failed: number;
  revenue_cents: number;
}

/**
 * NÃO tem `customer_rating`: nunca existiu recolha de avaliações no sistema, e
 * os 5,0 que o cadastro mostrava eram inventados.
 */
export interface DriverPerformance {
  driver_id: string;
  driver_name?: string;
  current_status?: string | null;
  deliveries: number;
  failures: number;
  returns: number;
  in_progress: number;
  /** `null` sem amostra — 0% para quem começou ontem seria uma acusação. */
  success_rate_pct: number | null;
  first_attempt_rate_pct: number | null;
  /** `null` enquanto nenhuma zona tiver prazo acordado (§ 3.42). */
  punctuality_pct: number | null;
  sample_size: number;
  punctuality_sample: number;
  /** Exposição de caixa, não qualidade de serviço. */
  unsettled_cod_cents: number;
}

// ─── SLA e ocorrências (spec § 3.42) ─────────────────────────────────────────

/**
 * Quanto do universo é que um relatório conseguiu medir (spec § 3.51).
 *
 * `truncated: true` significa que havia mais e ficou de fora. O ecrã TEM de o
 * dizer: um número parcial apresentado como total é pior do que não haver
 * número, porque ninguém desconfia dele.
 */
export interface ReportCoverage {
  counted: number;
  ceiling: number;
  truncated: boolean;
  /** Frase pronta, redigida no backend para os ecrãs não divergirem. */
  note: string | null;
}

export interface SlaSummary {
  cumprido: number;
  incumprido: number;
  em_curso: number;
  /** Encomendas cuja zona não tem prazo acordado — ficam fora da taxa. */
  sem_prazo_acordado: number;
  total: number;
  /** `null` quando nada foi decidido ainda. */
  compliance_pct: number | null;
  measured: number;
  zones_with_target: { with_target: number; total: number };
  coverage?: ReportCoverage;
}

export type OccurrenceKind =
  | 'recipient_absent' | 'wrong_address' | 'damage' | 'delay'
  | 'refusal' | 'loss' | 'cod_mismatch';
export type OccurrencePriority = 'low' | 'normal' | 'high' | 'critical';
export type OccurrenceStatus = 'aberta' | 'em_curso' | 'resolvida' | 'cancelada';

export const OCCURRENCE_KIND_LABELS: Record<OccurrenceKind, string> = {
  recipient_absent: 'Destinatário ausente',
  wrong_address:    'Morada incorreta',
  damage:           'Dano',
  delay:            'Atraso',
  refusal:          'Recusa',
  loss:             'Extravio',
  cod_mismatch:     'Divergência de COD',
};

export const OCCURRENCE_STATUS_LABELS: Record<OccurrenceStatus, string> = {
  aberta:    'Aberta',
  em_curso:  'Em curso',
  resolvida: 'Resolvida',
  cancelada: 'Cancelada',
};

export interface OccurrenceInput {
  kind: OccurrenceKind;
  priority: OccurrencePriority;
  title: string;
  description?: string;
  tracking_code?: string;
}

export interface Occurrence extends OccurrenceInput {
  id: string;
  code: string;
  status: OccurrenceStatus;
  due_at: string | null;
  resolution: string | null;
  opened_at: string;
  closed_at: string | null;
  /** Aberta para lá do prazo interno — é a que ninguém pegou. */
  overdue: boolean;
}

export interface OccurrenceEvent {
  id: string;
  type: 'opened' | 'transition' | 'comment';
  from_status: OccurrenceStatus | null;
  to_status: OccurrenceStatus | null;
  note: string | null;
  created_at: string;
}

export interface OccurrenceStats {
  abertas: number;
  em_curso: number;
  resolvidas: number;
  vencidas: number;
}

// ─── Contas a receber (spec § 3.41) ──────────────────────────────────────────

export type AgingBucket = 'corrente' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_mais' | 'sem_prazo';

export const AGING_LABELS: Record<AgingBucket, string> = {
  corrente:  'Por vencer',
  d1_30:     '1–30 dias',
  d31_60:    '31–60 dias',
  d61_90:    '61–90 dias',
  d90_mais:  '+90 dias',
  sem_prazo: 'Sem prazo',
};

export interface ReceivableClient {
  client_ref_id: string | null;
  client_name: string;
  open_invoices: number;
  credited_cents: number;
  balance_cents: number;
  oldest_days_overdue: number;
  /** Saldo negativo: crédito a favor do cliente, não dívida. */
  in_credit: boolean;
  buckets: Record<AgingBucket, number>;
}

export interface ReceivablesPortfolio {
  clients: ReceivableClient[];
  totals: { balance_cents: number; clients: number; buckets: Record<AgingBucket, number> };
}

export interface ClientReceivables extends ReceivableClient {
  invoices: Array<{
    id: string; number: string; total_cents: number;
    issued_at: string; due_date: string | null;
    bucket: AgingBucket; days_overdue: number;
  }>;
  credit_notes: Array<{ id: string; number: string; total_cents: number }>;
}

// ─── Rentabilidade (spec § 3.40) ─────────────────────────────────────────────

/** Comum a todas as linhas de margem. */
interface MarginFields {
  revenue_cents: number;
  cost_cents: number;
  profit_cents: number;
  /** `null` sem receita — dividir por zero daria um número absurdo no ecrã. */
  margin_pct: number | null;
  /** `false` = há custo em falta; a margem está por cima. */
  cost_known: boolean;
}

export interface ClientProfit extends MarginFields {
  client: string;
  client_ref_id?: string;
  orders: number;
  orders_without_cost: number;
}

export interface RouteProfit extends MarginFields {
  route_id: string;
  driver_name?: string;
  plate: string | null;
  distance_km: number;
  stops: number;
  cost_breakdown: { fuel_cents: number; upkeep_cents: number; driver_cents: number; fuel_known: boolean };
}

export interface VehicleProfit extends MarginFields {
  plate: string;
  routes: number;
  distance_km: number;
  fuel_known: boolean;
}

/** O que entrou no cálculo e o que ficou de fora. */
export interface CostCoverage {
  fuel: { source: string; vehicles_with_data: number; vehicles_total: number };
  upkeep_cents_per_km: { value: number; source: string };
  driver_cost_per_route_cents: { value: number; source: string };
  excluded: string[];
  caveat: string;
}

// ─── Dashboard operacional (spec § 3.39) ─────────────────────────────────────

// ─── Previsão e risco (spec § 3.46 e § 3.47) ─────────────────────────────────

/**
 * Previsão de um segmento.
 *
 * `enough: false` significa que NÃO HÁ previsão — `p50_hours` e `p90_hours`
 * vêm a `null` e não devem ser mostrados como zero.
 */
export interface DeliveryPrediction {
  zone: string | null;
  service_level: string | null;
  sample_size: number;
  p50_hours: number | null;
  p90_hours: number | null;
  enough: boolean;
  /** `segment` (exato), `zone` (recurso, mistura níveis de serviço) ou null. */
  basis: 'segment' | 'zone' | null;
  /**
   * O nível de serviço a que esta linha responde, quando a previsão veio por
   * recurso à zona. Sem ele, duas linhas com os mesmos percentis seriam
   * indistinguíveis apesar de terem veredictos diferentes sobre o prazo.
   */
  for_service_level?: string;
  reason?: string;
  promise: {
    comparable: boolean;
    keeps_promise: boolean | null;
    gap_hours: number | null;
    promised_hours?: number;
  };
}

export interface DeliveryPredictionsResult {
  days: number;
  min_sample: number;
  measured_deliveries: number;
  segments: DeliveryPrediction[];
}

export interface RiskOrder {
  id: string;
  tracking_code: string;
  current_status: string;
  driver_id?: string | null;
  zone?: string | null;
  level?: 'atrasada' | 'em_risco' | 'no_prazo' | 'sem_base';
  /** `sla` (prometido) ou `p90` (medido) — sem isto o juízo é incontestável. */
  basis?: string | null;
  limit_hours?: number | null;
  elapsed_hours?: number;
  hours_in_status?: number;
}

export interface RouteDeviation {
  route_id: string;
  driver_id: string | null;
  deviations: Array<{
    order_id: string;
    planned_position: number | null;
    actual_position: number;
    kind: 'sequencia' | 'fora_do_plano';
  }>;
}

export interface RisksResult {
  in_flight: number;
  late: RiskOrder[];
  at_risk: RiskOrder[];
  stalled: RiskOrder[];
  route_deviations: RouteDeviation[];
  geographic_deviation: { detected: boolean; reason: string };
  basis: { predicted_segments: number; measured_deliveries: number; status_medians: number };
}

export interface OperationsSummary {
  orders: {
    total: number;
    open: number;
    delivered: number;
    failed: number;
    returned: number;
    at_warehouse: number;
    moving: number;
    /** Sobre o que já terminou. `null` quando nada terminou ainda. */
    success_rate_pct: number | null;
    /** Só o que foi entregue — o que está a caminho ainda pode voltar. */
    revenue_cents: number;
  };
  cod: { pending_orders: number; collected_cents: number };
  fleet: { total: number; available: number; on_route: number };
  thresholds: { stale_warehouse_days: number; stale_transit_days: number };
}

export type OperationExceptionKind =
  | 'failed_without_decision'
  | 'overdue_reschedule'
  | 'stale_in_warehouse'
  | 'stale_in_transit'
  | 'transfer_missing_items'
  | 'credit_limit_exceeded';

export interface OperationException {
  kind: OperationExceptionKind;
  entity_id: string;
  label: string;
  age_days: number;
  detail: string;
  /** Calculada no servidor: espécie + tempo parado. Ordena a fila. */
  severity: number;
}

export interface OperationsExceptions {
  exceptions: OperationException[];
  counts: Partial<Record<OperationExceptionKind, number>>;
  total: number;
}

export const EXCEPTION_LABELS: Record<OperationExceptionKind, string> = {
  overdue_reschedule:      'Reagendamento vencido',
  failed_without_decision: 'Insucesso sem decisão',
  transfer_missing_items:  'Transferência com falhas',
  stale_in_transit:        'Parada em trânsito',
  credit_limit_exceeded:   'Limite de crédito',
  stale_in_warehouse:      'Parada no armazém',
};

/** Onde se resolve cada espécie — uma exceção sem destino é só um aviso. */
export const EXCEPTION_TARGET: Record<OperationExceptionKind, string> = {
  overdue_reschedule:      '/pedidos',
  failed_without_decision: '/pedidos',
  transfer_missing_items:  '/armazens',
  stale_in_transit:        '/pedidos',
  credit_limit_exceeded:   '/clientes',
  stale_in_warehouse:      '/armazens',
};

/** Shape cru devolvido por GET /v1/routes (proxy para o routes-service). */
export interface BackendRouteStop {
  order_id: string;
  address:  string;
  lat:      number | null;
  lng:      number | null;
  sequence: number;
  status:   StopStatus;
}

export interface BackendRoute {
  id:           string;
  driver_id:    string;
  stops:        BackendRouteStop[];
  status:       RouteStatus;
  distance_km:  number | null;
  optimized_at: string;
  created_at:   string;
  updated_at:   string;
  /** Contadores derivados no serviço — ver summarizeRoute() */
  summary?: {
    total:     number;
    delivered: number;
    failed:    number;
    pending:   number;
  };
}

export interface RouteStop {
  orderId:  string;
  address:  string;
  sequence: number;
  status:   StopStatus;
}

export interface Route {
  id:          string;
  driverId:    string;
  stops:       RouteStop[];
  status:      RouteStatus;
  distanceKm:  number | null;
  totalStops:  number;
  delivered:   number;
  failed:      number;
  pending:     number;
  optimizedAt: string;
}

// ─── Armazéns (gestão dinâmica) ──────────────────────────────────────────────

export type WarehouseStatus = 'active' | 'inactive';
export type MovementType = 'intake' | 'dispatch' | 'pickup';

/** Quem levanta a encomenda ao balcão (spec § 3.23). */
export interface PickupCollector {
  /** Nome de quem está no balcão. */
  collector_name: string;
  /** Documento de identificação, obrigatório. */
  collector_document: string;
  /** false = terceiro autorizado pelo destinatário. */
  is_recipient: boolean;
  /** Obrigatórios quando não é o destinatário. */
  relationship?: string;
  authorization?: string;
  /** Código de entrega, quando a encomenda tem um. */
  otp?: string;
  /** Método de cobrança, quando há COD por cobrar. */
  cod_method?: string;
  notes?: string;
}



/** Shape cru devolvido pelos endpoints /v1/warehouses. */
export interface BackendWarehouse {
  id: string;
  code: string;
  name: string;
  address: { city: string; state: string; country: string };
  capacity: number;
  status: WarehouseStatus;
  gps?: { lat: number; lng: number };
  occupancy: number;
  utilization: number;
  near_capacity: boolean;
  full: boolean;
  created_at: string;
  updated_at: string;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  city: string;
  state: string;
  country: string;
  addressLabel: string;
  capacity: number;
  status: WarehouseStatus;
  gps?: { lat: number; lng: number };
  occupancy: number;
  utilization: number;
  nearCapacity: boolean;
  full: boolean;
  updatedAt: string;
}

// ─── Inventário e transferências entre filiais (spec § 3.36) ─────────────────

export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'cancelled';
export type TransferItemStatus = 'pending' | 'received' | 'missing' | 'unexpected';

export interface TransferItem {
  id: string;
  order_id: string;
  tracking_code: string | null;
  status: TransferItemStatus;
}

export interface Transfer {
  id: string;
  code: string;
  origin_id: string;
  destination_id: string;
  status: TransferStatus;
  notes: string | null;
  dispatched_at: string | null;
  received_at: string | null;
  created_at: string;
  items: TransferItem[];
}

/** O que se esperava contra o que se leu. A mesma forma na conferência e na contagem. */
export interface Reconciliation {
  found: string[];
  missing: string[];
  unexpected: string[];
  expected_count: number;
  scanned_count: number;
  ok: boolean;
}

export interface TransferReceipt {
  transfer: Transfer;
  reconciliation: Reconciliation;
  /** Recebeu-se acima da capacidade — informa, não trava (§ 3.36). */
  over_capacity: boolean;
}

export interface WarehouseInventory {
  warehouse: { id: string; code: string; name: string; capacity: number; occupancy: number; utilization: number; near_capacity: boolean };
  items: Array<{ id: string; tracking_code: string; days_in_warehouse: number }>;
  buckets: { fresh: number; aging: number; stale: number };
  oldest_days: number;
}

export interface InventoryCount {
  id: string;
  warehouse_id: string;
  status: 'open' | 'closed';
  expected: string[];
  scanned: string[];
  result: Reconciliation | null;
  notes: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface BackendWarehouseMovement {
  id: string;
  warehouse_id: string;
  order_id: string;
  tracking_code?: string;
  type: MovementType;
  notes?: string;
  user_id?: string;
  created_at: string;
}

export interface WarehouseMovement {
  id: string;
  warehouseId: string;
  orderId: string;
  trackingCode?: string;
  type: MovementType;
  notes?: string;
  userId?: string;
  createdAt: string;
}

export interface WarehouseStats {
  total: number;
  active: number;
  storedOrders: number;
  nearCapacity: number;
}

export interface CreateWarehouseData {
  code: string;
  name: string;
  city: string;
  state?: string;
  country?: string;
  capacity?: number;
  lat?: number;
  lng?: number;
}

export type UpdateWarehouseData = Partial<CreateWarehouseData> & { status?: WarehouseStatus };

/** Resultado das operações de entrada/envio. */
export interface WarehouseOperationResult {
  warehouse: Warehouse;
  order: Order;
  movement: WarehouseMovement;
}

// ─── Rastreio Internacional ──────────────────────────────────────────────────

/** Shape cru de um envio rastreado (GET /v1/tracking). */
export interface BackendTrackedShipment {
  tracking_code: string;
  carrier: string;
  active: boolean;
  last_polled_at: string | null;
  current_status: string | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

export interface TrackedShipment {
  trackingCode: string;
  carrier: string;
  active: boolean;
  currentStatus: string | null;
  eventCount: number;
  lastPolledAt: string | null;
  updatedAt: string;
}

/** Evento normalizado de rastreio internacional. */
export interface BackendTrackingEvent {
  id: string;
  tracking_code: string;
  carrier: string;
  status: string;      // status canônico (StatusMapper)
  raw_status: string;  // valor cru da transportadora (auditoria)
  location: string | null;
  description: string | null;
  carrier_timestamp: string;
  event_hash: string;
  created_at: string;
}

export interface TrackingEvent {
  id: string;
  status: string;
  rawStatus: string;
  location: string | null;
  description: string | null;
  carrierTimestamp: string;
}

export interface BackendTrackingDetail {
  tracking_code: string;
  carrier: string;
  current_status: string;
  events: BackendTrackingEvent[];
}

export interface TrackingDetail {
  trackingCode: string;
  carrier: string;
  currentStatus: string;
  events: TrackingEvent[];
}

export interface BackendTrackingStats {
  events: number;
  active_shipments: number;
  finished_shipments: number;
  carriers: number;
}

export interface TrackingStats {
  events: number;
  activeShipments: number;
  finishedShipments: number;
  carriers: number;
}

export interface PollResult {
  trackingCode: string;
  polled: boolean;
  newEvents: number;
  currentStatus: string | null;
  finished?: boolean;
  message?: string;
}

export interface CycleResult {
  checked: number;
  newEvents: number;
  failures: number;
}

export interface TrackingProvider {
  provider: string;
  simulated: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Funções Adaptadoras / Mapeadores
// ────────────────────────────────────────────────────────────────────────────

function formatTimestamp(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return isoString;
  }
}

/** Corrige apenas mojibake legado conhecido na apresentação, preservando o registo auditável na API. */
export function cleanDisplayText(value: unknown): string {
  return String(value ?? '')
    .replace(/armaz(?:�|Ã©)m/gi, (match) => match.startsWith('A') ? 'Armazém' : 'armazém')
    .replace(/Armazém Central\s*�\s*Maputo/g, 'Armazém Central - Maputo');
}

function mapBackendRouteToRoute(br: BackendRoute): Route {
  const stops = br.stops ?? [];

  // O serviço já envia `summary`, mas derivamos como fallback para o caso de a
  // resposta vir de uma versão anterior do routes-service.
  const summary = br.summary ?? {
    total:     stops.length,
    delivered: stops.filter((s) => s.status === 'delivered').length,
    failed:    stops.filter((s) => s.status === 'failed').length,
    pending:   stops.filter((s) => s.status === 'pending').length,
  };

  return {
    id:         br.id,
    driverId:   br.driver_id,
    stops:      stops.map((s) => ({
      orderId:  s.order_id,
      address:  s.address,
      sequence: s.sequence,
      status:   s.status,
    })),
    status:      br.status,
    distanceKm:  br.distance_km,
    totalStops:  summary.total,
    delivered:   summary.delivered,
    failed:      summary.failed,
    pending:     summary.pending,
    optimizedAt: formatTimestamp(br.optimized_at),
  };
}

function mapBackendOrderToOrder(bo: BackendOrder): Order {
  const localizacaoDestino = bo.destination.city && bo.destination.state
    ? `${bo.destination.city} - ${bo.destination.state}`
    : bo.destination.city || 'Destino não especificado';

  return {
    id: bo.id,
    trackingCode: bo.tracking_code,
    client: cleanDisplayText(bo.client_id),
    clientPhone: bo.client_phone,
    clientEmail: bo.client_email,
    destination: cleanDisplayText(localizacaoDestino),
    driver: bo.driver_id,
    status: bo.current_status,
    value: bo.value,
    updatedAt: formatTimestamp(bo.updated_at),
    pod: bo.pod,
    otp: bo.delivery_otp ? { issued: true, verified: Boolean(bo.delivery_otp.verified_at) } : undefined,
    codAmount: bo.cod_amount ?? 0,
    codStatus: bo.cod_status ?? 'none',
    cod: bo.cod,
    deliveryAttempts: bo.delivery_attempts ?? 0,
    nextAttemptOn: bo.next_attempt_on,
    returnInfo: bo.return_info,
    history: (bo.history || []).map((item) => ({
      ...item,
      description: cleanDisplayText(item.description),
      location: typeof item.location === 'string' ? cleanDisplayText(item.location) : item.location,
    })),
  };
}

function mapBackendWarehouse(bw: BackendWarehouse): Warehouse {
  const { city, state, country } = bw.address ?? { city: '', state: '', country: '' };
  const addressLabel = city && state ? `${city} - ${state}` : city || 'Localização não especificada';
  return {
    id:           bw.id,
    code:         bw.code,
    name:         cleanDisplayText(bw.name),
    city,
    state,
    country,
    addressLabel: cleanDisplayText(addressLabel),
    capacity:     bw.capacity,
    status:       bw.status,
    gps:          bw.gps,
    occupancy:    bw.occupancy,
    utilization:  bw.utilization,
    nearCapacity: bw.near_capacity,
    full:         bw.full,
    updatedAt:    formatTimestamp(bw.updated_at),
  };
}

function mapBackendMovement(bm: BackendWarehouseMovement): WarehouseMovement {
  return {
    id:           bm.id,
    warehouseId:  bm.warehouse_id,
    orderId:      bm.order_id,
    trackingCode: bm.tracking_code,
    type:         bm.type,
    notes:        bm.notes ? cleanDisplayText(bm.notes) : bm.notes,
    userId:       bm.user_id,
    createdAt:    formatTimestamp(bm.created_at),
  };
}

function mapTrackedShipment(bs: BackendTrackedShipment): TrackedShipment {
  return {
    trackingCode:  bs.tracking_code,
    carrier:       bs.carrier,
    active:        bs.active,
    currentStatus: bs.current_status,
    eventCount:    bs.event_count,
    lastPolledAt:  bs.last_polled_at ? formatTimestamp(bs.last_polled_at) : null,
    updatedAt:     formatTimestamp(bs.updated_at),
  };
}

function mapTrackingEvent(be: BackendTrackingEvent): TrackingEvent {
  return {
    id:               be.id,
    status:           be.status,
    rawStatus:        be.raw_status,
    location:         cleanDisplayText(be.location),
    description:      cleanDisplayText(be.description),
    carrierTimestamp: formatTimestamp(be.carrier_timestamp),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// API Fetch Wrapper
// ────────────────────────────────────────────────────────────────────────────

export async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  });

  const response = await fetch(`${API_URL}/${API_VERSION}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    // Tenta extrair a mensagem de erro do corpo (`{ error }`) do backend.
    let serverMessage = '';
    try {
      const body = await response.clone().json();
      if (body && typeof body.error === 'string') serverMessage = body.error;
    } catch {
      /* corpo não-JSON — ignora */
    }
    throw new Error(serverMessage || `API Error: ${response.status} - ${response.statusText}`);
  }

  return response.json();
}

// ────────────────────────────────────────────────────────────────────────────
// Endpoints de API Administrador
// ────────────────────────────────────────────────────────────────────────────


/** Filtros aceites pela listagem de pedidos (spec § 3.1). */
export interface OrderListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  driver_id?: string;
  warehouse_id?: string;
  /** Filial de ORIGEM — o que entrou por esta base (spec § 3.45). */
  branch_id?: string;
  cod_status?: string;
  from?: string;
  to?: string;
}

export interface OrderListResult {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrdersStatsResponse {
  total: number;
  pending: number;
  failed: number;
  active: number;
  in_transit: number;
  awaiting_destination: number;
  delivered: number;
  /** Sobre o que já terminou (entregues + insucessos). */
  success_rate_pct: number;
}

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'suppressed';

export interface BackendNotification {
  id: string;
  user_id: string;
  role: string;
  category: 'ORDER_STATUS' | 'DESTINATION_REQUEST' | 'PAYMENT' | 'ROUTE_ASSIGNED' | 'DELIVERY_ISSUE';
  title: string;
  body: string;
  data: Record<string, unknown>;
  status: NotificationStatus;
  delivered_count: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export const adminApi = {
  /**
   * Página de pedidos, com filtros resolvidos no servidor (spec § 3.1).
   * É o que a listagem deve usar: sem isto, uma empresa com dezenas de milhares
   * de pedidos descarregava tudo para o browser a cada abertura da página.
   */
  getOrdersPage: async (params: OrderListParams = {}): Promise<OrderListResult> => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, String(value));
    const qs = q.toString();
    const raw = await fetchApi<{ items: BackendOrder[]; total: number; page: number; pageSize: number }>(
      `/orders${qs ? `?${qs}` : ''}`,
    );
    return { ...raw, items: raw.items.map(mapBackendOrderToOrder) };
  },

  /**
   * Atalho para os ecrãs que cruzam pedidos com outra coisa (rotas, movimentos,
   * acertos) e ainda não paginam. Traz uma fatia recente com teto explícito —
   * limitado, mas honesto: melhor do que fingir que traz tudo.
   */
  getOrders: async (params: OrderListParams = {}): Promise<Order[]> => {
    const page = await adminApi.getOrdersPage({ pageSize: 200, ...params });
    return page.items;
  },

  /** @deprecated Use `getOrdersPage`. */
  getPedidosPage: (params: OrderListParams = {}): Promise<OrderListResult> => adminApi.getOrdersPage(params),
  /** @deprecated Use `getOrders`. */
  getPedidos: (params: OrderListParams = {}): Promise<Order[]> => adminApi.getOrders(params),

  getOrdersStats: (): Promise<OrdersStatsResponse> => fetchApi<OrdersStatsResponse>('/orders/stats'),

  // ─── Dashboard operacional (spec § 3.39) ────────────────────────────────────
  // Contado na base, sobre a empresa inteira. O painel NÃO deve voltar a somar
  // listas no navegador: com paginação, isso descreve uma amostra e apresenta-a
  // como o retrato da operação.

  getOperationsSummary: (): Promise<OperationsSummary> =>
    fetchApi<OperationsSummary>('/operations/summary'),

  getPrevisoesEntrega: (days = 180): Promise<DeliveryPredictionsResult> =>
    fetchApi<DeliveryPredictionsResult>(`/predictions/delivery-time?days=${days}`),

  getRiscos: (days = 180): Promise<RisksResult> =>
    fetchApi<RisksResult>(`/predictions/risks?days=${days}`),

  getOperationsExceptions: (): Promise<OperationsExceptions> =>
    fetchApi<OperationsExceptions>('/operations/exceptions'),

  // ─── Rentabilidade (spec § 3.40) ────────────────────────────────────────────
  // Toda a resposta traz `cost_coverage`: uma margem sem a cobertura declarada é
  // um número que parece completo e não é.

  getRentabilidadeClientes: (): Promise<{ clients: ClientProfit[]; cost_coverage: CostCoverage; coverage?: ReportCoverage }> =>
    fetchApi('/profitability/clients'),

  getRentabilidadeRotas: (): Promise<{ routes: RouteProfit[]; cost_coverage: CostCoverage; coverage?: ReportCoverage }> =>
    fetchApi('/profitability/routes'),

  getVehicleProfitability: (): Promise<{ vehicles: VehicleProfit[]; cost_coverage: CostCoverage; coverage?: ReportCoverage }> =>
    fetchApi('/profitability/vehicles'),

  /** @deprecated Use `getVehicleProfitability`. */
  getRentabilidadeViaturas: (): Promise<{ vehicles: VehicleProfit[]; cost_coverage: CostCoverage; coverage?: ReportCoverage }> =>
    adminApi.getVehicleProfitability(),

  // ─── Contas a receber (spec § 3.41) ─────────────────────────────────────────

  getContasAReceber: (): Promise<ReceivablesPortfolio> => fetchApi('/receivables'),

  getContasAReceberCliente: (clientRefId: string): Promise<ClientReceivables> =>
    fetchApi(`/receivables/${encodeURIComponent(clientRefId)}`),

  // ─── SLA e ocorrências (spec § 3.42) ────────────────────────────────────────

  getSlaSummary: (): Promise<SlaSummary> => fetchApi('/sla/summary'),

  // ─── Desempenho dos motoristas (spec § 3.43) ────────────────────────────────
  // Calculado das encomendas. O cadastro tinha valores fixos que nunca eram
  // recalculados — não são usados.

  getDriverPerformance: (): Promise<{ drivers: DriverPerformance[]; coverage?: ReportCoverage }> =>
    fetchApi('/drivers/performance'),

  getDriverPerformanceById: (id: string): Promise<DriverPerformance> =>
    fetchApi(`/drivers/${encodeURIComponent(id)}/performance`),

  /** @deprecated Use `getDriverPerformance`. */
  getDesempenhoMotoristas: (): Promise<{ drivers: DriverPerformance[] }> => adminApi.getDriverPerformance(),
  /** @deprecated Use `getDriverPerformanceById`. */
  getDesempenhoMotorista: (id: string): Promise<DriverPerformance> => adminApi.getDriverPerformanceById(id),

  getOcorrencias: (status?: string): Promise<Occurrence[]> =>
    fetchApi(`/incidents${status ? `?status=${encodeURIComponent(status)}` : ''}`),

  getOcorrenciasStats: (): Promise<OccurrenceStats> => fetchApi('/incidents/stats'),

  abrirOcorrencia: (data: OccurrenceInput): Promise<Occurrence> =>
    fetchApi('/incidents', { method: 'POST', body: JSON.stringify(data) }),

  moverOcorrencia: (id: string, to: OccurrenceStatus, note?: string): Promise<Occurrence> =>
    fetchApi(`/incidents/${id}/transition`, { method: 'POST', body: JSON.stringify({ to, note }) }),

  getOcorrenciaHistorico: (id: string): Promise<OccurrenceEvent[]> =>
    fetchApi(`/incidents/${id}/history`),
  
  createOrder: async (order: CreateOrderData): Promise<Order> => {
    const payload = {
      tracking_code: order.trackingCode,
      client: order.client,
      destination: order.destination,
      value: order.value,
      cod_amount: order.codAmount ?? 0,
      client_phone: order.clientPhone,
      client_email: order.clientEmail,
      client_ref_id: order.clientRefId,
      weight_grams: order.weightGrams,
      pricing: order.pricing,
    };
    
    const rawOrder = await fetchApi<BackendOrder>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    
    return mapBackendOrderToOrder(rawOrder);
  },

  /**
   * Spec § 8.2 — solicita o envio de um pedido no armazém: confirma o destino e
   * transiciona para "saiu para entrega" (registando DESTINATION_CONFIRMED).
   */
  requestWarehouseShipment: async (
    id: string,
    destination: string,
    notes?: string,
    coords?: { lat: number; lng: number },
  ): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/warehouse/dispatch`, {
      method: 'POST',
      body: JSON.stringify({ destination, notes, ...(coords ? { lat: coords.lat, lng: coords.lng } : {}) }),
    });
    return mapBackendOrderToOrder(raw);
  },

  /** @deprecated Use `createOrder`. */
  createPedido: (order: CreateOrderData): Promise<Order> => adminApi.createOrder(order),

  /** Spec § 8.2, passo 4 — coloca o pedido em espera do destino do cliente. */
  holdForDestination: async (id: string, warehouseLocation: string): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        new_status: 'awaiting_destination',
        notes: 'Aguardando o cliente confirmar o destino — pedido em espera no armazém.',
        location: warehouseLocation,
      }),
    });
    return mapBackendOrderToOrder(raw);
  },

  /** Spec § 3.1/§3.5 — entrega com comprovativo (POD), OTP e cobrança COD (se houver). */
  deliverOrder: async (
    id: string,
    pod: { recipientName: string; signature?: string; photo?: string; notes?: string; coords?: { lat: number; lng: number }; codMethod?: CodMethod; otp?: string },
  ): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/deliver`, {
      method: 'POST',
      body: JSON.stringify({
        recipient_name: pod.recipientName,
        signature:      pod.signature,
        photo:          pod.photo,
        notes:          pod.notes,
        ...(pod.otp ? { otp: pod.otp } : {}),
        ...(pod.codMethod ? { cod_method: pod.codMethod } : {}),
        ...(pod.coords ? { lat: pod.coords.lat, lng: pod.coords.lng } : {}),
      }),
    });
    return mapBackendOrderToOrder(raw);
  },

  /**
   * Spec § 3.28 — imagens do comprovativo, carregadas só quando alguém as quer ver.
   * A listagem devolve `has_signature`/`has_photo`; a imagem em si custa megabytes
   * e não tem por que atravessar a rede antes de o operador abrir o detalhe.
   */
  getOrderPod: (id: string): Promise<PodImages> => fetchApi<PodImages>(`/orders/${id}/pod`),

  /** Spec § 3.1/§3.3 — gera um código de entrega e envia-o ao cliente por SMS. */
  requestDeliveryOtp: (id: string): Promise<{ sent: boolean; expires_at: string }> =>
    fetchApi<{ sent: boolean; expires_at: string }>(`/orders/${id}/delivery-otp`, { method: 'POST' }),

  /** Spec § 3.1 — regista o insucesso de uma tentativa de entrega, com motivo. */
  failDelivery: async (id: string, reason: DeliveryFailureReason, notes?: string): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/delivery-failure`, {
      method: 'POST',
      body: JSON.stringify({ reason, notes }),
    });
    return mapBackendOrderToOrder(raw);
  },

  // ─── Reagendamento e devolução ao remetente (spec § 3.37) ───────────────────

  rescheduleDelivery: async (id: string, scheduledFor: string, notes?: string): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ scheduled_for: scheduledFor, notes }),
    });
    return mapBackendOrderToOrder(raw);
  },

  /** @deprecated Use `rescheduleDelivery`. */
  reagendarEntrega: (id: string, scheduledFor: string, notes?: string): Promise<Order> =>
    adminApi.rescheduleDelivery(id, scheduledFor, notes),

  iniciarDevolucao: async (id: string, reason: ReturnReason, notes?: string): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/return`, {
      method: 'POST',
      body: JSON.stringify({ reason, notes }),
    });
    return mapBackendOrderToOrder(raw);
  },

  confirmarDevolucao: async (id: string, receivedBy: string, notes?: string): Promise<Order> => {
    const raw = await fetchApi<BackendOrder>(`/orders/${id}/return/confirm`, {
      method: 'POST',
      body: JSON.stringify({ received_by: receivedBy, notes }),
    });
    return mapBackendOrderToOrder(raw);
  },

  // ─── Acerto de caixa do motorista (COD) ────────────────────────────────────

  getSettlements: (driverId?: string): Promise<DriverSettlement[]> =>
    fetchApi<DriverSettlement[]>(`/settlements${driverId ? `?driver_id=${encodeURIComponent(driverId)}` : ''}`),

  getSettlementStats: (): Promise<SettlementStats> => fetchApi<SettlementStats>('/settlements/stats'),

  getDriverCod: (driverId: string): Promise<DriverCodSummary> =>
    fetchApi<DriverCodSummary>(`/settlements/driver/${encodeURIComponent(driverId)}/cod`),

  openSettlement: (driverId: string): Promise<DriverSettlement> =>
    fetchApi<DriverSettlement>('/settlements', {
      method: 'POST',
      body: JSON.stringify({ driver_id: driverId }),
    }),

  reconcileSettlement: (id: string, receivedCashCents: number, notes?: string): Promise<DriverSettlement> =>
    fetchApi<DriverSettlement>(`/settlements/${id}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ received_cash_cents: receivedCashCents, notes }),
    }),

  getDrivers: (): Promise<BackendDriver[]> => fetchApi<BackendDriver[]>('/drivers'),

  /** @deprecated Use `getDrivers`. */
  getMotoristas: (): Promise<BackendDriver[]> => adminApi.getDrivers(),

  /** Registra um motorista. O acesso à aplicação cria-se depois, à parte. */
  createDriver: (data: {
    name: string; phone?: string; email?: string;
    vehicle: { type: DeliveryModalCode; plate: string; capacity_kg?: number; licence_category?: string };
  }): Promise<BackendDriver> => fetchApi<BackendDriver>('/drivers', { method: 'POST', body: JSON.stringify(data) }),

  /** @deprecated Use `createDriver`. */
  createMotorista: (data: {
    name: string; phone?: string; email?: string;
    vehicle: { type: DeliveryModalCode; plate: string; capacity_kg?: number; licence_category?: string };
  }): Promise<BackendDriver> => adminApi.createDriver(data),

  // ── Contas e acessos (spec § 3.32) ────────────────────────────────────────

  /**
   * A recuperação por email está disponível nesta instalação?
   * Consultada pela página de login para não oferecer um caminho que, sem
   * provedor de email configurado, não leva a nada.
   */
  getPasswordRecovery: (): Promise<PasswordRecoveryAvailability> =>
    fetchApi<PasswordRecoveryAvailability>('/auth/password-recovery'),

  /** Quem tem acesso a esta empresa — painel, motoristas e portal, tudo junto. */
  getAccounts: (): Promise<AccessAccount[]> => fetchApi<AccessAccount[]>('/users'),

  /** Cria uma conta de painel (ADMIN ou SUPPORT). */
  createAccount: (data: { name: string; email: string; password: string; role: PanelRole }): Promise<AccessAccount> =>
    fetchApi<AccessAccount>('/users', { method: 'POST', body: JSON.stringify(data) }),

  /** Reemite a senha de uma conta — o caminho que não depende de email. */
  setAccountPassword: (id: string, password: string): Promise<AccessAccount> =>
    fetchApi<AccessAccount>(`/users/${encodeURIComponent(id)}/password`, { method: 'PUT', body: JSON.stringify({ password }) }),

  /** Suspende ou reativa o acesso de uma conta. */
  setAccountStatus: (id: string, status: 'active' | 'blocked'): Promise<AccessAccount> =>
    fetchApi<AccessAccount>(`/users/${encodeURIComponent(id)}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),

  /**
   * Cria o acesso à aplicação de um motorista.
   * A conta fica com o id do motorista — é assim que a aplicação encontra a rota
   * e as entregas dele (ver `drivers.service.grantDriverAccess`).
   */
  grantDriverAccess: (driverId: string, data: { email: string; password: string }): Promise<AccessAccount & { driver_id: string }> =>
    fetchApi<AccessAccount & { driver_id: string }>(`/drivers/${encodeURIComponent(driverId)}/access`, {
      method: 'POST', body: JSON.stringify(data),
    }),

  getHrStats: (): Promise<HrStats> => fetchApi<HrStats>('/hr/stats'),
  getHrDepartments: (): Promise<HrDepartment[]> => fetchApi<HrDepartment[]>('/hr/departments'),
  createHrDepartment: (data:{name:string;code:string;manager_name?:string;description?:string}):Promise<HrDepartment> => fetchApi<HrDepartment>('/hr/departments',{method:'POST',body:JSON.stringify(data)}),
  getHrEmployees: (params:{search?:string;status?:string;departmentId?:string;page?:number;pageSize?:number}={}):Promise<HrEmployeeList> => { const q=new URLSearchParams(); Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!=='')q.set(k,String(v));}); return fetchApi<HrEmployeeList>(`/hr/employees?${q}`); },
  createHrEmployee: (data:CreateHrEmployee):Promise<HrEmployee> => fetchApi<HrEmployee>('/hr/employees',{method:'POST',body:JSON.stringify(data)}),
  updateHrEmployee: (id:string,data:Partial<CreateHrEmployee>&{status?:HrEmployeeStatus}):Promise<HrEmployee> => fetchApi<HrEmployee>(`/hr/employees/${id}`,{method:'PUT',body:JSON.stringify(data)}),
  getHrLeaves: (status?:string):Promise<HrLeave[]> => fetchApi<HrLeave[]>(`/hr/leaves${status?`?status=${status}`:''}`),
  createHrLeave: (data:{employee_id:string;type:string;start_date:string;end_date:string;reason?:string}):Promise<HrLeave> => fetchApi<HrLeave>('/hr/leaves',{method:'POST',body:JSON.stringify(data)}),
  decideHrLeave: (id:string,status:'approved'|'rejected',notes?:string):Promise<HrLeave> => fetchApi<HrLeave>(`/hr/leaves/${id}/decision`,{method:'POST',body:JSON.stringify({status,notes})}),
  getHrAttendance: (date?:string):Promise<HrAttendance[]> => fetchApi<HrAttendance[]>(`/hr/attendance${date?`?date=${date}`:''}`),
  getHrAttendanceStats: (date?:string):Promise<HrAttendanceStats> => fetchApi<HrAttendanceStats>(`/hr/attendance/stats${date?`?date=${date}`:''}`),
  recordHrAttendance: (data:{employee_id:string;work_date:string;clock_in?:string;clock_out?:string;break_minutes?:number;status?:string;notes?:string}):Promise<HrAttendance> => fetchApi<HrAttendance>('/hr/attendance',{method:'POST',body:JSON.stringify(data)}),
  getHrPayrolls: ():Promise<HrPayroll[]> => fetchApi<HrPayroll[]>('/hr/payroll'),
  createHrPayroll: (period:string):Promise<HrPayroll> => fetchApi<HrPayroll>('/hr/payroll',{method:'POST',body:JSON.stringify({period})}),
  getHrPayroll: (id:string):Promise<HrPayroll> => fetchApi<HrPayroll>(`/hr/payroll/${id}`),
  setHrPayrollStatus: (id:string,status:'approved'|'paid'):Promise<HrPayroll> => fetchApi<HrPayroll>(`/hr/payroll/${id}/status`,{method:'POST',body:JSON.stringify({status})}),
  updateHrPayrollItem: (payrollId:string,employeeId:string,data:Partial<HrPayrollItem>):Promise<HrPayroll> => fetchApi<HrPayroll>(`/hr/payroll/${payrollId}/items/${employeeId}`,{method:'PUT',body:JSON.stringify(data)}),
  getHrJobs: ():Promise<HrJob[]> => fetchApi<HrJob[]>('/hr/recruitment/jobs'),
  createHrJob: (data:Partial<HrJob>&{title:string}):Promise<HrJob> => fetchApi<HrJob>('/hr/recruitment/jobs',{method:'POST',body:JSON.stringify(data)}),
  getHrCandidates: (jobId?:string):Promise<HrCandidate[]> => fetchApi<HrCandidate[]>(`/hr/recruitment/candidates${jobId?`?jobId=${jobId}`:''}`),
  createHrCandidate: (data:Partial<HrCandidate>&{job_id:string;full_name:string}):Promise<HrCandidate> => fetchApi<HrCandidate>('/hr/recruitment/candidates',{method:'POST',body:JSON.stringify(data)}),
  updateHrCandidateStage: (id:string,stage:HrCandidate['stage'],notes?:string):Promise<HrCandidate> => fetchApi<HrCandidate>(`/hr/recruitment/candidates/${id}/stage`,{method:'POST',body:JSON.stringify({stage,notes})}),
  getHrPerformance: ():Promise<HrPerformance[]> => fetchApi<HrPerformance[]>('/hr/performance'),
  createHrPerformance: (data:Partial<HrPerformance>&{employee_id:string;period:string;scores:Record<string,number>}):Promise<HrPerformance> => fetchApi<HrPerformance>('/hr/performance',{method:'POST',body:JSON.stringify(data)}),
  completeHrPerformance: (id:string):Promise<HrPerformance> => fetchApi<HrPerformance>(`/hr/performance/${id}/complete`,{method:'POST'}),
  getHrOperationsSummary:():Promise<HrOperationsSummary>=>fetchApi<HrOperationsSummary>('/hr/operations/summary'),
  getHrOperations:(path:string):Promise<HrOperationRecord[]>=>fetchApi<HrOperationRecord[]>(`/hr/operations/${path}`),
  createHrOperation:(path:string,data:Record<string,unknown>):Promise<HrOperationRecord>=>fetchApi<HrOperationRecord>(`/hr/operations/${path}`,{method:'POST',body:JSON.stringify(data)}),
  provisionHrPortalAccount:(data:{employee_id:string;email:string;password:string}):Promise<{id:string;email:string;role:'EMPLOYEE';employee_id:string}>=>fetchApi('/hr/portal/accounts',{method:'POST',body:JSON.stringify(data)}),
  getHrPortal:():Promise<HrPortalDashboard>=>fetchApi<HrPortalDashboard>('/hr/portal/me'),
  requestHrPortalLeave:(data:{type:string;start_date:string;end_date:string;reason?:string}):Promise<HrLeave>=>fetchApi<HrLeave>('/hr/portal/me/leaves',{method:'POST',body:JSON.stringify(data)}),
  getFinanceSummary: ():Promise<FinanceSummary> => fetchApi<FinanceSummary>('/finance/summary'),
  getFinanceAccounts: ():Promise<FinanceAccount[]> => fetchApi<FinanceAccount[]>('/finance/accounts'),
  createFinanceAccount: (data:Pick<FinanceAccount,'code'|'name'|'category'>):Promise<FinanceAccount> => fetchApi<FinanceAccount>('/finance/accounts',{method:'POST',body:JSON.stringify(data)}),
  getFinanceEntries: (params:{type?:string;status?:string;search?:string}={}):Promise<FinanceEntry[]> => {const q=new URLSearchParams(params as Record<string,string>).toString();return fetchApi<FinanceEntry[]>(`/finance/entries${q?`?${q}`:''}`);},
  createFinanceEntry: (data:Partial<FinanceEntry>&{type:'payable'|'receivable';description:string;amount_cents:number;due_date:string}):Promise<FinanceEntry> => fetchApi<FinanceEntry>('/finance/entries',{method:'POST',body:JSON.stringify(data)}),
  settleFinanceEntry: (id:string,payment_method:string,payment_reference?:string):Promise<FinanceEntry> => fetchApi<FinanceEntry>(`/finance/entries/${id}/settle`,{method:'POST',body:JSON.stringify({payment_method,payment_reference})}),
  voidFinanceEntry: (id:string):Promise<FinanceEntry> => fetchApi<FinanceEntry>(`/finance/entries/${id}/void`,{method:'POST'}),
  /** Catálogo de modais (§ 3.33) — capacidades vindas do backend, não repetidas aqui. */
  getDeliveryModals: ():Promise<DeliveryModalSpec[]> => fetchApi<DeliveryModalSpec[]>('/fleet/modals'),
  getFleetStats: ():Promise<FleetStats> => fetchApi<FleetStats>('/fleet/stats'),getFleetVehicles:():Promise<FleetVehicle[]>=>fetchApi<FleetVehicle[]>('/fleet/vehicles'),createFleetVehicle:(data:Partial<FleetVehicle>):Promise<FleetVehicle>=>fetchApi<FleetVehicle>('/fleet/vehicles',{method:'POST',body:JSON.stringify(data)}),getFuelEntries:():Promise<FuelEntry[]>=>fetchApi<FuelEntry[]>('/fleet/fuel'),createFuelEntry:(data:Partial<FuelEntry>&{vehicle_id:string;volume_ml:number;cost_cents:number;odometer_km:number;fuel_date:string}):Promise<FuelEntry>=>fetchApi<FuelEntry>('/fleet/fuel',{method:'POST',body:JSON.stringify(data)}),

  /** Histórico operacional das notificações push, da mais recente para a mais antiga. */
  getNotifications: (limit = 100): Promise<BackendNotification[]> =>
    fetchApi<BackendNotification[]>(`/notifications?limit=${limit}`),
  
  /**
   * Rotas persistidas pelo routes-service (via proxy /v1/routes do gateway).
   * Lança se o serviço estiver em baixo — a tela de Rotas trata o fallback.
   */
  getRotas: async (): Promise<Route[]> => {
    const raw = await fetchApi<BackendRoute[]>('/routes');
    return raw.map(mapBackendRouteToRoute);
  },

  // ─── Despacho automático (spec § 3.38) ──────────────────────────────────────
  // Propõe e confirma em dois passos: o plano é para ser revisto, não executado
  // às cegas.

  planearDespacho: (opts: { warehouse_id?: string; origin?: { lat: number; lng: number } } = {}): Promise<DispatchPlan> =>
    fetchApi<DispatchPlan>('/routes/dispatch/plan', { method: 'POST', body: JSON.stringify(opts) }),

  confirmarDespacho: (plan: DispatchPlan, origin?: { lat: number; lng: number }): Promise<{ created: number }> =>
    fetchApi<{ created: number }>('/routes/dispatch/confirm', {
      method: 'POST',
      body: JSON.stringify({ routes: plan.routes, origin }),
    }),
  
  /** Spec § 3.8 — resumo de relatórios (KPIs, volume, por motorista, distribuição). */
  getReportsSummary: (days = 14): Promise<ReportsSummary> =>
    fetchApi<ReportsSummary>(`/reports/summary?days=${days}`),
  
  login: (credentials: Record<string, string>): Promise<{ token: string; user: { email:string; role:string; company_id?:string|null } }> =>
    fetchApi<{ token: string; user: { email:string; role:string; company_id?:string|null } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    }),

  // ─── Empresas (multi-tenant, spec § 2.4) ────────────────────────────────────

  /** Auto-registo SaaS: cria a empresa + o primeiro ADMIN (público). */
  registerCompany: (data: RegisterCompanyData): Promise<CompanyRegistered> =>
    fetchApi<CompanyRegistered>('/companies/register', { method: 'POST', body: JSON.stringify(data) }),


  // ── Recuperação de senha (spec § 3.22) ─────────────────────────────────────
  // Públicas: quem perdeu a senha não tem token. A resposta do pedido é sempre
  // neutra — não revela se a conta existe.

  forgotPassword: (email: string): Promise<{ ok: boolean; message: string; debug_link?: string }> =>
    fetchApi('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  checkResetToken: (token: string): Promise<{ valid: boolean; reason?: string; expires_at?: string }> =>
    fetchApi(`/auth/reset-password/${encodeURIComponent(token)}`),

  resetPassword: (token: string, password: string): Promise<{ ok: boolean; message: string }> =>
    fetchApi('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }),
  // ── Perfil / marca da empresa (spec § 3.20) ────────────────────────────────

  /** Perfil da empresa em sessão — cabeçalho dos PDF e emissor fiscal. */
  getCompanyProfile: (): Promise<CompanyProfile> => fetchApi<CompanyProfile>('/companies/me/profile'),

  updateCompanyProfile: (data: CompanyProfileData): Promise<CompanyProfile> =>
    fetchApi<CompanyProfile>('/companies/me/profile', { method: 'PUT', body: JSON.stringify(data) }),

  /** Consola SUPERADMIN — resumo de todas as empresas. */
  getCompanies: (): Promise<CompanySummary[]> => fetchApi<CompanySummary[]>('/companies'),

  setCompanyStatus: (id: string, status: CompanyStatus): Promise<Company> =>
    fetchApi<Company>(`/companies/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  // ── Planos e subscrições — camada SaaS (spec § 2.5) ────────────────────────

  /** Catálogo de planos (qualquer utilizador autenticado). */
  getPlans: (): Promise<Plan[]> => fetchApi<Plan[]>('/subscriptions/plans'),

  /** Subscrição da empresa em sessão: plano, acesso, uso e faturas. */
  getMySubscription: (): Promise<SubscriptionState> => fetchApi<SubscriptionState>('/subscriptions/me'),

  /** Muda o plano da empresa (upgrade/downgrade/reativação). */
  changePlan: (planCode: string): Promise<SubscriptionState> =>
    fetchApi<SubscriptionState>('/subscriptions/me/plan', { method: 'POST', body: JSON.stringify({ plan_code: planCode }) }),

  cancelSubscription: (): Promise<SubscriptionState> =>
    fetchApi<SubscriptionState>('/subscriptions/me/cancel', { method: 'POST' }),

  /** Paga a fatura da subscrição por carteira móvel (M-Pesa/eMola). */
  checkoutSubscriptionInvoice: (id: string, method: BillingMethod, msisdn: string): Promise<CheckoutResult> =>
    fetchApi<CheckoutResult>(`/subscriptions/me/invoices/${id}/checkout`, {
      method: 'POST', body: JSON.stringify({ method, msisdn }),
    }),

  /** Consola SUPERADMIN — todas as subscrições. */
  getSubscriptions: (): Promise<SubscriptionSummary[]> => fetchApi<SubscriptionSummary[]>('/subscriptions'),

  /** Consola SUPERADMIN — MRR e cobrança pendente. */
  getPlatformBillingStats: (): Promise<PlatformBillingStats> => fetchApi<PlatformBillingStats>('/subscriptions/stats'),

  /** Consola SUPERADMIN — faturas de subscrição de todas as empresas. */
  getSubscriptionInvoices: (status?: SubscriptionInvoiceStatus): Promise<SubscriptionInvoice[]> =>
    fetchApi<SubscriptionInvoice[]>(`/subscriptions/invoices${status ? `?status=${status}` : ''}`),

  /** Consola SUPERADMIN — confirmação manual (transferência/depósito). */
  paySubscriptionInvoice: (id: string, reference?: string): Promise<SubscriptionInvoice> =>
    fetchApi<SubscriptionInvoice>(`/subscriptions/invoices/${id}/pay`, {
      method: 'POST', body: JSON.stringify({ payment_method: 'manual_transfer', reference }),
    }),

  voidSubscriptionInvoice: (id: string): Promise<SubscriptionInvoice> =>
    fetchApi<SubscriptionInvoice>(`/subscriptions/invoices/${id}/void`, { method: 'POST' }),

  /** Consola SUPERADMIN — atribui um plano a uma empresa (inclui negociados). */
  assignCompanyPlan: (companyId: string, planCode: string): Promise<SubscriptionState> =>
    fetchApi<SubscriptionState>(`/subscriptions/${companyId}/plan`, {
      method: 'POST', body: JSON.stringify({ plan_code: planCode }),
    }),

  register: (data: { name: string; email: string; password: string; role: 'ADMIN' | 'DRIVER' }): Promise<{ token: string; user: { email: string; role: string } }> =>
    fetchApi<{ token: string; user: { email: string; role: string } }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /** Regista a localização atual do próprio utilizador ("onde a pessoa usa o sistema"). */
  reportMyLocation: (lat: number, lng: number, accuracy?: number): Promise<{ success: boolean; updatedAt: string }> =>
    fetchApi<{ success: boolean; updatedAt: string }>('/users/me/location', {
      method: 'POST',
      body: JSON.stringify({ lat, lng, accuracy }),
    }),

  /** Últimas localizações de todos os utilizadores (ADMIN — monitorização). */
  getUserLocations: (): Promise<UserLocation[]> => fetchApi<UserLocation[]>('/users/locations'),

  // ─── Mensagens ao cliente (SMS/email) ──────────────────────────────────────

  getOutboundMessages: (limit = 100): Promise<OutboundMessage[]> =>
    fetchApi<OutboundMessage[]>(`/messaging/messages?limit=${limit}`),

  getMessagingStats: (): Promise<MessagingStats> => fetchApi<MessagingStats>('/messaging/stats'),

  getMessagingProvider: (): Promise<MessagingProvider> => fetchApi<MessagingProvider>('/messaging/provider'),

  // ─── Suporte (chat cliente↔agente, spec § 3.9) ─────────────────────────────

  getSupportThreads: (status?: SupportThreadStatus): Promise<SupportThread[]> =>
    fetchApi<SupportThread[]>(`/support/agent/threads${status ? `?status=${status}` : ''}`),

  getSupportStats: (): Promise<SupportStats> => fetchApi<SupportStats>('/support/agent/stats'),

  getSupportThread: (id: string): Promise<SupportThread> =>
    fetchApi<SupportThread>(`/support/agent/threads/${id}`),

  replySupportThread: (id: string, body: string): Promise<SupportThread> =>
    fetchApi<SupportThread>(`/support/agent/threads/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  updateSupportThread: (id: string, patch: { status?: SupportThreadStatus; assigned_agent_id?: string | null }): Promise<SupportThread> =>
    fetchApi<SupportThread>(`/support/agent/threads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // ─── Clientes / Remetentes (spec § 3.12) ───────────────────────────────────

  getClientes: (params: { search?: string; status?: ClientStatus; page?: number; pageSize?: number } = {}): Promise<ClientListResult> => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.status) q.set('status', params.status);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    return fetchApi<ClientListResult>(`/clients${qs ? `?${qs}` : ''}`);
  },

  getClienteStats: (): Promise<ClientStats> => fetchApi<ClientStats>('/clients/stats'),

  getCliente: (id: string): Promise<Client> => fetchApi<Client>(`/clients/${id}`),

  createCliente: (data: CreateClientData): Promise<Client> =>
    fetchApi<Client>('/clients', { method: 'POST', body: JSON.stringify(data) }),

  updateCliente: (id: string, data: Partial<CreateClientData> & { status?: ClientStatus }): Promise<Client> =>
    fetchApi<Client>(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deactivateCliente: (id: string): Promise<Client> =>
    fetchApi<Client>(`/clients/${id}/deactivate`, { method: 'POST' }),

  // ─── Contratos de cliente (spec § 3.35) ─────────────────────────────────────

  getContratos: (clientRefId?: string): Promise<Contract[]> =>
    fetchApi<Contract[]>(`/contracts${clientRefId ? `?client_ref_id=${encodeURIComponent(clientRefId)}` : ''}`),

  createContrato: (data: ContractInput): Promise<Contract> =>
    fetchApi<Contract>('/contracts', { method: 'POST', body: JSON.stringify(data) }),

  updateContrato: (id: string, data: Partial<ContractInput>): Promise<Contract> =>
    fetchApi<Contract>(`/contracts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  endContrato: (id: string): Promise<Contract> =>
    fetchApi<Contract>(`/contracts/${id}/end`, { method: 'POST' }),

  /** Dívida em aberto e margem disponível — o que decide se o cliente recebe mais serviço. */
  getCredito: (clientRefId: string): Promise<CreditStatus> =>
    fetchApi<CreditStatus>(`/contracts/credit/${encodeURIComponent(clientRefId)}`),

  // ─── Tarifação (spec § 3.13) ────────────────────────────────────────────────

  getPricingZones: (activeOnly = false): Promise<PricingZone[]> =>
    fetchApi<PricingZone[]>(`/pricing/zones${activeOnly ? '?active=true' : ''}`),

  quotePrice: (input: QuoteInput): Promise<QuoteBreakdown> =>
    fetchApi<QuoteBreakdown>('/pricing/quote', { method: 'POST', body: JSON.stringify(input) }),

  createPricingZone: (data: CreateZoneData): Promise<PricingZone> =>
    fetchApi<PricingZone>('/pricing/zones', { method: 'POST', body: JSON.stringify(data) }),

  updatePricingZone: (id: string, data: Partial<CreateZoneData>): Promise<PricingZone> =>
    fetchApi<PricingZone>(`/pricing/zones/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deactivatePricingZone: (id: string): Promise<PricingZone> =>
    fetchApi<PricingZone>(`/pricing/zones/${id}/deactivate`, { method: 'POST' }),

  // ─── Faturação (spec § 3.14) ────────────────────────────────────────────────

  getInvoices: (params: { status?: InvoiceStatus; doc_type?: DocType; search?: string; page?: number; pageSize?: number } = {}): Promise<InvoiceListResult> => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.doc_type) q.set('doc_type', params.doc_type);
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    return fetchApi<InvoiceListResult>(`/invoices${qs ? `?${qs}` : ''}`);
  },

  getInvoiceStats: (): Promise<InvoiceStats> => fetchApi<InvoiceStats>('/invoices/stats'),

  getInvoice: (id: string): Promise<Invoice> => fetchApi<Invoice>(`/invoices/${id}`),

  createInvoiceFromOrder: (orderId: string, notes?: string): Promise<Invoice> =>
    fetchApi<Invoice>('/invoices', { method: 'POST', body: JSON.stringify({ order_id: orderId, notes }) }),

  payInvoice: (id: string, paymentMethod?: string): Promise<Invoice> =>
    fetchApi<Invoice>(`/invoices/${id}/pay`, { method: 'POST', body: JSON.stringify({ payment_method: paymentMethod }) }),

  voidInvoice: (id: string, reason?: string): Promise<Invoice> =>
    fetchApi<Invoice>(`/invoices/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) }),


  // ── Registo de auditoria (spec § 3.21) ─────────────────────────────────────

  /** Eventos com filtros e paginação (ADMIN da empresa; SUPERADMIN vê tudo). */
  getAuditEvents: (filters: AuditFilters = {}): Promise<AuditListResult> => {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) q.set(key, String(value));
    const qs = q.toString();
    return fetchApi<AuditListResult>(`/audit${qs ? `?${qs}` : ''}`);
  },

  getAuditStats: (from?: string, to?: string): Promise<AuditStats> => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return fetchApi<AuditStats>(`/audit/stats${qs ? `?${qs}` : ''}`);
  },

  getAuditActions: (): Promise<string[]> => fetchApi<string[]>('/audit/actions'),

  /** Recalcula as assinaturas e procura buracos na sequência. */
  getAuditIntegrity: (): Promise<AuditIntegrityReport> => fetchApi<AuditIntegrityReport>('/audit/integrity'),

  /** Contadores do próprio registo — falhas de escrita não podem passar caladas. */
  getAuditHealth: (): Promise<AuditHealth> => fetchApi<AuditHealth>('/audit/health'),

  // ─── Conformidade fiscal (spec § 3.19) ─────────────────────────────────────

  /** Nota de crédito — a forma legal de anular/corrigir um documento entregue. */
  createCreditNote: (id: string, reason: string, amountCents?: number): Promise<Invoice> =>
    fetchApi<Invoice>(`/invoices/${id}/credit-note`, {
      method: 'POST', body: JSON.stringify({ reason, amount_cents: amountCents }),
    }),

  /** Mapa de IVA do período (AAAA-MM) — base da declaração periódica. */
  getTaxReport: (period?: string): Promise<TaxReport> =>
    fetchApi<TaxReport>(`/invoices/tax-report${period ? `?period=${period}` : ''}`),

  /** Verificação da assinatura e da sequência de todas as séries. */
  getFiscalIntegrity: (): Promise<IntegrityReport> => fetchApi<IntegrityReport>('/invoices/integrity'),

  getDocumentSeries: (year?: number): Promise<DocumentSeries[]> =>
    fetchApi<DocumentSeries[]>(`/invoices/series${year ? `?year=${year}` : ''}`),

  createDocumentSeries: (docType: DocType, series: string, year?: number): Promise<DocumentSeries> =>
    fetchApi<DocumentSeries>('/invoices/series', {
      method: 'POST', body: JSON.stringify({ doc_type: docType, series, year }),
    }),

  /**
   * Descarrega o ficheiro de auditoria (SAF-T) do período.
   * Não passa por `fetchApi` porque a resposta é XML, não JSON.
   */
  downloadSaft: async (period: string): Promise<{ filename: string; xml: string }> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const response = await fetch(`${API_URL}/${API_VERSION}/invoices/saft?period=${period}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.clone().json()).error; } catch { /* corpo não-JSON */ }
      throw new Error(message || `API Error: ${response.status}`);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    return { filename: match?.[1] ?? `SAFT_${period.replace(/-/g, '')}.xml`, xml: await response.text() };
  },

  /**
   * Descarrega um relatório em Excel (spec § 3.44).
   *
   * Não passa por `fetchApi` porque a resposta é binária. O nome do ficheiro vem
   * do servidor: é lá que se sabe qual foi o período efetivamente exportado, e
   * inventá-lo aqui daria dois ficheiros com o mesmo nome e conteúdos
   * diferentes.
   */
  downloadExcel: async (report: ExcelReport, params: Record<string, string> = {}): Promise<void> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const query = new URLSearchParams(params).toString();
    const response = await fetch(`${API_URL}/${API_VERSION}/exports/${report}${query ? `?${query}` : ''}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.clone().json()).error; } catch { /* corpo não-JSON */ }
      throw new Error(message || `API Error: ${response.status}`);
    }

    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1]
      ?? `${report}-${new Date().toISOString().slice(0, 10)}.xlsx`;

    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    // Revogar de imediato cancelaria o download em alguns browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  // ─── Filiais (spec § 3.45) ─────────────────────────────────────────────────

  getFiliais: (): Promise<{ branches: Branch[] }> => fetchApi('/branches'),

  getFiliaisDoUtilizador: (userId: string): Promise<UserBranchScope> =>
    fetchApi(`/branches/users/${userId}`),

  setFiliaisDoUtilizador: (userId: string, branches: string[]): Promise<UserBranchScope> =>
    fetchApi(`/branches/users/${userId}`, { method: 'PUT', body: JSON.stringify({ branches }) }),

  getRepartimentoPorFilial: (days = 30): Promise<{ days: number; branches: BranchBreakdownRow[] }> =>
    fetchApi(`/branches/breakdown?days=${days}`),

  // ─── Armazéns (gestão dinâmica) ────────────────────────────────────────────

  getArmazens: async (): Promise<Warehouse[]> => {
    const raw = await fetchApi<BackendWarehouse[]>('/warehouses');
    return raw.map(mapBackendWarehouse);
  },

  getWarehouseStats: (): Promise<WarehouseStats> => fetchApi<WarehouseStats>('/warehouses/stats'),

  /** @deprecated Use `getWarehouseStats`. */
  getArmazemStats: (): Promise<WarehouseStats> => adminApi.getWarehouseStats(),

  createWarehouse: async (data: CreateWarehouseData): Promise<Warehouse> => {
    const raw = await fetchApi<BackendWarehouse>('/warehouses', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return mapBackendWarehouse(raw);
  },

  /** @deprecated Use `createWarehouse`. */
  createArmazem: (data: CreateWarehouseData): Promise<Warehouse> => adminApi.createWarehouse(data),

  updateWarehouse: async (id: string, data: UpdateWarehouseData): Promise<Warehouse> => {
    const raw = await fetchApi<BackendWarehouse>(`/warehouses/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return mapBackendWarehouse(raw);
  },

  /** @deprecated Use `updateWarehouse`. */
  updateArmazem: (id: string, data: UpdateWarehouseData): Promise<Warehouse> => adminApi.updateWarehouse(id, data),

  deactivateWarehouse: async (id: string): Promise<Warehouse> => {
    const raw = await fetchApi<BackendWarehouse>(`/warehouses/${id}`, { method: 'DELETE' });
    return mapBackendWarehouse(raw);
  },

  /** @deprecated Use `deactivateWarehouse`. */
  deactivateArmazem: (id: string): Promise<Warehouse> => adminApi.deactivateWarehouse(id),

  /** Encomendas atualmente dentro do armazém (entrada ainda não expedida). */
  getWarehouseOrders: async (id: string): Promise<Order[]> => {
    const raw = await fetchApi<BackendOrder[]>(`/warehouses/${id}/orders`);
    return raw.map(mapBackendOrderToOrder);
  },

  /** @deprecated Use `getWarehouseOrders`. */
  getArmazemOrders: (id: string): Promise<Order[]> => adminApi.getWarehouseOrders(id),

  /** Histórico auditável de movimentos (entrada/envio) do armazém. */
  getWarehouseMovements: async (id: string): Promise<WarehouseMovement[]> => {
    const raw = await fetchApi<BackendWarehouseMovement[]>(`/warehouses/${id}/movements`);
    return raw.map(mapBackendMovement);
  },

  /** @deprecated Use `getWarehouseMovements`. */
  getArmazemMovements: (id: string): Promise<WarehouseMovement[]> => adminApi.getWarehouseMovements(id),

  /** Entrada: regista a receção física de uma encomenda no armazém. */
  // ─── Inventário e transferências entre filiais (spec § 3.36) ────────────────

  getInventario: (warehouseId: string): Promise<WarehouseInventory> =>
    fetchApi<WarehouseInventory>(`/inventory/warehouses/${warehouseId}`),

  getTransferencias: (warehouseId?: string): Promise<Transfer[]> =>
    fetchApi<Transfer[]>(`/inventory/transfers${warehouseId ? `?warehouse_id=${encodeURIComponent(warehouseId)}` : ''}`),

  criarTransferencia: (data: { origin_id: string; destination_id: string; tracking_codes: string[]; notes?: string }): Promise<Transfer> =>
    fetchApi<Transfer>('/inventory/transfers', { method: 'POST', body: JSON.stringify(data) }),

  despacharTransferencia: (id: string): Promise<Transfer> =>
    fetchApi<Transfer>(`/inventory/transfers/${id}/dispatch`, { method: 'POST' }),

  /** Confere o que chegou contra o manifesto e devolve as divergências. */
  receberTransferencia: (id: string, scannedCodes: string[], notes?: string): Promise<TransferReceipt> =>
    fetchApi<TransferReceipt>(`/inventory/transfers/${id}/receive`, {
      method: 'POST', body: JSON.stringify({ scanned_codes: scannedCodes, notes }),
    }),

  cancelarTransferencia: (id: string): Promise<Transfer> =>
    fetchApi<Transfer>(`/inventory/transfers/${id}/cancel`, { method: 'POST' }),

  getContagens: (warehouseId: string): Promise<InventoryCount[]> =>
    fetchApi<InventoryCount[]>(`/inventory/warehouses/${warehouseId}/counts`),

  abrirContagem: (warehouseId: string): Promise<InventoryCount> =>
    fetchApi<InventoryCount>(`/inventory/warehouses/${warehouseId}/counts`, { method: 'POST' }),

  lerNaContagem: (countId: string, codes: string[]): Promise<InventoryCount> =>
    fetchApi<InventoryCount>(`/inventory/counts/${countId}/scans`, {
      method: 'POST', body: JSON.stringify({ codes }),
    }),

  fecharContagem: (countId: string, notes?: string): Promise<InventoryCount> =>
    fetchApi<InventoryCount>(`/inventory/counts/${countId}/close`, {
      method: 'POST', body: JSON.stringify({ notes }),
    }),

  intakeEncomenda: async (
    warehouseId: string,
    payload: { orderId?: string; trackingCode?: string; notes?: string },
  ): Promise<WarehouseOperationResult> => {
    const raw = await fetchApi<{ warehouse: BackendWarehouse; order: BackendOrder; movement: BackendWarehouseMovement }>(
      `/warehouses/${warehouseId}/intake`,
      {
        method: 'POST',
        body: JSON.stringify({ order_id: payload.orderId, tracking_code: payload.trackingCode, notes: payload.notes }),
      },
    );
    return {
      warehouse: mapBackendWarehouse(raw.warehouse),
      order:     mapBackendOrderToOrder(raw.order),
      movement:  mapBackendMovement(raw.movement),
    };
  },


  /**
   * Levantamento ao balcão (spec § 3.23): o cliente — ou um terceiro autorizado
   * — vem buscar a encomenda ao armazém. Conclui o pedido sem passar por rota.
   */
  pickupEncomenda: async (
    warehouseId: string,
    payload: { orderId?: string; trackingCode?: string } & PickupCollector,
  ): Promise<WarehouseOperationResult> => {
    const raw = await fetchApi<{ warehouse: BackendWarehouse; order: BackendOrder; movement: BackendWarehouseMovement }>(
      `/warehouses/${warehouseId}/pickup`,
      {
        method: 'POST',
        body: JSON.stringify({
          order_id: payload.orderId,
          tracking_code: payload.trackingCode,
          collector_name: payload.collector_name,
          collector_document: payload.collector_document,
          is_recipient: payload.is_recipient,
          relationship: payload.relationship,
          authorization: payload.authorization,
          otp: payload.otp,
          cod_method: payload.cod_method,
          notes: payload.notes,
        }),
      },
    );
    return {
      warehouse: mapBackendWarehouse(raw.warehouse),
      order:     mapBackendOrderToOrder(raw.order),
      movement:  mapBackendMovement(raw.movement),
    };
  },

  /** Envio: expede uma encomenda do armazém (spec § 8.2). */
  dispatchEncomenda: async (
    warehouseId: string,
    payload: { orderId?: string; trackingCode?: string; destination: string; notes?: string; coords?: { lat: number; lng: number } },
  ): Promise<WarehouseOperationResult> => {
    const raw = await fetchApi<{ warehouse: BackendWarehouse; order: BackendOrder; movement: BackendWarehouseMovement }>(
      `/warehouses/${warehouseId}/dispatch`,
      {
        method: 'POST',
        body: JSON.stringify({
          order_id:      payload.orderId,
          tracking_code: payload.trackingCode,
          destination:   payload.destination,
          notes:         payload.notes,
          ...(payload.coords ? { lat: payload.coords.lat, lng: payload.coords.lng } : {}),
        }),
      },
    );
    return {
      warehouse: mapBackendWarehouse(raw.warehouse),
      order:     mapBackendOrderToOrder(raw.order),
      movement:  mapBackendMovement(raw.movement),
    };
  },

  // ─── Rastreio Internacional ────────────────────────────────────────────────

  getTrackingShipments: async (): Promise<TrackedShipment[]> => {
    const raw = await fetchApi<BackendTrackedShipment[]>('/tracking');
    return raw.map(mapTrackedShipment);
  },

  getTrackingStats: async (): Promise<TrackingStats> => {
    const s = await fetchApi<BackendTrackingStats>('/tracking/stats');
    return {
      events:           s.events,
      activeShipments:  s.active_shipments,
      finishedShipments: s.finished_shipments,
      carriers:         s.carriers,
    };
  },

  getTrackingCarriers: async (): Promise<string[]> => {
    const r = await fetchApi<{ carriers: string[] }>('/tracking/carriers');
    return r.carriers;
  },

  /** Regista um código+transportadora para acompanhamento por polling. */
  registerTracking: (trackingCode: string, carrier: string): Promise<BackendTrackedShipment> =>
    fetchApi<BackendTrackedShipment>('/tracking', {
      method: 'POST',
      body: JSON.stringify({ tracking_code: trackingCode, carrier }),
    }),

  /** Timeline normalizada de um código (público no backend). */
  getTrackingDetail: async (code: string): Promise<TrackingDetail> => {
    const d = await fetchApi<BackendTrackingDetail>(`/tracking/${encodeURIComponent(code)}`);
    return {
      trackingCode:  d.tracking_code,
      carrier:       d.carrier,
      currentStatus: d.current_status,
      events:        (d.events ?? []).map(mapTrackingEvent),
    };
  },

  /** Consulta a transportadora agora e persiste apenas o que for novo. */
  pollTracking: async (code: string, carrier: string): Promise<PollResult> => {
    const r = await fetchApi<{ tracking_code: string; polled: boolean; new_events: number; current_status: string | null; finished?: boolean; message?: string }>(
      `/tracking/${encodeURIComponent(code)}/poll`,
      { method: 'POST', body: JSON.stringify({ carrier }) },
    );
    return {
      trackingCode:  r.tracking_code,
      polled:        r.polled,
      newEvents:     r.new_events,
      currentStatus: r.current_status,
      finished:      r.finished,
      message:       r.message,
    };
  },

  /** Um ciclo completo de polling sobre os códigos ativos. */
  runTrackingCycle: async (limit?: number): Promise<CycleResult> => {
    const r = await fetchApi<{ checked: number; new_events: number; failures: number }>('/tracking/poll', {
      method: 'POST',
      body: JSON.stringify(limit ? { limit } : {}),
    });
    return { checked: r.checked, newEvents: r.new_events, failures: r.failures };
  },

  /** Modo do provedor de rastreio (real 17TRACK vs simulado). */
  getTrackingProvider: (): Promise<TrackingProvider> => fetchApi<TrackingProvider>('/tracking/provider'),
};

export interface UserLocation {
  user_id:    string;
  email:      string | null;
  role:       string | null;
  lat:        number;
  lng:        number;
  accuracy:   number | null;
  updated_at: string;
}
export type Pedido = Order;
export type HistoricoItem = HistoryItem;
