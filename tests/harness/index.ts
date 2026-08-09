/**
 * @file index.ts — barrel export do test harness
 *
 * Importar sempre a partir daqui:
 *   import { OrderFactory, MockJwtPayloads } from 'tests/harness';
 *
 * REGRA: nunca criar dados de teste inline nos arquivos .spec.ts.
 * Sempre usar factories, fixtures e mocks centralizados aqui.
 */

// Factories
export { OrderFactory }         from './factories/order.factory';
export { DriverFactory }        from './factories/driver.factory';
export { PaymentFactory }       from './factories/payment.factory';
export { EventoRastreioFactory } from './factories/evento-rastreio.factory';
export { SidebarStatsFactory }   from './factories/sidebar-stats.factory';
export { WarehouseFactory, WarehouseMovementFactory } from './factories/warehouse.factory';
export { TrackedShipmentFactory, IntlTrackingEventFactory } from './factories/tracking.factory';
export { PodFactory, DeliveryFailureFactory, PodImagesFactory, dataUrlOfSize, PHONE_PHOTO_BYTES, TINY_PNG_DATA_URL } from './factories/pod.factory';
export { PodCaptureFactory } from './factories/pod-capture.factory';
export type { TestImageFile, TestDecodedImage, EncodeAttempt } from './factories/pod-capture.factory';
export { NavigationFactory, MAPUTO_COORDS } from './factories/navigation.factory';
export type { TestNavigationStop } from './factories/navigation.factory';
export { DriverSettlementFactory, CodCollectionFactory } from './factories/settlement.factory';
export { OutboundMessageFactory } from './factories/messaging.factory';
export { PushFactory } from './factories/push.factory';
export type { TestFirebaseCredentials, TestPushRequest } from './factories/push.factory';
export { SupportThreadFactory, SupportMessageFactory } from './factories/support.factory';
export { ClientFactory } from './factories/client.factory';
export { ContractFactory } from './factories/contract.factory';
export { PricingZoneFactory, QuoteInputFactory, BULKY_BOX_CM, DENSE_BOX_CM } from './factories/pricing.factory';
export { DriverVehicleFactory, ModalLoadFactory, MODAL_CAPACITY_KG, MODAL_SYNONYM_CASES, DeliveryModal } from './factories/delivery-modal.factory';
export { InvoiceFactory } from './factories/invoice.factory';
export { CompanyFactory } from './factories/company.factory';
export { CompanyProfileFactory, TINY_LOGO_DATA_URL } from './factories/company-profile.factory';
export { CompanyPdfFactory } from './factories/company-pdf.factory';
export { PlanFactory, SubscriptionFactory } from './factories/subscription.factory';
export { InvoiceLineFactory, FiscalDocumentFactory, DocumentSeriesFactory, SignedChainFactory } from './factories/fiscal.factory';
export { AuditEventFactory, AuditChainFactory } from './factories/audit.factory';
export { PasswordResetFactory } from './factories/password-reset.factory';
export { UserAccessFactory } from './factories/user-access.factory';
export { PickupFactory } from './factories/pickup.factory';
export { BackupFactory } from './factories/backup.factory';
export { DeliveryOtpFactory, KNOWN_OTP_CODE, KNOWN_OTP_HASH } from './factories/otp.factory';
export { PaginationFactory } from './factories/pagination.factory';
export { RbacRequestFactory } from './factories/rbac-request.factory';
export { RouteFactory } from './factories/route.factory';
export { OfflineDeliveryFactory } from './factories/offline-delivery.factory';
export { HrEmployeeFactory, HrLeaveFactory, HrAttendanceFactory, HrPayrollFactory, HrPayslipFactory, HrJobFactory, HrCandidateFactory, HrPerformanceFactory } from './factories/hr.factory';
export { HrLeaveBalanceFactory, HrShiftFactory, HrTimeBankFactory, HrDocumentFactory, HrChecklistFactory, HrTrainingFactory, HrBenefitFactory } from './factories/hr.factory';
export { HrPortalAccountFactory, HrPortalDashboardFactory } from './factories/hr.factory';
export { FinanceAccountFactory, FinanceEntryFactory, FinanceSummaryFactory } from './factories/finance.factory';
export { FleetVehicleFactory, FuelEntryFactory, FuelConsumptionFactory } from './factories/fleet.factory';
export { ProviderHealthFactory, DeliveryIncidentFactory, ReturnRequestFactory, CustomerPortalOrderFactory, RouteConstraintsFactory, DeliveryProfitabilityFactory, ApprovalRequestFactory } from './factories/professionalization.factory';
export { MonitoringFactory } from './factories/monitoring.factory';

// Percursos (conduzem vários módulos pela ordem da operação, não geram dados)
export { DeliveryJourney } from './journeys/delivery-journey';
export type { JourneyServices, JourneyOptions, JourneyStep } from './journeys/delivery-journey';

// Sondas (ferramentas de verificação, não dados)
export { readPdfLayout, findOverlaps, findOutsideMargins, describeOverlap } from './pdf-layout';
export type { PdfTextRun, PdfLayout, MeasureFn } from './pdf-layout';
export { scanExternalAssets, describeAssetRefs, TILE_HOSTS } from './external-assets';
export type { ExternalAssetRef, ExternalAssetReport, GoogleFontImportRef } from './external-assets';

// Mocks
export { MockJwtPayloads, MockOwnerPayload } from './mocks/jwt-payloads.mock';
export { MockGatewayResponse }               from './mocks/gateway.mock';
export { OfflineSyncRepositoryMock }         from './mocks/offline-sync.repository.mock';

// Re-export types
export type { TestOrder }          from './factories/order.factory';
export type { TestDriver }         from './factories/driver.factory';
export type { TestPayment }        from './factories/payment.factory';
export type { TestTrackingEvent, EventOrigin, GeoPoint } from './factories/evento-rastreio.factory';
export type { SidebarStats, OrdersStatsResponse, DriversStatsResponse, WarehousesStatsResponse } from './factories/sidebar-stats.factory';
export type { TestWarehouse, TestWarehouseMovement } from './factories/warehouse.factory';
export type { TestTrackedShipment, TestIntlTrackingEvent, IntlCarrier } from './factories/tracking.factory';
export type { TestProofOfDelivery, TestDeliveryFailure } from './factories/pod.factory';
export type { TestDriverSettlement, TestCodCollection } from './factories/settlement.factory';
export type { TestOutboundMessage } from './factories/messaging.factory';
export type { TestSupportThreadInput, TestSupportMessage } from './factories/support.factory';
export type { TestClientInput } from './factories/client.factory';
export type { TestContractInput, TestZoneRate, TestQuoteBreakdown } from './factories/contract.factory';
export type { TestPricingZoneInput, TestQuoteInput, TestDimensions } from './factories/pricing.factory';
export type { TestDriverVehicle, TestModalLoad } from './factories/delivery-modal.factory';
export type { TestInvoiceInput, TestInvoiceItem } from './factories/invoice.factory';
export type { TestCompanyInput } from './factories/company.factory';
export type { TestCompanyProfileInput } from './factories/company-profile.factory';
export type { TestPdfProfile, TestPdfInput, TestPdfTable, TestPdfColumn, TestPdfTotal } from './factories/company-pdf.factory';
export type { TestPlanInput, TestSubscriptionInput } from './factories/subscription.factory';
export type { TestInvoiceLine, TestFiscalDocument, TestSignedDocument, TestDocumentSeries } from './factories/fiscal.factory';
export type { TestAuditEvent, TestAuditInput } from './factories/audit.factory';
export type { TestResetToken } from './factories/password-reset.factory';
export type { TestPanelUserInput, TestDriverAccessInput, TestActor, TestAccountRole } from './factories/user-access.factory';
export type { TestPickupInput } from './factories/pickup.factory';
export type { TestBackupManifest } from './factories/backup.factory';
export type { TestDeliveryOtp } from './factories/otp.factory';
export type { TestPaginationScenario } from './factories/pagination.factory';
export type { TestRbacRequest } from './factories/rbac-request.factory';
export type { TestRoute } from './factories/route.factory';
export type { TestProviderHealth, TestDeliveryIncident, TestReturnRequest, TestCustomerPortalOrder, TestRouteConstraints, TestDeliveryProfitability, TestApprovalRequest, ProviderKind, ProviderMode, IncidentKind, IncidentStatus, ReturnStatus } from './factories/professionalization.factory';
export type { TestMeasuredRequest, TestObservation, TestErrorEvent } from './factories/monitoring.factory';
