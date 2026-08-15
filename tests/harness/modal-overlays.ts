/**
 * @file modal-overlays.ts
 * @description Sonda das sobreposições de modal no código dos frontends.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.49
 *
 * NÃO É UMA FACTORY — é uma ferramenta de verificação, como `external-assets.ts`.
 * Lê o código-fonte e devolve o que lá está.
 *
 * PORQUE EXISTE: um modal mais alto do que a janela ficava com o topo fora do
 * ecrã e sem scroll que lá chegasse — o botão de guardar era inalcançável. A
 * correção vive numa regra de CSS que apanha as sobreposições pelas classes que
 * o Tailwind gera. Uma regra assim é frágil de uma maneira específica: continua
 * a existir e a parecer certa enquanto alguém escreve um modal novo com outro
 * alinhamento, e esse modal fica de fora sem que nada se queixe.
 *
 * Esta sonda fecha essa porta: enumera os alinhamentos realmente usados e
 * confronta-os com os que a regra cobre.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Uma sobreposição encontrada no código. */
export interface OverlayRef {
  /** Caminho relativo à raiz do repositório. */
  file: string;
  line: number;
  /** Lista de classes da sobreposição. */
  classes: string;
  /** Utilitário de alinhamento vertical usado (`items-center`, …) ou null. */
  alignment: string | null;
  /** O painel interior limita a altura e faz scroll por si? */
  panelScrolls: boolean;
}

const ALIGNMENT_RE = /\b(items-(?:center|start|end|baseline|stretch)|place-items-\w+|content-\w+)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Encontra as sobreposições de modal sob `root`.
 *
 * Reconhece-as por `fixed inset-0`, que é como todas foram escritas. Uma
 * sobreposição escrita de outra maneira escapa a esta sonda — e é por isso que
 * a spec pede um componente partilhado como destino final.
 */
export function scanModalOverlays(root: string, repoRoot = root): OverlayRef[] {
  const achados: OverlayRef[] = [];

  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');

    for (const m of src.matchAll(/className="([^"]*\bfixed\b[^"]*\binset-0\b[^"]*)"/g)) {
      const classes = m[1];
      // A janela a seguir apanha o painel interior — é lá que vive o limite de
      // altura quando o modal trata do assunto por si.
      const janela = src.slice(m.index ?? 0, (m.index ?? 0) + 400);

      achados.push({
        file: relative(repoRoot, file).replace(/\\/g, '/'),
        line: src.slice(0, m.index).split('\n').length,
        classes,
        alignment: ALIGNMENT_RE.exec(classes)?.[1] ?? null,
        panelScrolls: /max-h-\[[^\]]+\][^"]*overflow-y-auto|overflow-y-auto[^"]*max-h-\[/.test(janela),
      });
    }
  }
  return achados;
}

/**
 * Alinhamentos que uma folha de estilo declara tratar.
 *
 * Lê os seletores em vez de os assumir: se alguém apertar a regra do CSS, é
 * aqui que se descobre, e não numa página que ninguém abriu.
 */
export function coveredAlignments(css: string): Set<string> {
  const cobertos = new Set<string>();

  for (const m of css.matchAll(/\.fixed\.inset-0\.([\w-]+)/g)) cobertos.add(m[1]);
  return cobertos;
}

/**
 * As sobreposições que ficam de fora: nem cobertas pelo CSS, nem capazes de
 * fazer scroll por si.
 */
export function uncoveredOverlays(overlays: OverlayRef[], covered: Set<string>): OverlayRef[] {
  return overlays.filter((o) => {
    if (o.panelScrolls) return false;              // trata de si
    if (o.alignment && covered.has(o.alignment)) return false;
    return true;
  });
}

/** Descrição legível para a mensagem de falha do teste. */
export function describeOverlays(overlays: OverlayRef[]): string {
  return overlays
    .map((o) => `  ${o.file}:${o.line} — alinhamento: ${o.alignment ?? 'nenhum'}`)
    .join('\n');
}
