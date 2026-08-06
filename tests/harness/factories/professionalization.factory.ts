/**
 * @file professionalization.factory.ts
 * @description Dados canónicos para a evolução operacional do SmartTrack.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md §§ 3.24–3.31.
 * Valores financeiros são sempre centavos e timestamps são sempre UTC.
 */

export type ProviderKind = 'payments' | 'sms' | 'email' | 'push' | 'tracking' | 'maps';
export type ProviderMode = 'production' | 'simulated' | 'unavailable' | 'degraded';

export interface TestProviderHealth {
  id: string;
  company_id: string;
  provider: ProviderKind;
  adapter: string;
  mode: ProviderMode;
  healthy: boolean;
  checked_at: string;
  last_success_at?: string;
  error_code?: string;
  error_message?: string;
}

export type IncidentKind =
  | 'recipient_absent'
  | 'wrong_address'
  | 'damaged'
  | 'delayed'
  | 'refused'
  | 'lost'
  | 'cod_mismatch';
export type IncidentStatus = 'open' | 'assigned' | 'resolved' | 'cancelled';

export interface TestDeliveryIncident {
  id: string;
  company_id: string;
  order_id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  priority: 'low' | 'normal' | 'high' | 'critical';
  description: string;
  assigned_to?: string;
  due_at?: string;
  evidence_urls: string[];
  created_by: string;
  created_at: string;
  resolved_at?: string;
}

export type ReturnStatus = 'requested' | 'approved' | 'collecting' | 'received' | 'refunded' | 'rejected';

export interface TestReturnRequest {
  id: string;
  company_id: string;
  order_id: string;
  requested_by: string;
  reason: string;
  status: ReturnStatus;
  pickup_address: string;
  fee_cents: number;
  refund_cents: number;
  created_at: string;
  updated_at: string;
}

export interface TestCustomerPortalOrder {
  id: string;
  company_id: string;
  client_id: string;
  tracking_code: string;
  quote_cents: number;
  payment_status: 'pending' | 'paid' | 'failed' | 'refunded';
  pickup_scheduled_at?: string;
  invoice_id?: string;
  created_at: string;
}

export interface TestRouteConstraints {
  route_id: string;
  vehicle_capacity_kg: number;
  planned_load_kg: number;
  shift_start: string;
  shift_end: string;
  traffic_profile: 'normal' | 'peak' | 'blocked';
  stops: Array<{
    order_id: string;
    priority: 'normal' | 'urgent';
    service_minutes: number;
    window_start?: string;
    window_end?: string;
  }>;
}

export interface TestDeliveryProfitability {
  order_id: string;
  company_id: string;
  revenue_cents: number;
  fuel_cost_cents: number;
  driver_cost_cents: number;
  toll_cost_cents: number;
  maintenance_cost_cents: number;
  payment_fee_cents: number;
  third_party_cost_cents: number;
  margin_cents: number;
  calculated_at: string;
}

export interface TestApprovalRequest {
  id: string;
  company_id: string;
  action: 'invoice_void' | 'price_override' | 'stock_adjustment' | 'refund' | 'financial_settlement';
  entity_id: string;
  requested_by: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  decided_by?: string;
  decided_at?: string;
}

const NOW = '2026-08-04T10:00:00.000Z';
let counter = 1;
const nextId = (entity: string): string => `${entity}-test-uuid-${String(counter++).padStart(4, '0')}`;

export class ProviderHealthFactory {
  static build(overrides: Partial<TestProviderHealth> = {}): TestProviderHealth {
    return { id: nextId('provider-health'), company_id: 'company-test-uuid-0001', provider: 'payments', adapter: 'mpesa', mode: 'production', healthy: true, checked_at: NOW, last_success_at: NOW, ...overrides };
  }
  static buildList(count: number, overrides: Partial<TestProviderHealth> = {}): TestProviderHealth[] { return Array.from({ length: count }, () => this.build(overrides)); }
  static degraded(overrides: Partial<TestProviderHealth> = {}): TestProviderHealth { return this.build({ mode: 'degraded', healthy: false, error_code: 'PROVIDER_TIMEOUT', error_message: 'O provedor excedeu o tempo limite.', ...overrides }); }
  static simulated(overrides: Partial<TestProviderHealth> = {}): TestProviderHealth { return this.build({ mode: 'simulated', healthy: true, last_success_at: undefined, ...overrides }); }
}

export class DeliveryIncidentFactory {
  static build(overrides: Partial<TestDeliveryIncident> = {}): TestDeliveryIncident {
    return { id: nextId('incident'), company_id: 'company-test-uuid-0001', order_id: 'order-test-uuid-0001', kind: 'recipient_absent', status: 'open', priority: 'normal', description: 'Destinatário ausente na primeira tentativa.', evidence_urls: [], created_by: 'driver-test-uuid-0001', created_at: NOW, ...overrides };
  }
  static buildList(count: number, overrides: Partial<TestDeliveryIncident> = {}): TestDeliveryIncident[] { return Array.from({ length: count }, () => this.build(overrides)); }
}

export class ReturnRequestFactory {
  static build(overrides: Partial<TestReturnRequest> = {}): TestReturnRequest {
    return { id: nextId('return'), company_id: 'company-test-uuid-0001', order_id: 'order-test-uuid-0001', requested_by: 'client-test-uuid-0001', reason: 'Produto diferente do solicitado.', status: 'requested', pickup_address: 'Av. 24 de Julho, Maputo', fee_cents: 0, refund_cents: 125000, created_at: NOW, updated_at: NOW, ...overrides };
  }
  static buildList(count: number, overrides: Partial<TestReturnRequest> = {}): TestReturnRequest[] { return Array.from({ length: count }, () => this.build(overrides)); }
}

export class CustomerPortalOrderFactory {
  static build(overrides: Partial<TestCustomerPortalOrder> = {}): TestCustomerPortalOrder {
    return { id: nextId('portal-order'), company_id: 'company-test-uuid-0001', client_id: 'client-test-uuid-0001', tracking_code: 'ST00000001MZ', quote_cents: 35000, payment_status: 'pending', pickup_scheduled_at: '2026-08-05T08:00:00.000Z', created_at: NOW, ...overrides };
  }
  static buildList(count: number, overrides: Partial<TestCustomerPortalOrder> = {}): TestCustomerPortalOrder[] { return Array.from({ length: count }, () => this.build(overrides)); }
}

export class RouteConstraintsFactory {
  static build(overrides: Partial<TestRouteConstraints> = {}): TestRouteConstraints {
    return { route_id: nextId('route'), vehicle_capacity_kg: 1000, planned_load_kg: 650, shift_start: '2026-08-04T06:00:00.000Z', shift_end: '2026-08-04T15:00:00.000Z', traffic_profile: 'normal', stops: [{ order_id: 'order-test-uuid-0001', priority: 'normal', service_minutes: 10, window_start: '2026-08-04T08:00:00.000Z', window_end: '2026-08-04T10:00:00.000Z' }], ...overrides };
  }
  static buildList(count: number, overrides: Partial<TestRouteConstraints> = {}): TestRouteConstraints[] { return Array.from({ length: count }, () => this.build(overrides)); }
}

export class DeliveryProfitabilityFactory {
  static build(overrides: Partial<TestDeliveryProfitability> = {}): TestDeliveryProfitability {
    const base = { order_id: nextId('order-profit'), company_id: 'company-test-uuid-0001', revenue_cents: 100000, fuel_cost_cents: 15000, driver_cost_cents: 20000, toll_cost_cents: 5000, maintenance_cost_cents: 7000, payment_fee_cents: 3000, third_party_cost_cents: 0, calculated_at: NOW };
    const values = { ...base, ...overrides };
    const calculatedMargin = values.revenue_cents - values.fuel_cost_cents - values.driver_cost_cents - values.toll_cost_cents - values.maintenance_cost_cents - values.payment_fee_cents - values.third_party_cost_cents;
    return { ...values, margin_cents: overrides.margin_cents ?? calculatedMargin };
  }
  static buildList(count: number, overrides: Partial<TestDeliveryProfitability> = {}): TestDeliveryProfitability[] { return Array.from({ length: count }, () => this.build(overrides)); }
}

export class ApprovalRequestFactory {
  static build(overrides: Partial<TestApprovalRequest> = {}): TestApprovalRequest {
    return { id: nextId('approval'), company_id: 'company-test-uuid-0001', action: 'refund', entity_id: 'payment-test-uuid-0001', requested_by: 'user-test-uuid-0001', reason: 'Cobrança duplicada confirmada.', status: 'pending', requested_at: NOW, ...overrides };
  }
  static buildList(count: number, overrides: Partial<TestApprovalRequest> = {}): TestApprovalRequest[] { return Array.from({ length: count }, () => this.build(overrides)); }
}
