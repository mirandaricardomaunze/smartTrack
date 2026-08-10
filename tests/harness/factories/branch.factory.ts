/**
 * @file branch.factory.ts
 * @description Factory do âmbito de filial.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 *
 * As filiais são armazéns (§ 3.45): não há entidade nova. Os cenários abaixo são
 * os que separam uma lente correta de uma que parece correta — a encomenda em
 * trânsito entre bases, e a encomenda sem origem registada.
 */

/** Filiais reais da operação — que são armazéns. */
export const BRANCHES = {
  maputo: 'wh-maputo',
  beira: 'wh-beira',
  nampula: 'wh-nampula',
} as const;

/** O mínimo que a decisão de visibilidade consome de uma encomenda. */
export interface TestScopedOrder {
  id: string;
  /** Filial por onde entrou. Nunca muda. */
  branch_id: string | null;
  /** Onde a mercadoria está agora. Muda com as transferências (§ 3.36). */
  warehouse_id: string | null;
  label: string;
}

let contador = 1;

export const BranchFactory = {
  /** Um utilizador restrito a uma base. */
  restrictedTo(...branches: string[]): string[] {
    return branches;
  },

  /** Sem atribuição — vê a empresa inteira (§ 3.45). */
  unrestricted(): string[] {
    return [];
  },

  order(over: Partial<TestScopedOrder> = {}): TestScopedOrder {
    return {
      id: `ord-branch-${contador++}`,
      branch_id: BRANCHES.maputo,
      warehouse_id: BRANCHES.maputo,
      label: 'encomenda de Maputo, parada em Maputo',
      ...over,
    };
  },

  /**
   * O conjunto que expõe os erros de desenho, um por linha.
   *
   * Se algum destes falhar, o âmbito está mal: ou esconde trabalho a quem o tem
   * de fazer, ou mostra a operação alheia.
   */
  visibilityCases(): TestScopedOrder[] {
    return [
      this.order({
        branch_id: BRANCHES.beira, warehouse_id: BRANCHES.beira,
        label: 'da Beira, na Beira',
      }),
      this.order({
        branch_id: BRANCHES.maputo, warehouse_id: BRANCHES.beira,
        label: 'de Maputo, em trânsito e já na Beira',
      }),
      this.order({
        branch_id: BRANCHES.beira, warehouse_id: BRANCHES.maputo,
        label: 'da Beira, ainda parada em Maputo',
      }),
      this.order({
        branch_id: BRANCHES.maputo, warehouse_id: BRANCHES.maputo,
        label: 'de Maputo, em Maputo — alheia à Beira',
      }),
      this.order({
        branch_id: null, warehouse_id: null,
        label: 'anterior à migração, sem origem registada',
      }),
      this.order({
        branch_id: null, warehouse_id: BRANCHES.nampula,
        label: 'sem origem, recolhida em Nampula',
      }),
    ];
  },

  /** Totais por filial, com a fatia sem origem que não pode ser omitida. */
  breakdownRows() {
    return [
      { branch_id: BRANCHES.maputo, total: 412, delivered: 380, failed: 12, revenue_cents: 1_240_000_00 },
      { branch_id: BRANCHES.beira, total: 96, delivered: 88, failed: 3, revenue_cents: 310_000_00 },
      { branch_id: 'wh-desativado', total: 4, delivered: 4, failed: 0, revenue_cents: 9_000_00 },
      { branch_id: null, total: 300, delivered: 290, failed: 5, revenue_cents: 700_000_00 },
    ];
  },

  /** Os armazéns que dão nome às filiais do relatório. */
  warehouses() {
    return [
      { id: BRANCHES.maputo, name: 'Maputo — Sede' },
      { id: BRANCHES.beira, name: 'Beira' },
      { id: BRANCHES.nampula, name: 'Nampula' },
    ];
  },
};
