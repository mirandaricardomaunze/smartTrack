# SKILL.md — rbac-enforcement

---
name: rbac-enforcement
description: >
  Guides agents in correctly applying Role-Based Access Control (RBAC)
  across all sistemaTrack services and APIs. Use when creating new endpoints,
  adding guards, reviewing authorization logic, or writing middleware.
triggers:
  - "rbac"
  - "permission"
  - "authorization"
  - "access control"
  - "guard"
  - "role"
  - "autorização"
  - "permissão"
  - "middleware auth"
  - "new endpoint"
  - "novo endpoint"
---

## Objective

Ensure all API endpoints enforce the correct RBAC roles defined in AGENTS.md,
with zero elevation-of-privilege vulnerabilities.

## Role Definitions

```typescript
// packages/shared-types/src/roles.enum.ts
export enum UserRole {
  CLIENTE   = 'CLIENTE',
  MOTORISTA = 'MOTORISTA',
  SUPORTE   = 'SUPORTE',
  ADMIN     = 'ADMIN',
  SISTEMA   = 'SISTEMA', // service-to-service only
}
```

## NestJS Guard Pattern

```typescript
// Protect a route with specific roles:
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPORTE)
@Get('/orders')
async getAllOrders() { ... }

// Public route (no auth required):
@Public()
@Get('/orders/:trackingCode/status')
async getOrderStatus(@Param('trackingCode') code: string) { ... }

// Owner-only access (user can only see their own data):
@UseGuards(JwtAuthGuard, OwnerGuard)
@Get('/orders/:id')
async getMyOrder(@Param('id') id: string, @CurrentUser() user: JwtPayload) { ... }
```

## Endpoint Authorization Matrix

| Endpoint | CLIENTE | MOTORISTA | SUPORTE | ADMIN | SISTEMA |
|----------|:-------:|:---------:|:-------:|:-----:|:-------:|
| `GET /orders/:trackingCode/status` | ✓ Public | ✓ Public | ✓ Public | ✓ | ✓ |
| `GET /orders/:id` (próprio) | ✓ Owner | — | ✓ | ✓ | ✓ |
| `GET /orders` (todos) | — | — | ✓ | ✓ | ✓ |
| `POST /orders` | ✓ | — | — | ✓ | ✓ |
| `PATCH /orders/:id/status` | — | ✓ Own route | ✓ | ✓ | ✓ |
| `GET /routes/me` | — | ✓ Own | — | ✓ | ✓ |
| `POST /payments/:orderId/charge` | ✓ Own | — | — | ✓ | ✓ |
| `GET /drivers` | — | — | — | ✓ | ✓ |
| `POST /drivers` | — | — | — | ✓ | — |
| `GET /reports` | — | — | — | ✓ | ✓ |
| `POST /chat/messages` | ✓ Own | — | ✓ | ✓ | — |
| `GET /chat/:conversationId` | ✓ Owner | — | ✓ | ✓ | — |

## OwnerGuard Pattern

For resources that belong to a specific user, use `OwnerGuard`:

```typescript
// The guard fetches the resource and checks owner against JWT sub
@Injectable()
export class OwnerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;
    const resourceId = request.params.id;

    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPORTE) return true;

    const resource = await this.resourceService.findById(resourceId);
    return resource?.owner_id === user.sub;
  }
}
```

## Rules for Agents Using This Skill

1. **Every new endpoint** must have an explicit guard — no endpoints without auth by default.
2. Public endpoints must be annotated with `@Public()` explicitly — and reviewed by a second pair of eyes.
3. MOTORISTA can only mutate status for orders in their **own current route** — never global access.
4. SUPORTE has read-only access to financial data — never write access to payments.
5. Service-to-service calls must use `SISTEMA` role via client credentials OAuth2, never user tokens.
6. Never use `role === 'ADMIN'` string literals — always use `UserRole.ADMIN` enum.

## Required Tests

```typescript
describe('OrdersController RBAC', () => {
  it('should allow CLIENTE to view their own order');
  it('should deny CLIENTE access to another customer order');
  it('should allow SUPORTE to view any order');
  it('should deny MOTORISTA access to patch order outside their route');
  it('should allow ADMIN to access all endpoints');
  it('should return 401 on missing JWT token');
  it('should return 403 on valid token with insufficient role');
});
```

## References

- `packages/shared-types/src/roles.enum.ts`
- `services/*/src/auth/guards/`
- `services/*/src/auth/decorators/`
- `tests/harness/mocks/jwt-payloads.mock.ts`
- `AGENTS.md` (section 3 — RBAC)
