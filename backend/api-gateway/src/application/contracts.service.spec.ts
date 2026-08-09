/**
 * @file contracts.service.spec.ts
 * @description Testes unitários do núcleo dos contratos de cliente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.35
 *
 * Prova, sem base de dados, a parte que decide dinheiro: que contrato vale numa
 * data, sobre o que incide o desconto, quando o piso morde, e quando o limite de
 * crédito trava. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { ContractFactory } from '../../../../tests/harness';

const {
  coversDate, periodsOverlap, resolveContract, zoneRateFor,
  applyContractToQuote, dueDateFrom, assessCredit,
  normalizeContract, normalizeZoneRates, ContractStatus,
  ContractValidationError,
} = require('./contracts.service');

describe('Contratos · vigência', () => {
  const contrato = ContractFactory.build({ starts_on: '2026-03-01', ends_on: '2026-12-31' });

  it('should cover the first and the last day', () => {
    // `ends_on` inclusivo: é como se lê um contrato em papel. O contrário
    // produzia uma discussão com o cliente no último dia de cada ano.
    expect(coversDate(contrato, '2026-03-01')).toBe(true);
    expect(coversDate(contrato, '2026-12-31')).toBe(true);
  });

  it('should not cover a day outside the window', () => {
    expect(coversDate(contrato, '2026-02-28')).toBe(false);
    expect(coversDate(contrato, '2027-01-01')).toBe(false);
  });

  it('should treat a contract without an end date as open-ended', () => {
    const aberto = ContractFactory.build({ starts_on: '2026-01-01', ends_on: null });
    expect(coversDate(aberto, '2099-06-15')).toBe(true);
  });

  it('should ignore a time component on the date', () => {
    // As datas chegam da base como YYYY-MM-DD, mas um chamador pode passar um
    // ISO completo; comparar strings inteiras dava falso fora de horas.
    expect(coversDate(contrato, '2026-06-15T23:59:59.000Z')).toBe(true);
  });
});

describe('Contratos · sobreposição', () => {
  it('should detect two windows that share a day', () => {
    const a = ContractFactory.build({ starts_on: '2026-01-01', ends_on: '2026-06-30' });
    const b = ContractFactory.build({ starts_on: '2026-06-30', ends_on: '2026-12-31' });
    expect(periodsOverlap(a, b)).toBe(true);
  });

  it('should accept windows that merely touch without sharing a day', () => {
    const a = ContractFactory.build({ starts_on: '2026-01-01', ends_on: '2026-06-30' });
    const b = ContractFactory.build({ starts_on: '2026-07-01', ends_on: '2026-12-31' });
    expect(periodsOverlap(a, b)).toBe(false);
  });

  it('should treat an open-ended contract as overlapping everything after it', () => {
    const aberto = ContractFactory.build({ starts_on: '2026-01-01', ends_on: null });
    const depois = ContractFactory.build({ starts_on: '2030-01-01', ends_on: null });
    expect(periodsOverlap(aberto, depois)).toBe(true);
  });
});

describe('Contratos · resolução por data', () => {
  it('should ignore drafts and suspended contracts', () => {
    // Um rascunho ainda não foi acordado e um suspenso foi cortado de propósito.
    // Aplicar qualquer deles é faturar por uma condição que ninguém assinou.
    const contratos = [
      ContractFactory.build({ status: 'draft' }),
      ContractFactory.build({ status: 'suspended' }),
      ContractFactory.build({ status: 'ended' }),
    ];
    expect(resolveContract(contratos, '2026-06-01')).toBeNull();
  });

  it('should return null when nothing covers the date — public table applies', () => {
    const contratos = [ContractFactory.build({ starts_on: '2027-01-01', ends_on: null })];
    expect(resolveContract(contratos, '2026-06-01')).toBeNull();
  });

  it('should pick the most recently agreed one when data was migrated with overlaps', () => {
    // A escrita impede sobreposições, mas dados carregados à mão podem tê-las.
    // Escolher deterministicamente é o que garante que "porque saiu a este
    // preço" continua a ter resposta.
    const antigo = ContractFactory.build({ code: 'CT/ANTIGO', starts_on: '2026-01-01', ends_on: null });
    const novo   = ContractFactory.build({ code: 'CT/NOVO',   starts_on: '2026-06-01', ends_on: null });
    expect(resolveContract([antigo, novo], '2026-09-01').code).toBe('CT/NOVO');
  });

  it('should survive an empty or missing list', () => {
    expect(resolveContract([], '2026-06-01')).toBeNull();
    expect(resolveContract(undefined as unknown as [], '2026-06-01')).toBeNull();
  });
});

describe('Contratos · tarifa negociada por zona', () => {
  const contrato = ContractFactory.withNegotiatedZone('MAPUTO_CITY');

  it('should find the negotiated rate regardless of case', () => {
    expect(zoneRateFor(contrato, 'maputo_city')?.base_cents).toBe(10_000);
  });

  it('should return null for a zone without a negotiated rate', () => {
    expect(zoneRateFor(contrato, 'NORTE')).toBeNull();
  });

  it('should return null when there is no contract at all', () => {
    expect(zoneRateFor(null, 'MAPUTO_CITY')).toBeNull();
  });
});

describe('Contratos · aplicação ao orçamento', () => {
  it('should leave the quote untouched when there is no contract', () => {
    const orcamento = ContractFactory.quote();
    const resultado = applyContractToQuote(orcamento, null);

    expect(resultado.total_cents).toBe(orcamento.total_cents);
    expect(resultado.contract_code).toBeNull();
    expect(resultado.contract_discount_cents).toBe(0);
  });

  it('should discount the freight but NOT the COD surcharge', () => {
    // A sobretaxa de COD é um custo que se repassa. Descontá-la seria oferecer
    // dinheiro que sai da empresa à mesma.
    const orcamento = ContractFactory.quote();         // frete 30.000 + COD 2.000
    const contrato  = ContractFactory.build({ discount_pct: 10 });
    const resultado = applyContractToQuote(orcamento, contrato);

    expect(resultado.contract_discount_cents).toBe(3_000);
    expect(resultado.total_cents).toBe(27_000 + 2_000);
  });

  it('should raise the freight to the minimum charge after the discount', () => {
    // O piso existe precisamente para o caso do desconto grande: sem ele, o
    // frete fica abaixo do que custa fazer a entrega.
    const orcamento = ContractFactory.quote({
      base_cents: 4_000, weight_cents: 0, service_cents: 0, modal_cents: 0,
      cod_surcharge_cents: 0, total_cents: 4_000,
    });
    const contrato = ContractFactory.build({ discount_pct: 50, minimum_charge_cents: 5_000 });
    const resultado = applyContractToQuote(orcamento, contrato);

    expect(resultado.contract_discount_cents).toBe(2_000);
    expect(resultado.minimum_adjustment_cents).toBe(3_000); // 2.000 → 5.000
    expect(resultado.total_cents).toBe(5_000);
  });

  it('should not charge the minimum when the freight already clears it', () => {
    const contrato = ContractFactory.build({ discount_pct: 10, minimum_charge_cents: 5_000 });
    const resultado = applyContractToQuote(ContractFactory.quote(), contrato);

    expect(resultado.minimum_adjustment_cents).toBe(0);
  });

  it('should name the contract on the breakdown', () => {
    // Um desconto que só aparece no total é indefensável quando o cliente
    // pergunta a conta.
    const contrato = ContractFactory.build({ code: 'CT2026/0007' });
    const resultado = applyContractToQuote(ContractFactory.quote(), contrato);

    expect(resultado.contract_code).toBe('CT2026/0007');
    expect(resultado.contract_id).toBe(contrato.id);
  });

  it('should not mutate the quote it was given', () => {
    const orcamento = ContractFactory.quote();
    applyContractToQuote(orcamento, ContractFactory.build({ discount_pct: 50 }));
    expect(orcamento.total_cents).toBe(32_000);
  });
});

describe('Contratos · prazo de pagamento', () => {
  it('should give no due date for cash on issue', () => {
    // Datar uma fatura-recibo com o próprio dia da emissão faria qualquer mapa
    // de dívida contá-la como vencida na manhã seguinte.
    expect(dueDateFrom('2026-08-09T10:00:00.000Z', 0)).toBeNull();
  });

  it('should add the agreed days', () => {
    expect(dueDateFrom('2026-08-09T10:00:00.000Z', 30)).toBe('2026-09-08');
  });

  it('should cross a month and a year boundary correctly', () => {
    expect(dueDateFrom('2026-12-20T10:00:00.000Z', 30)).toBe('2027-01-19');
  });

  it('should return null for an unparseable date instead of an invalid one', () => {
    expect(dueDateFrom('não é uma data', 30)).toBeNull();
  });
});

describe('Contratos · limite de crédito', () => {
  it('should allow everything when no limit was agreed', () => {
    // 0 significa SEM limite, não "limite zero" — tratá-lo como zero travava
    // todos os clientes no dia em que a funcionalidade entrasse.
    const contrato = ContractFactory.build({ credit_limit_cents: 0 });
    const situacao = assessCredit(contrato, 900_000, 500_000);

    expect(situacao.ok).toBe(true);
    expect(situacao.available_cents).toBeNull();
  });

  it('should allow an order that fits within the limit', () => {
    const contrato = ContractFactory.withCreditLimit(100_000);
    const situacao = assessCredit(contrato, 60_000, 30_000);

    expect(situacao.ok).toBe(true);
    expect(situacao.projected_cents).toBe(90_000);
    expect(situacao.available_cents).toBe(40_000);
  });

  it('should block the order that would cross the limit', () => {
    const contrato = ContractFactory.withCreditLimit(100_000);
    const situacao = assessCredit(contrato, 90_000, 20_000);

    expect(situacao.ok).toBe(false);
    expect(situacao.projected_cents).toBe(110_000);
  });

  it('should allow an order sitting exactly on the limit', () => {
    // O limite é o teto acordado, não uma barreira antes dele. Recusar no valor
    // exato obrigaria o cliente a discutir um cêntimo.
    const situacao = assessCredit(ContractFactory.withCreditLimit(100_000), 100_000, 0);
    expect(situacao.ok).toBe(true);
  });

  it('should not block when there is no contract', () => {
    expect(assessCredit(null, 5_000_000, 100_000).ok).toBe(true);
  });
});

describe('Contratos · validação', () => {
  it('should reject an end date before the start', () => {
    expect(() => normalizeContract(ContractFactory.build({ starts_on: '2026-06-01', ends_on: '2026-01-01' })))
      .toThrow(ContractValidationError);
  });

  it.each([-1, 101])('should reject a discount of %i%%', (pct) => {
    expect(() => normalizeContract(ContractFactory.build({ discount_pct: pct })))
      .toThrow(ContractValidationError);
  });

  it('should reject an unknown status', () => {
    expect(() => normalizeContract(ContractFactory.build({ status: 'aprovado' as never })))
      .toThrow(ContractValidationError);
  });

  it('should default a new contract to draft', () => {
    const dados = normalizeContract({ client_ref_id: 'c1', code: 'CT/1', starts_on: '2026-01-01' });
    expect(dados.status).toBe(ContractStatus.DRAFT);
  });

  it('should reject the same zone twice in the negotiated rates', () => {
    // Duas linhas para a mesma zona fariam o preço depender da ordem do array.
    expect(() => normalizeZoneRates([
      { zone_code: 'SUL', base_cents: 100 },
      { zone_code: 'sul', per_kg_cents: 50 },
    ])).toThrow(ContractValidationError);
  });

  it('should reject a negotiated zone with nothing agreed on it', () => {
    // Uma zona listada sem valores é ruído que depois parece uma tarifa a zero.
    expect(() => normalizeZoneRates([{ zone_code: 'SUL' }])).toThrow(ContractValidationError);
  });

  it('should accept a partial negotiated rate — only the base price', () => {
    const rates = normalizeZoneRates([{ zone_code: 'sul', base_cents: 12_000 }]);
    expect(rates).toEqual([{ zone_code: 'SUL', base_cents: 12_000 }]);
  });
});
