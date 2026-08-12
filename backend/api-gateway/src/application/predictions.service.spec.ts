/**
 * @file predictions.service.spec.ts
 * @description Testes da previsão do tempo de entrega.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.46
 *
 * Uma previsão errada não dá erro: dá um número. E o número vai ser lido por um
 * cliente que decide com ele. Estes testes protegem sobretudo as recusas — os
 * casos em que a resposta certa é "não sei".
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { PredictionFactory } from '../../../../tests/harness';

const require = createRequire(import.meta.url);
const {
  durationHours, percentile, summarize, predict, compareToPromise, segmentKey, MIN_SAMPLE,
} = require('./predictions.service.js');

/** Constrói os índices que `predict` consome a partir de uma lista de entregas. */
function indexar(entregas: any[]) {
  const porSegmento = new Map<string, number[]>();
  const porZona = new Map<string, number[]>();

  for (const e of entregas) {
    const h = durationHours(e);
    if (h === null) continue;
    const zona = e.zone ?? e.city ?? null;
    const chave = segmentKey(zona, e.service_level);

    if (!porSegmento.has(chave)) porSegmento.set(chave, []);
    porSegmento.get(chave)!.push(h);

    const zk = zona ?? 'sem-zona';
    if (!porZona.has(zk)) porZona.set(zk, []);
    porZona.get(zk)!.push(h);
  }
  return { porSegmento, porZona };
}

describe('Previsão · duração medida', () => {
  it('should measure from registration to delivery', () => {
    // É a espera que o cliente vive. Medir da recolha daria um número melhor e
    // responderia a outra pergunta.
    expect(durationHours(PredictionFactory.delivery(18))).toBe(18);
  });

  it('should refuse a delivery that happened before the order existed', () => {
    // Relógio trocado, não entrega instantânea.
    const [relogioTrocado] = PredictionFactory.invalidas();
    expect(durationHours(relogioTrocado)).toBe(null);
  });

  it('should refuse a duration too long to be a delivery', () => {
    // Mais de 90 dias é um registo esquecido. Não é apagado — é excluído de ser
    // medido.
    const [, esquecida] = PredictionFactory.invalidas();
    expect(durationHours(esquecida)).toBe(null);
  });

  it('should refuse an order that never got a delivery timestamp', () => {
    const [, , semData] = PredictionFactory.invalidas();
    expect(durationHours(semData)).toBe(null);
  });
});

describe('Previsão · percentis', () => {
  it('should interpolate between the two surrounding values', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
  });

  it('should return the single value it has', () => {
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('should have nothing to say about an empty sample', () => {
    expect(percentile([], 0.5)).toBe(null);
  });
});

describe('Previsão · amostra', () => {
  it('should predict once there are enough measured deliveries', () => {
    const resumo = summarize(PredictionFactory.amostraSuficiente().map(durationHours));

    expect(resumo.enough).toBe(true);
    expect(resumo.sample_size).toBe(24);
    expect(resumo.p50_hours).toBe(21.5);
    expect(resumo.p90_hours).toBeGreaterThan(resumo.p50_hours!);
  });

  it('should refuse to predict from a handful of deliveries', () => {
    // Responder "24 horas" a partir de cinco entregas é inventar com o aspeto de
    // quem mediu.
    const resumo = summarize(PredictionFactory.amostraCurta().map(durationHours));

    expect(resumo.enough).toBe(false);
    expect(resumo.p50_hours).toBe(null);
    expect(resumo.p90_hours).toBe(null);
    expect(resumo.sample_size).toBe(5);
  });

  it('should not let one forgotten parcel move the prediction', () => {
    // O caso que separa mediana de média. A mediana desloca-se meia hora — o
    // que se desloca por haver mais um valor na lista, não por ele ser absurdo.
    const normal = summarize(PredictionFactory.amostraSuficiente().map(durationHours));
    const comDisparate = summarize(PredictionFactory.comEsquecida().map(durationHours));

    expect(Math.abs(comDisparate.p50_hours! - normal.p50_hours!)).toBeLessThanOrEqual(1);
    expect(comDisparate.sample_size).toBe(normal.sample_size + 1);

    // A comparação que justifica a escolha: a média quase duplica com a mesma
    // encomenda — 21,5 h passam a 40,8 h — e daria isso a toda a gente como
    // previsão.
    const media = (l: number[]) => l.reduce((s, h) => s + h, 0) / l.length;
    const semDisparate = media(PredictionFactory.amostraSuficiente().map(durationHours) as number[]);
    const comEla = media(PredictionFactory.comEsquecida().map(durationHours) as number[]);

    expect(comEla).toBeGreaterThan(semDisparate * 1.8);
    expect(comEla - comDisparate.p50_hours!).toBeGreaterThan(15);
  });

  it('should require the stated minimum, not a number invented here', () => {
    expect(MIN_SAMPLE).toBe(20);
    expect(summarize(new Array(MIN_SAMPLE).fill(12)).enough).toBe(true);
    expect(summarize(new Array(MIN_SAMPLE - 1).fill(12)).enough).toBe(false);
  });
});

describe('Previsão · escada de recurso', () => {
  it('should use the exact segment when it has a sample of its own', () => {
    const { porSegmento, porZona } = indexar(PredictionFactory.amostraSuficiente());
    const p = predict(porSegmento, porZona, 'Maputo Cidade', 'normal');

    expect(p.basis).toBe('segment');
    expect(p.enough).toBe(true);
  });

  it('should fall back to the zone and say so', () => {
    // O número passa a misturar níveis de serviço: quem lê tem de saber, senão
    // toma por expresso o que é a média de tudo.
    const { porSegmento, porZona } = indexar(PredictionFactory.zonaComRecurso());
    const p = predict(porSegmento, porZona, 'Maputo Cidade', 'normal');

    expect(p.basis).toBe('zone');
    expect(p.service_level).toBe(null);
    expect(p.enough).toBe(true);
  });

  it('should keep saying which question a fallback row answers', () => {
    // Apareceu numa base de demonstração: expresso e normal da mesma zona caíam
    // ambos no recurso e produziam duas linhas visualmente idênticas — mesma
    // zona, mesmos percentis, "todos" no nível de serviço — a dizer coisas
    // diferentes sobre o prazo, porque cada uma é confrontada com a promessa do
    // seu nível. Não havia como saber qual era qual.
    const { porSegmento, porZona } = indexar(PredictionFactory.zonaComRecursoNosDois());
    const normal = predict(porSegmento, porZona, 'Maputo Cidade', 'normal');
    const expresso = predict(porSegmento, porZona, 'Maputo Cidade', 'express');

    expect(normal.basis).toBe('zone');
    expect(expresso.basis).toBe('zone');
    expect(normal.for_service_level).toBe('normal');
    expect(expresso.for_service_level).toBe('express');
    // Os números são mesmo os mesmos — é essa a natureza do recurso. O que não
    // pode acontecer é as linhas serem indistinguíveis.
    expect(normal.p50_hours).toBe(expresso.p50_hours);
  });

  it('should stop at "I do not know" instead of using a company average', () => {
    // Aplicar a Nampula o que se mediu em Maputo é uma afirmação confiante sobre
    // uma rota que ninguém percorreu.
    const { porSegmento, porZona } = indexar(PredictionFactory.amostraSuficiente());
    const p = predict(porSegmento, porZona, 'Nampula', 'normal');

    expect(p.basis).toBe(null);
    expect(p.enough).toBe(false);
    expect(p.p50_hours).toBe(null);
  });

  it('should say how far the sample is from being usable', () => {
    // "Sem base" sem número deixa quem lê sem saber se falta uma entrega ou mil.
    const { porSegmento, porZona } = indexar(PredictionFactory.amostraCurta());
    const p = predict(porSegmento, porZona, 'Maputo Cidade', 'normal');

    expect(p.reason).toContain('5 de 20');
  });
});

describe('Previsão · confronto com o prometido', () => {
  const previsao = { p90_hours: 38 };

  it('should name a promise the operation does not keep', () => {
    // A saída mais valiosa deste módulo: informa uma decisão de gestão, não um
    // cliente.
    const c = compareToPromise(previsao, 24);

    expect(c.comparable).toBe(true);
    expect(c.keeps_promise).toBe(false);
    expect(c.gap_hours).toBe(14);
  });

  it('should confirm a promise the measurement supports', () => {
    expect(compareToPromise(previsao, 48).keeps_promise).toBe(true);
  });

  it('should not judge a zone that promised nothing', () => {
    // Uma zona sem prazo acordado não incumpre nada (§ 3.42).
    const c = compareToPromise(previsao, null);

    expect(c.comparable).toBe(false);
    expect(c.keeps_promise).toBe(null);
  });

  it('should not compare against a prediction that does not exist', () => {
    expect(compareToPromise({ p90_hours: null }, 24).comparable).toBe(false);
  });
});

describe('Previsão · segmentação', () => {
  it('should not segment by driver', () => {
    // Uma previsão que muda com o nome de quem entrega vira uma avaliação da
    // pessoa, feita com uma amostra que nunca foi recolhida para isso (§ 3.43).
    expect(segmentKey('Maputo Cidade', 'normal')).toBe('Maputo Cidade::normal');
    expect(segmentKey('Maputo Cidade', 'normal')).not.toContain('driver');
  });

  it('should treat a missing service level as normal', () => {
    expect(segmentKey('Beira', undefined)).toBe('Beira::normal');
  });
});
