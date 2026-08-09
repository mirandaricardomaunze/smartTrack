/**
 * @file branches.service.spec.ts
 * @description Testes do âmbito de filial.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.45
 *
 * Um âmbito mal desenhado falha de duas maneiras, ambas silenciosas: esconde
 * trabalho a quem o tem de fazer, ou mostra a operação alheia. Nenhuma delas dá
 * erro — descobrem-se quando alguém pergunta por uma encomenda que não aparece.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { BranchFactory, BRANCHES } from '../../../../tests/harness';

const require = createRequire(import.meta.url);
const {
  isRestricted, canSeeOrder, orderScopeClause, resourceScopeClause, labelBranchRows,
} = require('./branches.service.js');

describe('Filial · restrição', () => {
  it('should treat a user with no branches as seeing everything', () => {
    // Ao contrário do que a intuição sugere, e é deliberado: no dia da migração
    // ninguém tem filiais atribuídas, e exigir atribuição trancaria toda a gente
    // fora do sistema de uma só vez.
    expect(isRestricted(BranchFactory.unrestricted())).toBe(false);
    expect(isRestricted(null)).toBe(false);
    expect(isRestricted(undefined)).toBe(false);
  });

  it('should treat a user with at least one branch as restricted', () => {
    expect(isRestricted(BranchFactory.restrictedTo(BRANCHES.beira))).toBe(true);
  });
});

describe('Filial · visibilidade de uma encomenda', () => {
  const beira = BranchFactory.restrictedTo(BRANCHES.beira);
  const casos = BranchFactory.visibilityCases();
  const caso = (label: string) => casos.find((c) => c.label.includes(label))!;

  it('should show an order that both started and sits in the branch', () => {
    expect(canSeeOrder(caso('da Beira, na Beira'), beira)).toBe(true);
  });

  it('should show an inbound transfer that started elsewhere', () => {
    // Sem isto, a transferência a caminho seria invisível precisamente à base
    // que a tem de conferir e receber (§ 3.36).
    expect(canSeeOrder(caso('em trânsito e já na Beira'), beira)).toBe(true);
  });

  it('should keep showing an order of the branch that is still elsewhere', () => {
    // A receita e a responsabilidade são da Beira mesmo enquanto a mercadoria
    // está noutro lado.
    expect(canSeeOrder(caso('ainda parada em Maputo'), beira)).toBe(true);
  });

  it('should hide an order that has nothing to do with the branch', () => {
    expect(canSeeOrder(caso('alheia à Beira'), beira)).toBe(false);
  });

  it('should never hide an order that has no branch recorded', () => {
    // As anteriores à migração não têm origem registada. Desaparecerem de vista
    // seria pior do que serem vistas a mais.
    expect(canSeeOrder(caso('sem origem registada'), beira)).toBe(true);
  });

  it('should hide an order with no origin that sits in another branch', () => {
    // Aqui já se sabe onde está, e não é na Beira: `NULL` só abre a porta quando
    // não há informação nenhuma.
    expect(canSeeOrder(caso('recolhida em Nampula'), beira)).toBe(false);
  });

  it('should show everything to an unrestricted user', () => {
    for (const c of casos) {
      expect(canSeeOrder(c, BranchFactory.unrestricted())).toBe(true);
    }
  });

  it('should cover more than one branch for a regional manager', () => {
    // Uma coluna única na ficha do utilizador obrigaria esta pessoa a ter duas
    // contas.
    const regional = BranchFactory.restrictedTo(BRANCHES.beira, BRANCHES.nampula);
    expect(canSeeOrder(caso('recolhida em Nampula'), regional)).toBe(true);
    expect(canSeeOrder(caso('alheia à Beira'), regional)).toBe(false);
  });
});

describe('Filial · cláusula SQL', () => {
  it('should add nothing for an unrestricted user', () => {
    const params: unknown[] = [];
    expect(orderScopeClause(null, params)).toBe('');
    expect(params).toHaveLength(0);
  });

  it('should filter in SQL and not after paging', () => {
    // A lista é paginada (§ 3.1): filtrar depois de paginar devolveria páginas
    // com menos linhas do que o pedido e uma contagem que não bate certo.
    const params: unknown[] = ['company-1'];
    const sql = orderScopeClause([BRANCHES.beira], params);

    expect(sql).toContain('branch_id = ANY($2)');
    expect(sql).toContain('warehouse_id = ANY($2)');
    expect(params[1]).toEqual([BRANCHES.beira]);
  });

  it('should let a row with neither column through', () => {
    const sql = orderScopeClause([BRANCHES.beira], []);
    expect(sql).toContain('branch_id IS NULL AND warehouse_id IS NULL');
  });

  it('should qualify the columns when the query uses an alias', () => {
    // Sem o prefixo, um JOIN com duas tabelas que tenham `branch_id` rebenta com
    // "column reference is ambiguous".
    expect(orderScopeClause([BRANCHES.beira], [], 'o')).toContain('o.branch_id');
  });

  it('should scope people and vehicles by their home base only', () => {
    // Um motorista não está "em trânsito entre filiais": tem uma base. A
    // pergunta é outra, e a cláusula também.
    const params: unknown[] = [];
    const sql = resourceScopeClause([BRANCHES.beira], params);

    expect(sql).toContain('branch_id = ANY($1)');
    expect(sql).toContain('branch_id IS NULL');
    expect(sql).not.toContain('warehouse_id');
  });
});

describe('Filial · repartição', () => {
  const linhas = labelBranchRows(BranchFactory.breakdownRows(), BranchFactory.warehouses());

  it('should name each branch after its warehouse', () => {
    expect(linhas[0].branch_name).toBe('Maputo — Sede');
  });

  it('should not drop the orders with no branch', () => {
    // Se 300 encomendas desaparecessem, a soma das filiais não bateria com o
    // total da empresa e quem lê ficaria a achar que perdeu encomendas.
    const semFilial = linhas.find((l: any) => l.branch_id === null);

    expect(semFilial.branch_name).toBe('Sem filial atribuída');
    expect(semFilial.total).toBe(300);
    expect(linhas.reduce((s: number, l: any) => s + l.total, 0)).toBe(812);
  });

  it('should say plainly when a branch no longer exists', () => {
    // Um id cru na coluna faria alguém procurar por um armazém que já foi
    // desativado.
    expect(linhas.find((l: any) => l.branch_id === 'wh-desativado').branch_name)
      .toBe('Filial removida');
  });
});
