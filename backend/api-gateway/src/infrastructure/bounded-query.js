/**
 * @file bounded-query.js
 * @description Consulta com teto que se declara em vez de se calar.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.51
 *
 * O PROBLEMA QUE ISTO RESOLVE: vários relatórios traziam `LIMIT 500` ou
 * `LIMIT 2000` e somavam as linhas em memória. Acima do teto, o número saía a
 * menos — e saía com o aspeto de estar completo. É o mesmo defeito que o § 3.39
 * corrigiu no painel: uma amostra apresentada como a operação inteira.
 *
 * A CORREÇÃO IDEAL É AGREGAR EM SQL, e é o que as contas a receber fazem
 * (§ 3.41): com `SUM` e `COUNT` na base, o teto deixa de fazer sentido. Onde a
 * regra é complexa demais para viver duas vezes — a avaliação de SLA, o cálculo
 * de desempenho — reescrevê-la em SQL criaria duas definições da mesma coisa a
 * divergir com o tempo, que é pior do que o teto.
 *
 * Para esses, o teto fica — mas passa a ser DITO. Um relatório que declara
 * "medido sobre as 2000 encomendas mais recentes" é utilizável; o mesmo
 * relatório calado é uma armadilha.
 *
 * COMO SABE QUE TRUNCOU: pede uma linha a mais do que o teto. Se ela vier, havia
 * mais — sem uma segunda consulta de contagem, que num relatório pesado custaria
 * quase tanto como a primeira.
 */
'use strict';

const pool = require('./db');

/**
 * Corre `sql` com teto e diz se truncou.
 *
 * O `sql` NÃO deve trazer `LIMIT` — é acrescentado aqui, com o valor certo.
 *
 * @param {string} sql
 * @param {Array} params
 * @param {number} ceiling
 * @param {import('pg').Pool} [executor]
 * @returns {Promise<{ rows: object[], coverage: { counted: number, ceiling: number, truncated: boolean } }>}
 */
async function queryBounded(sql, params, ceiling, executor = pool) {
  const teto = Math.max(1, Math.floor(Number(ceiling) || 1));
  const { rows } = await executor.query(`${sql}\n LIMIT ${teto + 1}`, params);

  const truncated = rows.length > teto;
  const usadas = truncated ? rows.slice(0, teto) : rows;

  return { rows: usadas, coverage: coverageOf(usadas.length, teto, truncated) };
}

/**
 * Descreve a cobertura de um relatório. PURA.
 *
 * A frase vem daqui e não de cada ecrã: três ecrãs a redigirem o mesmo aviso
 * acabam com três avisos diferentes, e o que disser menos é o que alguém vai
 * acreditar.
 *
 * @param {number} counted
 * @param {number} ceiling
 * @param {boolean} truncated
 */
function coverageOf(counted, ceiling, truncated) {
  return {
    counted,
    ceiling,
    truncated: Boolean(truncated),
    note: truncated
      ? `Medido sobre os ${ceiling} registos mais recentes do período. Há mais, e ficaram de fora.`
      : null,
  };
}

/** Junta coberturas de várias consultas num só veredicto. PURA. */
function mergeCoverage(...coberturas) {
  const validas = coberturas.filter(Boolean);
  const truncou = validas.some((c) => c.truncated);
  const teto = Math.min(...validas.map((c) => c.ceiling ?? Infinity));

  return coverageOf(
    validas.reduce((s, c) => s + (c.counted ?? 0), 0),
    Number.isFinite(teto) ? teto : 0,
    truncou,
  );
}

module.exports = { queryBounded, coverageOf, mergeCoverage };
