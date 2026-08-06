/**
 * @file bootstrap-migrate.js
 * @description Migração segura para arranque em produção (idempotente).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4, § 6
 *
 * O migrate do núcleo (`src/infrastructure/migrate.js`) é DESTRUTIVO (faz DROP das
 * tabelas operacionais) — só deve correr numa base VAZIA. Este bootstrap:
 *   1) Se a base ainda não tem a tabela `companies` → base nova → corre o núcleo
 *      (cria orders/drivers/warehouses/companies/company_id/… de raiz).
 *   2) Corre sempre as migrações dos módulos (idempotentes).
 * Assim, o primeiro arranque cria tudo e os arranques seguintes nunca apagam dados.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
process.env.PGDATABASE = process.env.PGDATABASE || 'track';

const pool = require('../src/infrastructure/db');

function run(relativeScript, args = []) {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [path.join(backendRoot, relativeScript), ...args], {
    cwd: backendRoot,
    env: { ...process.env, PGDATABASE: process.env.PGDATABASE },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`[bootstrap] Falha em ${relativeScript}.`);
    process.exit(result.status || 1);
  }
}

(async () => {
  try {
    const { rows } = await pool.query("SELECT to_regclass('public.companies') AS t");
    const fresh = rows[0].t === null;
    await pool.end();

    if (fresh) {
      console.info('[bootstrap] Base vazia detetada — a criar o núcleo (migrate --reset-core).');
      run('api-gateway/src/infrastructure/migrate.js');
    } else {
      console.info('[bootstrap] Base já inicializada — a saltar a recriação do núcleo (dados preservados).');
    }

    // Migrações dos módulos (idempotentes) — sempre.
    run('api-gateway/scripts/migrate-all.js');
    console.info('[bootstrap] Migração concluída.');
  } catch (err) {
    console.error('[bootstrap] Erro:', err.message);
    process.exit(1);
  }
})();
