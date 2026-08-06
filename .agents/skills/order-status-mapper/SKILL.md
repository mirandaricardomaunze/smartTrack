# SKILL.md — order-status-mapper

---
name: order-status-mapper
description: >
  Maps raw status strings from external carriers (17TRACK, Cainiao, Correios, etc.)
  to the canonical OrderStatus enum used across sistemaTrack.
  Use this skill whenever an agent needs to write or modify status normalization logic,
  add a new carrier integration, or handle an unknown status from an external source.
triggers:
  - "add carrier"
  - "new tracking provider"
  - "status mapping"
  - "17track"
  - "cainiao"
  - "international tracking"
  - "normalize status"
  - "status translation"
---

## Objective

Translate any external carrier's raw status string into the internal `OrderStatus` enum.
This ensures the entire system speaks one canonical vocabulary regardless of the carrier source.

## Canonical Status Enum

```typescript
// packages/shared-types/src/order-status.enum.ts
export enum OrderStatus {
  CREATED               = 'criado',
  COLLECTED             = 'coletado',
  IN_TRANSIT            = 'em_transito',
  AT_WAREHOUSE          = 'no_armazem',
  AWAITING_DESTINATION  = 'aguardando_destino',
  OUT_FOR_DELIVERY      = 'saiu_para_entrega',
  DELIVERED             = 'entregue',
  FAILED                = 'insucesso',
  CANCELLED             = 'cancelado',
}
```

## Where to Add New Mappings

File: `services/tracking-intl-service/src/domain/status-mapper.ts`

Pattern:
```typescript
export class StatusMapper {
  private static readonly maps: Record<string, Record<string, OrderStatus>> = {
    '17TRACK': {
      'Delivered':              OrderStatus.DELIVERED,
      'In Transit':             OrderStatus.IN_TRANSIT,
      'Out for Delivery':       OrderStatus.OUT_FOR_DELIVERY,
      'Arrived at warehouse':   OrderStatus.AT_WAREHOUSE,
      'Picked up':              OrderStatus.COLLECTED,
      'Delivery failed':        OrderStatus.FAILED,
      'Returned':               OrderStatus.CANCELLED,
      // ... add new mappings here
    },
    'CAINIAO': {
      'PACKAGE_ARRIVED':        OrderStatus.AT_WAREHOUSE,
      'PACKAGE_DELIVERING':     OrderStatus.OUT_FOR_DELIVERY,
      'SIGN_IN':                OrderStatus.DELIVERED,
      'FAILED_ATTEMPT':         OrderStatus.FAILED,
      // ... add new mappings here
    },
    'CORREIOS_BR': {
      'Objeto entregue':        OrderStatus.DELIVERED,
      'Objeto em transferência': OrderStatus.IN_TRANSIT,
      'Objeto saiu para entrega': OrderStatus.OUT_FOR_DELIVERY,
      'Objeto aguardando retirada': OrderStatus.AT_WAREHOUSE,
    },
  };

  static map(carrier: string, rawStatus: string): OrderStatus {
    const carrierMap = this.maps[carrier];
    if (!carrierMap) {
      // Unknown carrier → log alert, default to IN_TRANSIT
      this.logUnknownCarrier(carrier, rawStatus);
      return OrderStatus.IN_TRANSIT;
    }
    const mapped = carrierMap[rawStatus];
    if (!mapped) {
      // Unknown status for known carrier → log for manual review
      this.logUnknownStatus(carrier, rawStatus);
      return OrderStatus.IN_TRANSIT;
    }
    return mapped;
  }

  private static logUnknownCarrier(carrier: string, raw: string): void {
    // Emit alert event to observability system
    // NEVER log PII fields here
  }

  private static logUnknownStatus(carrier: string, raw: string): void {
    // Emit metric + log for ops team to add mapping
  }
}
```

## Rules for Agents Using This Skill

1. **Never** persist a raw carrier status string in `EventoRastreio` — always map first.
2. **Always** add a test case for each new mapping in `tests/unit/status-mapper.spec.ts`.
3. When a carrier returns an unknown status, default to `IN_TRANSIT` and emit an alert.
4. When adding a new carrier, add entries to `maps` **and** update `docs/events/schemas/tracking-intl-event.json` with the new carrier name.
5. Every change to this file requires updating the corresponding OpenAPI enum in `docs/openapi/tracking-service.yaml`.

## Test Pattern

```typescript
describe('StatusMapper', () => {
  it('should map 17TRACK "Delivered" to OrderStatus.DELIVERED', () => {
    expect(StatusMapper.map('17TRACK', 'Delivered')).toBe(OrderStatus.DELIVERED);
  });

  it('should default to IN_TRANSIT for unknown status', () => {
    expect(StatusMapper.map('17TRACK', 'UNKNOWN_RAW_STATUS')).toBe(OrderStatus.IN_TRANSIT);
  });

  it('should default to IN_TRANSIT for unknown carrier', () => {
    expect(StatusMapper.map('UNKNOWN_CARRIER', 'anything')).toBe(OrderStatus.IN_TRANSIT);
  });
});
```

## References

- `services/tracking-intl-service/src/domain/status-mapper.ts`
- `packages/shared-types/src/order-status.enum.ts`
- `docs/openapi/tracking-service.yaml`
- `tests/harness/fixtures/carrier-status-samples.json`
