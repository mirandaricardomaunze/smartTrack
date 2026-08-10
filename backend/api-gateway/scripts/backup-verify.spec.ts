/**
 * @file backup-verify.spec.ts
 * @description Testes da regra que decide se uma cópia reprova o ensaio.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Cópias de segurança)
 *
 * `compareChains` tornou o ensaio de restauro MAIS PERMISSIVO: uma cadeia de
 * hash já partida na origem deixou de reprovar a cópia, porque o `pg_dump`
 * copiou-a fielmente e a culpa é do histórico, não da cópia. Uma regra que
 * afrouxa um controlo de segurança tem de provar que continua a apanhar o caso
 * que interessa — uma cadeia que estava íntegra na origem e chega partida ao
 * restauro. É só isso que estes testes cobrem, e é por isso que existem.
 */
import { describe, expect, it } from 'vitest';

const { compareChains } = require('./backup-verify');

/** Cadeia como as sondas a devolvem: identidade + estado. */
const chain = (id: string, ok: boolean) => ({ id, ok });

describe('Ensaio de restauro · origem vs restauro', () => {
  it('should approve a copy where every chain survived intact', () => {
    const antes  = [chain('company-a', true), chain('FT/2026', true)];
    const depois = [chain('company-a', true), chain('FT/2026', true)];

    expect(compareChains(antes, depois)).toEqual({ regressions: [], preexisting: [] });
  });

  it('should FAIL the copy when a chain intact at the source arrives broken', () => {
    const antes  = [chain('company-a', true)];
    const depois = [chain('company-a', false)];

    expect(compareChains(antes, depois).regressions).toEqual(['company-a']);
  });

  it('should not blame the copy for a chain that was already broken at the source', () => {
    const antes  = [chain('company-default', false)];
    const depois = [chain('company-default', false)];

    const { regressions, preexisting } = compareChains(antes, depois);
    expect(regressions).toEqual([]);
    expect(preexisting).toEqual(['company-default']);
  });

  it('should still catch a regression while another chain was already broken', () => {
    // O caso que a permissividade podia esconder: o ruído de uma cadeia velha
    // partida não pode tapar uma cadeia que o restauro partiu agora.
    const antes  = [chain('company-default', false), chain('company-a', true)];
    const depois = [chain('company-default', false), chain('company-a', false)];

    const { regressions, preexisting } = compareChains(antes, depois);
    expect(regressions).toEqual(['company-a']);
    expect(preexisting).toEqual(['company-default']);
  });

  it('should treat a chain absent from the source as pre-existing, not a regression', () => {
    // A origem é lida agora e a cópia é anterior: uma cadeia que já não existe
    // na origem não tem termo de comparação, e a dúvida não reprova a cópia.
    const antes  = [chain('company-a', true)];
    const depois = [chain('company-a', true), chain('company-apagada', false)];

    const { regressions, preexisting } = compareChains(antes, depois);
    expect(regressions).toEqual([]);
    expect(preexisting).toEqual(['company-apagada']);
  });

  it('should ignore chains broken at the source that the restore healed', () => {
    // Não devia acontecer, mas se acontecer não é motivo para reprovar nada.
    const antes  = [chain('company-a', false)];
    const depois = [chain('company-a', true)];

    expect(compareChains(antes, depois)).toEqual({ regressions: [], preexisting: [] });
  });
});
