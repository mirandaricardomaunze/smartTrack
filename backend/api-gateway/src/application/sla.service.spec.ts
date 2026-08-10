/**
 * @file sla.service.spec.ts
 * @description Testes unitários da avaliação de SLA.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.42
 *
 * A avaliação é pura e é o que decide se a empresa cumpriu o que prometeu. Com
 * um instante de referência fixo, porque um SLA que depende de quando o teste
 * corre não se pode afirmar de todo. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { SlaFactory, SLA_NOW } from '../../../../tests/harness';

const { targetHours, evaluateSla, summarizeSla, SlaOutcome } = require('./sla.service');

describe('SLA · prazo prometido', () => {
  it('should take the express target for an express order', () => {
    expect(targetHours({ service: 'express' }, SlaFactory.zone())).toBe(24);
    expect(targetHours({ service: 'normal' }, SlaFactory.zone())).toBe(48);
  });

  it('should give null when the zone has no agreed target', () => {
    // `null` não é zero: zero significaria "entregar imediatamente" e poria tudo
    // em incumprimento.
    expect(targetHours({ service: 'normal' }, SlaFactory.zoneWithoutSla())).toBeNull();
  });

  it('should give null without a zone at all', () => {
    expect(targetHours({ service: 'normal' }, null)).toBeNull();
  });

  it('should treat a zero or negative target as no target', () => {
    expect(targetHours({ service: 'normal' }, SlaFactory.zone({ sla_hours_normal: 0 }))).toBeNull();
    expect(targetHours({ service: 'normal' }, SlaFactory.zone({ sla_hours_normal: -5 }))).toBeNull();
  });
});

describe('SLA · avaliação de uma encomenda', () => {
  const zona = SlaFactory.zone();

  it('should count a delivery inside the window as met', () => {
    const r = evaluateSla(SlaFactory.deliveredOnTime(), zona, SLA_NOW);

    expect(r.outcome).toBe(SlaOutcome.ON_TIME);
    expect(r.elapsed_hours).toBe(24);
    expect(r.over_by_hours).toBe(0);
  });

  it('should count a late delivery as breached, saying by how much', () => {
    const r = evaluateSla(SlaFactory.deliveredLate(), zona, SLA_NOW);

    expect(r.outcome).toBe(SlaOutcome.BREACHED);
    expect(r.elapsed_hours).toBe(72);
    expect(r.over_by_hours).toBe(24);
  });

  it('should breach an order that is still moving and already past the window', () => {
    // É a diferença entre um mapa de SLA e um relatório de autópsia: está
    // incumprida AGORA, não quando chegar.
    const r = evaluateSla(SlaFactory.inTransitAlreadyLate(), zona, SLA_NOW);

    expect(r.outcome).toBe(SlaOutcome.BREACHED);
    expect(r.over_by_hours).toBeGreaterThan(0);
  });

  it('should leave an order still inside the window undecided', () => {
    // Contá-la como cumprida inflacionaria o indicador com encomendas que ainda
    // podem falhar.
    expect(evaluateSla(SlaFactory.inTransitOnTime(), zona, SLA_NOW).outcome).toBe(SlaOutcome.RUNNING);
  });

  it('should not judge a zone without an agreed target', () => {
    const r = evaluateSla(SlaFactory.deliveredLate(), SlaFactory.zoneWithoutSla(), SLA_NOW);
    expect(r.outcome).toBe(SlaOutcome.NO_TARGET);
  });

  it('should not judge a returned or cancelled order', () => {
    // Uma devolvida é outra história; contá-la como incumprimento de entrega
    // misturaria dois problemas com respostas diferentes.
    for (const status of ['returned', 'cancelled']) {
      const encomenda = { ...SlaFactory.deliveredLate(), current_status: status };
      expect(evaluateSla(encomenda, zona, SLA_NOW).outcome).toBe(SlaOutcome.NO_TARGET);
    }
  });

  it('should not crash on an unusable creation date', () => {
    const encomenda = { ...SlaFactory.deliveredOnTime(), created_at: 'não é data' };
    expect(evaluateSla(encomenda, zona, SLA_NOW).outcome).toBe(SlaOutcome.NO_TARGET);
  });
});

describe('SLA · resumo', () => {
  const zona = SlaFactory.zone();
  const avaliar = (o: unknown) => evaluateSla(o, zona, SLA_NOW);

  it('should compute compliance over what already has an answer', () => {
    // Incluir as que ainda estão dentro do prazo daria uma taxa que baixa
    // sozinha à medida que o dia passa, sem nada ter acontecido.
    const r = summarizeSla([
      avaliar(SlaFactory.deliveredOnTime()),
      avaliar(SlaFactory.deliveredOnTime()),
      avaliar(SlaFactory.deliveredOnTime()),
      avaliar(SlaFactory.deliveredLate()),
      avaliar(SlaFactory.inTransitOnTime()),
    ]);

    expect(r.measured).toBe(4);
    expect(r.compliance_pct).toBe(75);
    expect(r.em_curso).toBe(1);
  });

  it('should say how many were left out for lack of an agreed target', () => {
    // Uma taxa de 100% sobre três encomendas de trinta não é uma taxa de 100%.
    const r = summarizeSla([
      avaliar(SlaFactory.deliveredOnTime()),
      evaluateSla(SlaFactory.deliveredLate(), SlaFactory.zoneWithoutSla(), SLA_NOW),
    ]);

    expect(r.compliance_pct).toBe(100);
    expect(r.sem_prazo_acordado).toBe(1);
    expect(r.measured).toBe(1);
  });

  it('should give null compliance when nothing has been decided yet', () => {
    const r = summarizeSla([avaliar(SlaFactory.inTransitOnTime())]);
    expect(r.compliance_pct).toBeNull();
  });

  it('should survive an empty or missing list', () => {
    expect(summarizeSla([]).total).toBe(0);
    expect(summarizeSla(undefined as unknown as []).compliance_pct).toBeNull();
  });
});
