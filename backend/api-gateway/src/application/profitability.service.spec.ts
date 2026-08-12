/**
 * @file profitability.service.spec.ts
 * @description Testes unitários do núcleo da rentabilidade.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.40
 *
 * O que aqui se afirma é a fronteira entre o que é medido e o que não é. Um
 * relatório de margem orienta decisões de preço: se um custo inventado passar
 * por medido, a decisão fica pior do que a que se tomava a olho. Dados via
 * factories.
 */
import { describe, expect, it } from 'vitest';
import { ProfitabilityFactory } from '../../../../tests/harness';

const {
  fuelCostPerKm, routeCost, splitCostPerStop, margin, costCoverage,
} = require('./profitability.service');

describe('Rentabilidade · custo de combustível medido', () => {
  it('should measure the cost per km between two full tanks', () => {
    // 400 km entre os dois registos, 20.000 no segundo abastecimento = 50/km.
    const r = fuelCostPerKm(ProfitabilityFactory.fuelFills());

    expect(r.fuel_cents_per_km).toBe(50);
    expect(r.source).toBe('measured');
    expect(r.km_measured).toBe(400);
  });

  it('should not count the first fill — it filled a tank nobody measured', () => {
    // Contar os 8.000 do primeiro daria 70/km em vez de 50: o combustível
    // percorreu quilómetros que ninguém registou.
    const r = fuelCostPerKm(ProfitabilityFactory.fuelFills());
    expect(r.fuel_cents_per_km).not.toBe(70);
  });

  it('should report unknown with a single fill, instead of guessing', () => {
    const r = fuelCostPerKm(ProfitabilityFactory.singleFill());

    expect(r.fuel_cents_per_km).toBeNull();
    expect(r.source).toBe('unknown');
  });

  it('should report unknown with no fills at all', () => {
    expect(fuelCostPerKm([]).source).toBe('unknown');
    expect(fuelCostPerKm(undefined as unknown as []).source).toBe('unknown');
  });

  it('should ignore an odometer that went backwards', () => {
    // É erro de digitação; um intervalo negativo produziria um custo negativo
    // que envenena a média de todas as viaturas.
    const r = fuelCostPerKm(ProfitabilityFactory.fillsWithBadOdometer());
    expect(r.fuel_cents_per_km).toBeNull();
  });

  it('should ignore partial fills — the tank level is unknown', () => {
    const parciais = ProfitabilityFactory.fuelFills().map((f) => ({ ...f, full_tank: false }));
    expect(fuelCostPerKm(parciais).source).toBe('unknown');
  });
});

describe('Rentabilidade · custo da rota', () => {
  const viaturaMedida = ProfitabilityFactory.vehicleCost({ fuel_cents_per_km: 50 });
  const viaturaSemDados = ProfitabilityFactory.vehicleCost({ fuel_cents_per_km: null, source: 'unknown' });

  it('should charge only the fuel when nothing else is configured', () => {
    const c = routeCost(ProfitabilityFactory.route(), viaturaMedida, ProfitabilityFactory.emptyCostModel());

    expect(c.fuel_cents).toBe(100 * 50);
    expect(c.upkeep_cents).toBe(0);
    expect(c.driver_cents).toBe(0);
    expect(c.total_cents).toBe(5_000);
  });

  it('should add the configured parts once they exist', () => {
    const c = routeCost(ProfitabilityFactory.route(), viaturaMedida, ProfitabilityFactory.configuredCostModel());

    expect(c.upkeep_cents).toBe(100 * 20);
    expect(c.driver_cents).toBe(50_000);
    expect(c.total_cents).toBe(5_000 + 2_000 + 50_000);
  });

  it('should count zero for unknown fuel and say so, instead of estimating', () => {
    // Estimá-lo daria uma margem que parece completa e não é.
    const c = routeCost(ProfitabilityFactory.route(), viaturaSemDados, ProfitabilityFactory.configuredCostModel());

    expect(c.fuel_cents).toBe(0);
    expect(c.fuel_known).toBe(false);
    expect(c.total_cents).toBe(2_000 + 50_000);
  });

  it('should handle a route with no distance recorded', () => {
    const c = routeCost({ distance_km: 0, stops: [] }, viaturaMedida, ProfitabilityFactory.configuredCostModel());
    expect(c.fuel_cents).toBe(0);
    expect(c.driver_cents).toBe(50_000);
  });
});

describe('Rentabilidade · repartição pelas paradas', () => {
  it('should split evenly across the stops', () => {
    expect(splitCostPerStop(1_000, 4)).toEqual([250, 250, 250, 250]);
  });

  it('should make the parts add up exactly to the total', () => {
    // Sem isto, o relatório por cliente e o por rota davam totais diferentes e
    // ninguém saberia qual acreditar.
    const partes = splitCostPerStop(1_001, 3);
    expect(partes.reduce((a, b) => a + b, 0)).toBe(1_001);
  });

  it('should give nothing to split when there are no stops', () => {
    expect(splitCostPerStop(1_000, 0)).toEqual([]);
  });

  it('should never produce a negative share', () => {
    expect(splitCostPerStop(-500, 2)).toEqual([0, 0]);
  });
});

describe('Rentabilidade · margem', () => {
  it('should compute profit and percentage', () => {
    const m = margin(10_000, 4_000);

    expect(m.profit_cents).toBe(6_000);
    expect(m.margin_pct).toBe(60);
  });

  it('should report a negative margin as negative, not as zero', () => {
    // Uma entrega que dá prejuízo é a informação mais valiosa do relatório.
    const m = margin(3_000, 5_000);

    expect(m.profit_cents).toBe(-2_000);
    expect(m.margin_pct).toBeLessThan(0);
  });

  it('should give null percentage without revenue, instead of Infinity', () => {
    // `Infinity` num ecrã aparece como um número absurdo.
    expect(margin(0, 500).margin_pct).toBeNull();
  });

  it('should carry the flag that says the cost is incomplete', () => {
    // Sem ela, uma margem de 100% por falta de dados é indistinguível de uma
    // margem de 100% real.
    expect(margin(10_000, 0, false).cost_known).toBe(false);
  });

  it('should refuse to state a margin when no cost at all was measured', () => {
    // Apareceu numa base de demonstração: seis clientes, todos a 100% de margem,
    // porque nenhuma encomenda tinha rota e portanto não havia custo nenhum.
    // 100% ali não é uma margem — é aritmética sobre o vazio, e a bandeira de
    // custo incompleto não chega para desfazer a impressão que o número deixa.
    expect(margin(10_000, 0, false).margin_pct).toBeNull();
    expect(margin(10_000, 0, false).profit_cents).toBe(10_000);
  });

  it('should still state a margin when part of the cost is known', () => {
    // O caso que continua a valer a pena mostrar: a margem está sobreavaliada,
    // e o asterisco diz porquê. Deixar de a mostrar aqui perderia informação
    // útil em vez de evitar uma impressão errada.
    expect(margin(10_000, 4_000, false).margin_pct).toBe(60);
  });

  it('should state a zero cost that was actually measured', () => {
    // Custo medido e igual a zero é um facto, não uma ausência.
    expect(margin(10_000, 0, true).margin_pct).toBe(100);
  });
});

describe('Rentabilidade · cobertura declarada', () => {
  it('should name what was left out of the margin', () => {
    const c = costCoverage({ measured: 2, total: 3 }, ProfitabilityFactory.emptyCostModel());

    expect(c.excluded).toContain('manutenção e desgaste');
    expect(c.excluded).toContain('custo de motorista');
    expect(c.caveat).toMatch(/^Margem ANTES de:/);
  });

  it('should stop naming a part once it is configured', () => {
    const c = costCoverage({ measured: 3, total: 3 }, ProfitabilityFactory.configuredCostModel());

    expect(c.excluded).not.toContain('manutenção e desgaste');
    expect(c.upkeep_cents_per_km.source).toBe('configured');
  });

  it('should always name what the system cannot compute at all', () => {
    // Salários rateados e amortização não são configuráveis aqui — o relatório
    // é sempre "antes" deles, e tem de o dizer mesmo com tudo o resto preenchido.
    const c = costCoverage({ measured: 3, total: 3 }, ProfitabilityFactory.configuredCostModel());
    expect(c.excluded.join(' ')).toMatch(/salários rateados/);
  });

  it('should flag vehicles without measured fuel', () => {
    const c = costCoverage({ measured: 1, total: 4 }, ProfitabilityFactory.configuredCostModel());

    expect(c.fuel.vehicles_with_data).toBe(1);
    expect(c.excluded.join(' ')).toMatch(/combustível de algumas viaturas/);
  });
});
