/**
 * @file exports.service.spec.ts
 * @description Testes da montagem das folhas de exportação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.44
 *
 * O que aqui se protege não é o formato do ficheiro (isso é xlsx.spec.ts) mas o
 * conteúdo: valores em meticais, ressalvas que viajam com a folha, e a distinção
 * entre "zero" e "por medir" — que num ficheiro que circula por email sem
 * contexto é a diferença entre informar e enganar.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ExportFactory } from '../../../../tests/harness';

const require = createRequire(import.meta.url);
const {
  mzn, pct, profitabilitySheets, receivablesSheets, driverPerformanceSheets, incidentsSheets,
} = require('./exports.service.js');

describe('Exportação · conversão de valores', () => {
  it('should hand over meticais, not cents', () => {
    // Quem abre a folha soma meticais. Obrigá-lo a dividir por cem devolveria o
    // problema do CSV por outra via.
    expect(mzn(189_500_00)).toBe(189500);
    expect(mzn(1_234_56)).toBe(1234.56);
  });

  it('should treat a missing amount as zero money', () => {
    // Ausência de valor monetário é zero: não há dívida por medir, há dívida.
    expect(mzn(null)).toBe(0);
    expect(mzn(undefined)).toBe(0);
  });

  it('should keep an unmeasured rate empty instead of turning it into zero', () => {
    // Ao contrário do dinheiro: uma taxa a `null` significa "sem amostra", e um
    // 0% seria uma afirmação que ninguém mediu.
    expect(pct(null)).toBe(null);
    expect(pct(undefined)).toBe(null);
    expect(pct(35.99)).toBe(35.99);
  });
});

describe('Exportação · rentabilidade', () => {
  const folhas = profitabilitySheets(ExportFactory.profitability());
  const clientes = folhas.find((f: any) => f.name === 'Clientes');

  it('should split the report into one sheet per dimension', () => {
    // A razão de ser do Excel aqui: seis relatórios num livro, não seis ficheiros.
    expect(folhas.map((f: any) => f.name))
      .toEqual(['Clientes', 'Rotas', 'Viaturas', 'Cobertura de custos']);
  });

  it('should convert every money column to meticais', () => {
    const [nome, encomendas, receita] = clientes.rows[0];
    expect(nome).toBe('Silva & Filhos, Lda');
    expect(encomendas).toBe(42);
    expect(receita).toBe(189500);
  });

  it('should mark the client whose cost is not measured', () => {
    // Sem esta coluna, os 12.400 MZN de lucro do segundo cliente leem-se como
    // lucro real, quando são só receita sem custo apurado.
    expect(clientes.rows[0][6]).toBe('sim');
    expect(clientes.rows[1][6]).toBe('não');
    expect(clientes.rows[1][5]).toBe(null);  // margem por medir, não 0%
  });

  it('should carry the cost caveat inside the file', () => {
    // A folha vai circular sem o painel à volta. A ressalva tem de viajar com ela.
    const cobertura = folhas.find((f: any) => f.name === 'Cobertura de custos');
    const texto = JSON.stringify(cobertura.rows);

    expect(texto).toContain('A margem exclui custos não medidos');
    expect(texto).toContain('1 de 3');                 // viaturas com combustível medido
    expect(texto).toContain('não configurada');        // manutenção por km
    expect(texto).toContain('renda do armazém');       // custo deliberadamente fora
  });

  it('should leave the driver cell empty on an unassigned route', () => {
    const rotas = folhas.find((f: any) => f.name === 'Rotas');
    expect(rotas.rows[1][1]).toBe(null);
  });
});

describe('Exportação · contas a receber', () => {
  const folhas = receivablesSheets(ExportFactory.receivables());
  const carteira = folhas[0];

  it('should give each aging bucket its own column', () => {
    // É o que permite ordenar e filtrar a folha — a razão de a pedirem em Excel.
    expect(carteira.columns.map((c: any) => c.header)).toEqual([
      'Cliente', 'Faturas em aberto', 'Por vencer', '1-30 dias', '31-60 dias',
      '61-90 dias', '+90 dias', 'Sem prazo', 'Saldo (MZN)', 'Mais vencida (dias)',
    ]);
  });

  it('should place the debt in the bucket it belongs to', () => {
    const linha = carteira.rows[0];
    expect(linha[0]).toBe('Transportes Beira & Cia');
    expect(linha[6]).toBe(180000);   // +90 dias
    expect(linha[8]).toBe(245000);   // saldo
    expect(linha[9]).toBe(127);      // dias da mais vencida
  });

  it('should keep a credit balance negative instead of hiding it', () => {
    // Telefonar a cobrar a quem tem crédito a favor é o erro que isto evita.
    expect(carteira.rows[2][8]).toBe(-4000);
  });

  it('should add a totals sheet that closes with the sum of the parts', () => {
    const total = folhas[1];
    const linhas = Object.fromEntries(total.rows.map((r: any) => [r[0], r[1]]));

    expect(linhas.TOTAL).toBe(259500);
    expect(linhas.TOTAL).toBe(carteira.rows.reduce((s: number, r: any) => s + r[8], 0));
  });
});

describe('Exportação · desempenho', () => {
  const folha = driverPerformanceSheets(ExportFactory.driverPerformance())[0];

  it('should export the measured driver with the measured rates', () => {
    expect(folha.rows[0][0]).toBe('João Matola');
    expect(folha.rows[0][4]).toBe(95.11);
    expect(folha.rows[0][8]).toBe(32500);   // COD por acertar, em meticais
  });

  it('should not turn an absent sample into a zero score', () => {
    // Esta folha decide quem fica com as melhores rotas. Um 0% sem base é uma
    // acusação, não uma medição.
    const semAmostra = folha.rows[1];
    expect(semAmostra[4]).toBe(null);
    expect(semAmostra[5]).toBe(null);
    expect(semAmostra[7]).toBe(0);          // a amostra em si é mesmo zero
  });

  it('should not carry a customer rating column', () => {
    // Nunca existiu recolha de avaliação; uma coluna dessas seria inventada.
    expect(JSON.stringify(folha.columns).toLowerCase()).not.toContain('avalia');
  });
});

describe('Exportação · ocorrências', () => {
  const folha = incidentsSheets(ExportFactory.incidents())[0];

  it('should flag the incident that blew its deadline', () => {
    expect(folha.rows[0][8]).toBe('sim');
    expect(folha.rows[1][8]).toBe('não');
  });

  it('should survive an incident with no tracking code attached', () => {
    expect(folha.rows[1][5]).toBe(null);
  });

  it('should accept an empty list without failing', () => {
    // Não ter ocorrências é uma resposta legítima — devolver erro obrigaria quem
    // exporta a distinguir "correu mal" de "não há nada".
    expect(incidentsSheets([])[0].rows).toEqual([]);
    expect(incidentsSheets(undefined)[0].rows).toEqual([]);
  });
});
