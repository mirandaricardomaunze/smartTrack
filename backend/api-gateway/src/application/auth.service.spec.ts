import { describe, expect, it, vi } from 'vitest';
import { MockJwtPayloads, OrderFactory, RbacRequestFactory, RouteFactory } from '../../../../tests/harness';

// CommonJS é a fronteira atual do monólito modular.
const {
  requireRoles,
  requireSelfOrRoles,
  requireResourceOwnerOrRoles,
  requireBodySubjectOrRoles,
} = require('./auth.service');

const response = {};

describe('Auth RBAC middleware', () => {
  it('should allow ADMIN to provision operational accounts', () => {
    const next = vi.fn();
    requireRoles(['ADMIN'])(RbacRequestFactory.build(MockJwtPayloads.ADMIN), response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each(['CLIENT', 'DRIVER', 'SUPPORT'])('should deny %s from provisioning accounts', (role) => {
    const next = vi.fn();
    requireRoles(['ADMIN'])(RbacRequestFactory.build(MockJwtPayloads[role]), response, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });

  it('should allow DRIVER to update only their own GPS resource', () => {
    const next = vi.fn();
    const driver = MockJwtPayloads.DRIVER;
    requireSelfOrRoles(['ADMIN'])(RbacRequestFactory.build(driver, { id: driver.sub }), response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('should deny DRIVER from updating another GPS resource', () => {
    const next = vi.fn();
    requireSelfOrRoles(['ADMIN'])(
      RbacRequestFactory.build(MockJwtPayloads.DRIVER, { id: MockJwtPayloads.ADMIN.sub }),
      response,
      next,
    );
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });

  it('should allow ADMIN to update any GPS resource', () => {
    const next = vi.fn();
    requireSelfOrRoles(['ADMIN'])(
      RbacRequestFactory.build(MockJwtPayloads.ADMIN, { id: MockJwtPayloads.DRIVER.sub }),
      response,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('should allow DRIVER to mutate an assigned order', async () => {
    const next = vi.fn();
    const order = OrderFactory.build({ driver_id: MockJwtPayloads.DRIVER.sub });
    const guard = requireResourceOwnerOrRoles(['ADMIN'], vi.fn(async () => order));
    await guard(RbacRequestFactory.build(MockJwtPayloads.DRIVER, { id: order.id }), response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('should deny DRIVER from mutating an order assigned to another driver', async () => {
    const next = vi.fn();
    const order = OrderFactory.build({ driver_id: MockJwtPayloads.ADMIN.sub });
    const guard = requireResourceOwnerOrRoles(['ADMIN'], vi.fn(async () => order));
    await guard(RbacRequestFactory.build(MockJwtPayloads.DRIVER, { id: order.id }), response, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });

  it('should deny DRIVER from syncing a batch for another subject', () => {
    const next = vi.fn();
    const request = {
      ...RbacRequestFactory.build(MockJwtPayloads.DRIVER),
      body: { driverId: MockJwtPayloads.ADMIN.sub },
    };
    requireBodySubjectOrRoles(['ADMIN'], 'driverId')(request, response, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });

  it('should deny DRIVER from reading another driver route', async () => {
    const next = vi.fn();
    const route = RouteFactory.build({ driver_id: MockJwtPayloads.ADMIN.sub });
    const guard = requireResourceOwnerOrRoles(['ADMIN', 'SUPPORT'], vi.fn(async () => route));
    await guard(RbacRequestFactory.build(MockJwtPayloads.DRIVER, { id: route.id }), response, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  });
});
