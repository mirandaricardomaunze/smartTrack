import { defineConfig } from 'vitest/config';

/**
 * Configuração dos testes de integração com PostgreSQL.
 *
 * `fileParallelism: false` é OBRIGATÓRIO, não uma otimização: cada spec aponta
 * `process.env.PGDATABASE` para a base do seu serviço antes de importar o
 * módulo. Correr ficheiros em paralelo no mesmo worker faria uma spec mudar a
 * base debaixo dos pés de outra.
 *
 * As suites saltam-se sozinhas quando o Postgres não está a atender — ver
 * `tests/integration/helpers/pg-env.js`.
 *
 * Uso:
 *   npm run test:integration
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.spec.{js,ts}'],
    fileParallelism: false,
    // Ligar ao Postgres, migrar e limpar leva mais do que o default de 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
