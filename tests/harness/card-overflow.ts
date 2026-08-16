/**
 * @file card-overflow.ts
 * @description Sonda: nenhum texto pode sair de um cartão.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.50
 *
 * NÃO É UMA FACTORY — é ferramenta de verificação, como `modal-overlays.ts`.
 *
 * A garantia vive em CSS (`overflow-wrap` no cartão, que é herdado por tudo o
 * que esteja lá dentro). Uma garantia em CSS tem uma falha de tipo conhecido:
 * continua a existir e a parecer certa enquanto alguém cria uma app nova, ou
 * troca a classe do cartão, e o novo cartão fica de fora sem que nada se queixe.
 *
 * A segunda parte é dimensionamento: a rede impede o desastre, mas quebrar um
 * montante a meio continua a ser feio. Uma grelha de cartões com colunas a mais
 * torna a quebra inevitável, e é a grelha que está errada — não o texto.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Uma grelha que contém cartões de indicador. */
export interface StatGridRef {
  file: string;
  line: number;
  classes: string;
  /** Maior número de colunas que a grelha assume em qualquer ponto de quebra. */
  maxColumns: number;
}

/**
 * Colunas a partir das quais um cartão fica estreito demais para um montante.
 *
 * Quatro: num ecrã de 1400px, quatro colunas dão ~330px por cartão e ~280px
 * úteis depois do padding — cabe "1.234.567,89 MZN" a `text-3xl` com folga.
 * Em cinco, deixa de caber. Não é um número de gosto; é onde a conta muda.
 */
export const MAX_STAT_COLUMNS = 4;

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
 * Grelhas que contêm `StatCard`, com o número de colunas que declaram.
 *
 * Reconhece a grelha pelo `className` e confirma que é de indicadores pela
 * presença de `StatCard` logo a seguir — assim uma grelha de formulário com
 * seis colunas não é acusada por engano.
 */
export function scanStatGrids(root: string, repoRoot = root): StatGridRef[] {
  const achados: StatGridRef[] = [];

  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');

    for (const m of src.matchAll(/className="([^"]*\bgrid\b[^"]*grid-cols-[^"]*)"/g)) {
      const classes = m[1];
      const janela = src.slice(m.index ?? 0, (m.index ?? 0) + 260);
      if (!janela.includes('StatCard')) continue;

      const colunas = [...classes.matchAll(/grid-cols-(\d+)/g)].map((c) => Number(c[1]));
      achados.push({
        file: relative(repoRoot, file).replace(/\\/g, '/'),
        line: src.slice(0, m.index).split('\n').length,
        classes,
        maxColumns: colunas.length ? Math.max(...colunas) : 1,
      });
    }
  }
  return achados;
}

/** Grelhas com colunas a mais para o que lá vai dentro. */
export function overcrowdedGrids(grids: StatGridRef[], limite = MAX_STAT_COLUMNS): StatGridRef[] {
  return grids.filter((g) => g.maxColumns > limite);
}

/**
 * Remove comentários antes de procurar. PURA.
 *
 * SEM ISTO A SONDA MENTE, e mentiu: o comentário que explica a garantia contém
 * a palavra `break-words`, e a verificação dava-a por cumprida mesmo depois de
 * alguém a apagar do código. Uma sonda que se satisfaz com a documentação da
 * regra em vez da regra é pior do que não haver sonda — passa a dar confiança
 * onde não há.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');   // preserva o // de https://
}

/**
 * A app garante que o texto não sai do cartão?
 *
 * Aceita as duas formas legítimas: a declaração CSS na classe do cartão, ou a
 * classe utilitária do Tailwind no componente — a app do motorista não tem
 * `.card`, tem o estilo no componente.
 */
export function guaranteesCardWrap(sources: string[]): boolean {
  return sources
    .map(stripComments)
    .some((s) => /overflow-wrap:\s*(break-word|anywhere)/.test(s) || /\bbreak-words\b/.test(s));
}

export function describeGrids(grids: StatGridRef[]): string {
  return grids
    .map((g) => `  ${g.file}:${g.line} — ${g.maxColumns} colunas · ${g.classes}`)
    .join('\n');
}
