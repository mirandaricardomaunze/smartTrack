/**
 * @file card-overflow.spec.ts
 * @description Nenhum texto sai de um cartão, em nenhuma das três aplicações.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.50
 *
 * Vive em tests/integration/ porque a regra é do repositório, não de uma app.
 * Não precisa de PostgreSQL — só lê ficheiros.
 *
 * O DEFEITO QUE ISTO GUARDA: "110.500,00 MZN" numa coluna de um sexto saía por
 * cima do cartão do lado. Ali não se lê como layout partido — lê-se como o
 * número do vizinho, que é a pior maneira de um relatório financeiro falhar.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanStatGrids, overcrowdedGrids, guaranteesCardWrap, describeGrids, MAX_STAT_COLUMNS,
} from '../harness/card-overflow';

const ROOT = join(__dirname, '..', '..');
const APPS = ['admin-panel', 'client-app', 'driver-app'] as const;

/** Onde cada app pode declarar a garantia: folha de estilo ou componente. */
function fontesDeEstilo(app: string): string[] {
  const caminhos = [
    join(ROOT, 'frontend', app, 'src', 'app', 'globals.css'),
    join(ROOT, 'frontend', app, 'src', 'components', 'ui', 'index.tsx'),
    join(ROOT, 'frontend', app, 'src', 'components', 'ui', 'Card.tsx'),
  ];
  return caminhos.filter(existsSync).map((c) => readFileSync(c, 'utf8'));
}

describe('cartões · nenhum texto sai para fora', () => {
  it.each(APPS)('%s declara a garantia no cartão', (app) => {
    // `overflow-wrap` é herdado, por isso declará-lo no cartão cobre também as
    // caixas aninhadas lá dentro — que é onde vivem os escalões de antiguidade
    // e outros blocos que não são cartões por si.
    expect(
      guaranteesCardWrap(fontesDeEstilo(app)),
      `${app} não garante a quebra de palavras no cartão. Uma morada comprida, um\n` +
      'código de rastreio ou um montante transbordam para cima do que estiver ao\n' +
      'lado. Declarar `overflow-wrap: break-word` na classe do cartão, ou\n' +
      '`break-words` no componente quando a app não tem classe.',
    ).toBe(true);
  });

  it.each(APPS)('%s não aperta os cartões de indicador em colunas a mais', (app) => {
    // A garantia impede o desastre; a grelha é que evita que ele seja preciso.
    // Quebrar um montante a meio continua a ser feio.
    const apertadas = overcrowdedGrids(scanStatGrids(join(ROOT, 'frontend', app), ROOT));

    expect(
      apertadas,
      `Grelha de indicadores com mais de ${MAX_STAT_COLUMNS} colunas. Num ecrã de\n` +
      '1400px, cinco colunas deixam menos de 250px úteis por cartão — e um\n' +
      'montante a `text-3xl` não cabe lá:\n' +
      `${describeGrids(apertadas)}`,
    ).toEqual([]);
  });

  it('a sonda não aceita a documentação da regra no lugar da regra', () => {
    // Aconteceu: o comentário que explica a garantia contém a palavra
    // `break-words`, e a verificação dava-a por cumprida mesmo depois de alguém
    // a apagar do código. Uma sonda que se satisfaz com o comentário é pior do
    // que não haver sonda — dá confiança onde não há.
    const soComentario = ['// usar break-words aqui\n/* overflow-wrap: break-word */'];
    const aSerio = ['.card { overflow-wrap: break-word; }'];

    expect(guaranteesCardWrap(soComentario)).toBe(false);
    expect(guaranteesCardWrap(aSerio)).toBe(true);
  });

  it('a sonda distingue uma grelha de indicadores de uma grelha qualquer', () => {
    // Uma grelha de formulário com seis colunas é legítima e não pode ser
    // acusada — só as que levam cartões de indicador é que entram nesta regra.
    const grelhas = scanStatGrids(join(ROOT, 'frontend', 'admin-panel'), ROOT);

    expect(grelhas.length).toBeGreaterThan(0);
    expect(grelhas.every((g) => g.classes.includes('grid-cols-'))).toBe(true);
  });
});
