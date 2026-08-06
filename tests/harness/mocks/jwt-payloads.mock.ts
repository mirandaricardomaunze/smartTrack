/**
 * @file jwt-payloads.mock.ts
 * @description JWT payloads de mock para testes de autorização (RBAC) (em Inglês).
 */
import { UserRole } from '../../../backend/shared/types/src/roles.enum';

export interface MockJwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  iat: number;
  exp: number;
}

const now = Math.floor(Date.now() / 1000);
const oneHour = 3600;

export const MockJwtPayloads: Record<string, MockJwtPayload> = {
  CLIENT: {
    sub:   'client-test-uuid-0001',
    email: 'client@test.com',
    role:  UserRole.CLIENT,
    iat:   now,
    exp:   now + oneHour,
  },
  DRIVER: {
    sub:   'driver-test-uuid-0001',
    email: 'driver@test.com',
    role:  UserRole.DRIVER,
    iat:   now,
    exp:   now + oneHour,
  },
  EMPLOYEE: {
    sub:   'employee-user-test-uuid-0001',
    email: 'employee@test.com',
    role:  UserRole.EMPLOYEE,
    iat:   now,
    exp:   now + oneHour,
  },
  SUPPORT: {
    sub:   'support-test-uuid-0001',
    email: 'support@test.com',
    role:  UserRole.SUPPORT,
    iat:   now,
    exp:   now + oneHour,
  },
  ADMIN: {
    sub:   'admin-test-uuid-0001',
    email: 'admin@test.com',
    role:  UserRole.ADMIN,
    iat:   now,
    exp:   now + oneHour,
  },
  SYSTEM: {
    sub:   'service-orders-uuid',
    email: 'orders-service@internal',
    role:  UserRole.SYSTEM,
    iat:   now,
    exp:   now + oneHour,
  },
};

export const MockOwnerPayload = (orderId: string): MockJwtPayload & { owned_order_id: string } => ({
  ...MockJwtPayloads.CLIENT,
  sub:            `client-owner-${orderId}`,
  owned_order_id: orderId,
});
