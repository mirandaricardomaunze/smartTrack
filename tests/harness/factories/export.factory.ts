/**
 * @file export.factory.ts
 * @description Factory dos dados que alimentam as exportações em Excel.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * Os cenários aqui reproduzem o que uma folha real vai levar: um nome com `&`
 * (que corromperia o XML), uma margem por medir, uma dívida sem prazo acordado e
 * um motorista sem amostra. São exatamente os casos que distinguem uma
 * exportação correta de uma que parece correta.
 */

/** Uma linha de rentabilidade por cliente, no formato do § 3.40. */
export interface TestProfitabilityClientRow {
  client: string;
  orders: number;
  revenue_cents: number;
  cost_cents: number;
  profit_cents: number;
  margin_pct: number | null;
  cost_known: boolean;
}

/** Uma linha da carteira de dívida, no formato do § 3.41. */
export interface TestReceivableClientRow {
  client_ref_id: string;
  client_name: string;
  open_invoices: number;
  balance_cents: number;
  oldest_days_overdue: number;
  in_credit: boolean;
  buckets: Record<string, number>;
}

/** Uma linha de desempenho, no formato do § 3.43. */
export interface TestPerformanceRow {
  driver_id: string;
  driver_name: string;
  deliveries: number;
  failures: number;
  returns: number;
  success_rate_pct: number | null;
  first_attempt_rate_pct: number | null;
  punctuality_pct: number | null;
  sample_size: number;
  unsettled_cod_cents: number;
}

function buckets(parcial: Record<string, number> = {}): Record<string, number> {
  return {
    corrente: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mais: 0, sem_prazo: 0, ...parcial,
  };
}

export const ExportFactory = {
  /**
   * Rentabilidade com os dois casos que importam: um cliente com custo medido e
   * outro cujo custo não se conhece — a folha tem de os distinguir, senão a
   * margem por apurar passa por margem zero.
   */
  profitability() {
    return {
      clients: [
        {
          client: 'Silva & Filhos, Lda',   // o `&` que corromperia o XML
          orders: 42,
          revenue_cents: 189_500_00,
          cost_cents: 121_300_00,
          profit_cents: 68_200_00,
          margin_pct: 35.99,
          cost_known: true,
        },
        {
          client: 'Mercearia Central',
          orders: 7,
          revenue_cents: 12_400_00,
          cost_cents: 0,
          profit_cents: 12_400_00,
          margin_pct: null,               // sem combustível medido nesta viatura
          cost_known: false,
        },
      ] as TestProfitabilityClientRow[],
      routes: [
        {
          route_id: 'ROT-2026-0114', driver_name: 'João Matola', plate: 'AAA-123-MC',
          distance_km: 87.4, revenue_cents: 42_000_00, cost_cents: 28_900_00, margin_pct: 31.19,
        },
        {
          route_id: 'ROT-2026-0115', driver_name: null, plate: 'BBB-456-MC',
          distance_km: 12, revenue_cents: 6_500_00, cost_cents: 0, margin_pct: null,
        },
      ],
      vehicles: [
        { plate: 'AAA-123-MC', routes: 18, distance_km: 1_432.6, revenue_cents: 610_000_00, cost_cents: 402_100_00, margin_pct: 34.08 },
      ],
      cost_coverage: {
        caveat: 'A margem exclui custos não medidos pelo sistema.',
        fuel: { vehicles_with_data: 1, vehicles_total: 3 },
        upkeep_cents_per_km: { source: 'default', value: 0 },
        driver_cost_per_route_cents: { source: 'configured', value: 85_000 },
        excluded: ['salários administrativos', 'renda do armazém'],
      },
    };
  },

  /**
   * Carteira com um cliente em atraso profundo, um dentro do prazo e um em
   * crédito. O saldo negativo existe para provar que a folha não o esconde:
   * telefonar a cobrar a quem tem crédito é o erro que isto evita.
   */
  receivables() {
    const clients: TestReceivableClientRow[] = [
      {
        client_ref_id: 'CLI-001', client_name: 'Transportes Beira & Cia',
        open_invoices: 4, balance_cents: 245_000_00, oldest_days_overdue: 127,
        in_credit: false, buckets: buckets({ d90_mais: 180_000_00, d31_60: 65_000_00 }),
      },
      {
        client_ref_id: 'CLI-002', client_name: 'Farmácia Nampula',
        open_invoices: 1, balance_cents: 18_500_00, oldest_days_overdue: 0,
        in_credit: false, buckets: buckets({ corrente: 18_500_00 }),
      },
      {
        client_ref_id: 'CLI-003', client_name: 'Cliente Balcão',
        open_invoices: 2, balance_cents: -4_000_00, oldest_days_overdue: 0,
        in_credit: true, buckets: buckets({ sem_prazo: -4_000_00 }),
      },
    ];

    return {
      clients,
      totals: {
        balance_cents: clients.reduce((s, c) => s + c.balance_cents, 0),
        clients: clients.length,
        buckets: buckets({
          corrente: 18_500_00, d31_60: 65_000_00, d90_mais: 180_000_00, sem_prazo: -4_000_00,
        }),
      },
    };
  },

  /** Desempenho com um motorista medido e outro sem uma única entrega concluída. */
  driverPerformance() {
    return {
      drivers: [
        {
          driver_id: 'DRV-001', driver_name: 'João Matola',
          deliveries: 214, failures: 9, returns: 2,
          success_rate_pct: 95.11, first_attempt_rate_pct: 88.3, punctuality_pct: null,
          sample_size: 225, unsettled_cod_cents: 32_500_00,
        },
        {
          driver_id: 'DRV-002', driver_name: 'Ana Cumbe',
          deliveries: 0, failures: 0, returns: 0,
          success_rate_pct: null, first_attempt_rate_pct: null, punctuality_pct: null,
          sample_size: 0, unsettled_cod_cents: 0,
        },
      ] as TestPerformanceRow[],
    };
  },

  /** Ocorrências: uma fora do prazo e uma dentro. */
  incidents() {
    return [
      {
        id: 'INC-1', code: 'OC-2026-0007', kind: 'extravio', priority: 'alta', status: 'aberta',
        title: 'Volume não localizado no armazém', tracking_code: 'TRK900000001BR',
        opened_at: '2026-08-01T09:12:00.000Z', due_at: '2026-08-01T13:12:00.000Z', overdue: true,
      },
      {
        id: 'INC-2', code: 'OC-2026-0008', kind: 'atraso', priority: 'media', status: 'em_analise',
        title: 'Entrega adiada por acesso cortado', tracking_code: null,
        opened_at: '2026-08-08T14:00:00.000Z', due_at: '2026-08-10T14:00:00.000Z', overdue: false,
      },
    ];
  },
};
