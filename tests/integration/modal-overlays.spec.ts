/**
 * @file modal-overlays.spec.ts
 * @description Um modal alto não pode ficar com o topo fora do ecrã.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.49
 *
 * Vive em tests/integration/ pela mesma razão que `offline-assets.spec.ts`: a
 * regra é do repositório, não de uma app. Não precisa de PostgreSQL — só lê
 * ficheiros.
 *
 * O DEFEITO QUE ISTO GUARDA: uma sobreposição `fixed inset-0` com
 * `items-center` e sem scroll corta o modal pelos dois lados quando ele é mais
 * alto do que a janela, e a ponta de cima fica inalcançável — o cabeçalho, e às
 * vezes o botão de fechar, deixam de existir para quem está a olhar. Foi
 * relatado a partir do ecrã, não apanhado por nenhum teste.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanModalOverlays, coveredAlignments, uncoveredOverlays, describeOverlays,
} from '../harness/modal-overlays';

const ROOT = join(__dirname, '..', '..');
const APPS = ['admin-panel', 'client-app', 'driver-app'] as const;

function cssDaApp(app: string): string {
  return readFileSync(join(ROOT, 'frontend', app, 'src', 'app', 'globals.css'), 'utf8');
}

describe('modais · alcançáveis quando são mais altos do que a janela', () => {
  it.each(APPS)('%s: nenhuma sobreposição fica sem tratamento de overflow', (app) => {
    const raiz = join(ROOT, 'frontend', app);
    const overlays = scanModalOverlays(raiz, ROOT);
    const cobertos = coveredAlignments(cssDaApp(app));
    const fora = uncoveredOverlays(overlays, cobertos);

    expect(
      fora,
      'Sobreposição de modal sem forma de chegar ao que transborda. Ou o painel\n' +
      'interior limita a altura e faz scroll (max-h-[…] + overflow-y-auto), ou o\n' +
      'alinhamento usado tem de estar coberto pela regra de globals.css:\n' +
      `${describeOverlays(fora)}`,
    ).toEqual([]);
  });

  it('a regra de CSS cobre os alinhamentos que o código realmente usa', () => {
    // Uma regra escrita à mão continua a parecer certa enquanto alguém escreve
    // um modal novo com outro alinhamento — e esse fica de fora em silêncio.
    const usados = new Set(
      APPS.flatMap((app) => scanModalOverlays(join(ROOT, 'frontend', app), ROOT))
        .map((o) => o.alignment)
        .filter((a): a is string => a !== null),
    );
    const cobertos = coveredAlignments(cssDaApp('admin-panel'));

    for (const alinhamento of usados) {
      expect(
        cobertos.has(alinhamento),
        `O código usa "${alinhamento}" numa sobreposição e globals.css não o trata.`,
      ).toBe(true);
    }
  });

  it('a sonda reconhece um painel que trata de si próprio', () => {
    // Os modais que já limitam a altura e fazem scroll por dentro não precisam
    // da regra global — e não podem ser acusados por ela.
    const comPainelProprio = scanModalOverlays(join(ROOT, 'frontend', 'admin-panel'), ROOT)
      .filter((o) => o.panelScrolls);

    expect(comPainelProprio.length).toBeGreaterThan(0);
    expect(uncoveredOverlays(comPainelProprio, new Set())).toEqual([]);
  });
});
