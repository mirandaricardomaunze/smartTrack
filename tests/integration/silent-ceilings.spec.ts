/**
 * @file silent-ceilings.spec.ts
 * @description Nenhum relatório trunca sem o dizer.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.51
 *
 * Não precisa de PostgreSQL — só lê ficheiros.
 *
 * Já aconteceu duas vezes: o painel a somar uma página de 200 encomendas e a
 * apresentá-la como a operação inteira (§ 3.39), e cinco relatórios com tetos
 * entre 200 e 5000 (§ 3.51). Da segunda vez ficou claro que corrigir caso a caso
 * não chega — o padrão volta na consulta seguinte que alguém escrever.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { scanSilentCeilings, describeCeilings } from '../harness/silent-ceilings';

const ROOT = join(__dirname, '..', '..');

/**
 * Onde vivem os cálculos que somam linhas em memória.
 *
 * Os repositórios ficam de fora: lá, `LIMIT` faz parte da paginação, que tem
 * contagem total ao lado e não engana ninguém (§ 3.1).
 */
const CAMADAS = [
  join(ROOT, 'backend', 'api-gateway', 'src', 'application'),
  join(ROOT, 'backend', 'routes-service', 'src', 'application'),
  join(ROOT, 'backend', 'orders-service', 'src', 'application'),
];

describe('relatórios · tetos declarados, nunca silenciosos', () => {
  it.each(CAMADAS)('%s não tem LIMIT literal fora de queryBounded', (camada) => {
    const silenciosos = scanSilentCeilings(camada, ROOT);

    expect(
      silenciosos,
      'Consulta com teto fixo fora de `queryBounded`. Acima dele o resultado sai\n' +
      'a menos, com o aspeto de estar completo — e é sobre esse número que\n' +
      'alguém decide preços ou telefona a cobrar. Ou agregar em SQL (SUM/COUNT,\n' +
      'e o teto deixa de fazer sentido), ou usar `queryBounded`, que devolve\n' +
      '`coverage` para o ecrã poder dizer sobre quanto mediu:\n' +
      `${describeCeilings(silenciosos)}`,
    ).toEqual([]);
  });

  it('a sonda não confunde procurar uma linha com truncar um relatório', () => {
    // `LIMIT 1` é uma pesquisa, e há 48 delas nesta base. Acusá-las tornaria a
    // sonda ruído, e uma sonda ruidosa é desligada.
    const encontrados = CAMADAS.flatMap((c) => scanSilentCeilings(c, ROOT));
    expect(encontrados.every((r) => r.limit >= 2)).toBe(true);
  });
});
