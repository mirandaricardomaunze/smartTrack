/**
 * @file driver-performance.factory.ts
 * @description Factory do desempenho real dos motoristas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.43
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */

/** Uma encomenda, no mínimo que o cálculo de desempenho consome. */
export interface TestPerformanceOrder {
  id: string;
  driver_id: string;
  current_status: string;
  /** Reagendamentos pelo caminho (§ 3.37). >0 = não foi à primeira. */
  delivery_attempts: number;
  /** Resultado do SLA (§ 3.42). `null` quando a zona não tem prazo acordado. */
  sla_outcome: 'cumprido' | 'incumprido' | 'em_curso' | 'sem_prazo_acordado';
  cod_amount: number;
  cod_status: 'none' | 'pending' | 'collected' | 'cancelled';
}

const MOTORISTA = 'driver-perf-0001';

let contador = 1;

export class DriverPerformanceFactory {
  static order(overrides: Partial<TestPerformanceOrder> = {}): TestPerformanceOrder {
    return {
      id: `order-perf-${String(contador++).padStart(4, '0')}`,
      driver_id: MOTORISTA,
      current_status: 'delivered',
      delivery_attempts: 0,
      sla_outcome: 'cumprido',
      cod_amount: 0,
      cod_status: 'none',
      ...overrides,
    };
  }

  /** Entregue à primeira e dentro do prazo. */
  static clean(): TestPerformanceOrder {
    return DriverPerformanceFactory.order();
  }

  /** Entregue, mas só depois de reagendar — não conta como sucesso à primeira. */
  static deliveredAfterReschedule(): TestPerformanceOrder {
    return DriverPerformanceFactory.order({ delivery_attempts: 2 });
  }

  /** Entregue fora do prazo acordado. */
  static deliveredLate(): TestPerformanceOrder {
    return DriverPerformanceFactory.order({ sla_outcome: 'incumprido' });
  }

  static failed(): TestPerformanceOrder {
    return DriverPerformanceFactory.order({ current_status: 'failed', sla_outcome: 'em_curso' });
  }

  static returned(): TestPerformanceOrder {
    return DriverPerformanceFactory.order({ current_status: 'returned', sla_outcome: 'sem_prazo_acordado' });
  }

  /** Ainda a caminho: não conta para nenhuma taxa. */
  static inTransit(): TestPerformanceOrder {
    return DriverPerformanceFactory.order({ current_status: 'in_transit', sla_outcome: 'em_curso' });
  }

  /** COD cobrado e ainda por entregar à empresa. */
  static withUnsettledCod(amount = 50_000): TestPerformanceOrder {
    return DriverPerformanceFactory.order({ cod_amount: amount, cod_status: 'collected' });
  }

  /** Operação sem SLA definido: nenhuma encomenda tem prazo. */
  static withoutSlaTargets(): TestPerformanceOrder[] {
    return [
      DriverPerformanceFactory.order({ sla_outcome: 'sem_prazo_acordado' }),
      DriverPerformanceFactory.order({ sla_outcome: 'sem_prazo_acordado' }),
    ];
  }

  /** Um conjunto com um pouco de tudo — 3 entregues, 1 falhada, 1 devolvida. */
  static mixed(): TestPerformanceOrder[] {
    return [
      DriverPerformanceFactory.clean(),
      DriverPerformanceFactory.clean(),
      DriverPerformanceFactory.deliveredAfterReschedule(),
      DriverPerformanceFactory.failed(),
      DriverPerformanceFactory.returned(),
    ];
  }

  static readonly MOTORISTA = MOTORISTA;
}
