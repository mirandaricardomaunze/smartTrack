import type { MockJwtPayload } from '../mocks/jwt-payloads.mock';

export interface TestRbacRequest {
  user?: MockJwtPayload;
  params: Record<string, string>;
}

export class RbacRequestFactory {
  static build(user?: MockJwtPayload, params: Record<string, string> = {}): TestRbacRequest {
    return { user, params };
  }

  static buildList(count: number, user?: MockJwtPayload): TestRbacRequest[] {
    return Array.from({ length: count }, () => this.build(user));
  }
}
