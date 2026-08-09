/**
 * Executa as migrações de todos os módulos sobre a única base do backend.
 * Deve ser chamado explicitamente; nunca corre durante o arranque da API.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const backendRoot = path.resolve(__dirname, '..', '..');
const database = process.env.PGDATABASE || 'track';
const environment = { ...process.env, PGDATABASE: database };
const moduleMigrations = [
  // Aditiva e idempotente: é assim que uma base já existente ganha as tabelas
  // do SaaS (o migrate do núcleo é destrutivo e só corre em bases vazias).
  ['planos e subscrições (SaaS)', 'api-gateway/src/infrastructure/migrate-saas.js'],
  ['conformidade fiscal', 'api-gateway/src/infrastructure/migrate-fiscal.js'],
  ['perfil da empresa', 'api-gateway/src/infrastructure/migrate-branding.js'],
  ['registo de auditoria', 'api-gateway/src/infrastructure/migrate-audit.js'],
  ['recuperação de senha', 'api-gateway/src/infrastructure/migrate-password-reset.js'],
  ['estado de acesso das contas', 'api-gateway/src/infrastructure/migrate-user-access.js'],
  ['índices da listagem de pedidos', 'api-gateway/src/infrastructure/migrate-orders-index.js'],
  ['registo central de erros', 'api-gateway/src/infrastructure/migrate-monitoring.js'],
  // Ambas acrescentam colunas a tabelas do núcleo, por isso correm depois dele.
  ['tarifação por volume e distância', 'api-gateway/src/infrastructure/migrate-pricing-dimensions.js'],
  ['contratos de cliente', 'api-gateway/src/infrastructure/migrate-contracts.js'],
  // Tem de correr depois de a tabela `orders` existir: lê o POD de lá e move as
  // imagens para `order_pod_images`.
  ['imagens do comprovativo de entrega', 'api-gateway/src/infrastructure/migrate-pod-images.js'],
  // Recursos Humanos, finanças e frota. A ordem importa: `hr` cria as tabelas
  // base e `hr-portal` altera `hr_employees`. Sem estas entradas, um deploy novo
  // ficava sem 14 tabelas e as respetivas páginas respondiam 500.
  ['RH — núcleo', 'api-gateway/scripts/migrate-hr.js'],
  ['RH — folha salarial', 'api-gateway/scripts/migrate-hr-payroll.js'],
  ['RH — recrutamento', 'api-gateway/scripts/migrate-hr-recruitment.js'],
  ['RH — desempenho', 'api-gateway/scripts/migrate-hr-performance.js'],
  ['RH — operações', 'api-gateway/scripts/migrate-hr-operations.js'],
  ['RH — portal do colaborador', 'api-gateway/scripts/migrate-hr-portal.js'],
  ['RH — horário/turno do colaborador', 'api-gateway/src/infrastructure/migrate-hr-schedule.js'],
  ['finanças', 'api-gateway/scripts/migrate-finance.js'],
  ['frota', 'api-gateway/scripts/migrate-fleet.js'],
  ['sincronização', 'orders-service/src/infrastructure/migrate.js'],
  ['rotas', 'routes-service/src/infrastructure/migrate.js'],
  ['pagamentos', 'payments-service/src/infrastructure/migrate.js'],
  ['notificações', 'notifications-service/src/infrastructure/migrate.js'],
  ['rastreio', 'tracking-intl-service/src/infrastructure/migrate.js'],
];
const resetCore = process.argv.includes('--reset-core');
const migrations = resetCore
  ? [['núcleo (recriação)', 'api-gateway/src/infrastructure/migrate.js'], ...moduleMigrations]
  : moduleMigrations;

if (resetCore) {
  console.warn('[migrate] --reset-core ativo: as tabelas operacionais do núcleo serão recriadas.');
}

for (const [moduleName, relativeScript] of migrations) {
  console.info(`[migrate] Módulo: ${moduleName}`);
  const result = spawnSync(process.execPath, [path.join(backendRoot, relativeScript)], {
    cwd: backendRoot,
    env: environment,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error(`[migrate] Migração interrompida no módulo ${moduleName}.`);
    process.exit(result.status || 1);
  }
}

console.info(`[migrate] Base única "${database}" pronta para todos os módulos.`);
