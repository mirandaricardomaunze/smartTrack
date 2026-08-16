/**
 * @file silent-ceilings.ts
 * @description Sonda: nenhum relatório trunca sem o dizer.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.51
 *
 * NÃO É UMA FACTORY — é ferramenta de verificação, como `modal-overlays.ts`.
 *
 * O PADRÃO QUE ISTO CAÇA: `LIMIT 500` escrito à mão numa consulta cujas linhas
 * são depois somadas em memória. Acima do teto, o número sai a menos — e sai com
 * o aspeto de estar completo. Já aconteceu duas vezes nesta base: no painel
 * (§ 3.39, corrigido) e em cinco relatórios (§ 3.51). Na segunda vez percebeu-se
 * que corrigir caso a caso não chega, porque o padrão volta na consulta
 * seguinte que alguém escrever.
 *
 * O que é legítimo e NÃO é acusado:
 *   - `LIMIT 1` — procurar uma linha;
 *   - `LIMIT ${…}` — paginação, onde o teto vem de quem pede e há contagem
 *     total ao lado (§ 3.1);
 *   - `queryBounded(...)` — teto declarado, que devolve `coverage`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface CeilingRef {
  file: string;
  line: number;
  /** O teto literal encontrado. */
  limit: number;
  /** A linha de código, para a mensagem de falha ser acionável. */
  snippet: string;
}

/** `LIMIT 1` é procurar uma linha, não truncar um relatório. */
const MIN_SUSPECT = 2;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js') && !full.endsWith('.spec.js')) out.push(full);
  }
  return out;
}

/**
 * Tetos literais em consultas que não passam por `queryBounded`.
 *
 * Procura o `LIMIT` e olha para trás, no mesmo bloco de template, à procura da
 * chamada que o executa. É uma heurística de texto — mas o alvo também é texto,
 * e uma heurística que falha por excesso apenas obriga alguém a justificar-se.
 */
export function scanSilentCeilings(root: string, repoRoot = root): CeilingRef[] {
  const achados: CeilingRef[] = [];

  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');

    for (const m of src.matchAll(/\bLIMIT\s+(\d+)\b/gi)) {
      const limite = Number(m[1]);
      if (limite < MIN_SUSPECT) continue;

      // O início da consulta: a chamada que a executa está antes do template.
      const antes = src.slice(Math.max(0, (m.index ?? 0) - 1200), m.index);
      const inicio = Math.max(antes.lastIndexOf('await '), antes.lastIndexOf('return '));
      const chamada = inicio >= 0 ? antes.slice(inicio) : antes;
      if (chamada.includes('queryBounded')) continue;

      const linha = src.slice(0, m.index).split('\n').length;
      achados.push({
        file: relative(repoRoot, file).replace(/\\/g, '/'),
        line: linha,
        limit: limite,
        snippet: (src.split('\n')[linha - 1] ?? '').trim(),
      });
    }
  }
  return achados;
}

export function describeCeilings(refs: CeilingRef[]): string {
  return refs
    .map((r) => `  ${r.file}:${r.line} — LIMIT ${r.limit}  ·  ${r.snippet}`)
    .join('\n');
}
