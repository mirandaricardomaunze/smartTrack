/**
 * @file pg-env.js
 * @description Preparação de ambiente para os testes de integração com PostgreSQL.
 *
 * PORQUÊ ISTO EXISTE:
 * Cada serviço chama `require('dotenv').config()` no seu `db.js`, e o dotenv
 * NÃO sobrepõe variáveis já definidas no processo. Se dois serviços forem
 * carregados no mesmo processo, o segundo herda a base do primeiro e falha com
 * "relação não existe". Por isso cada spec define explicitamente as variáveis
 * ANTES de importar o serviço, e o vitest.integration.config.ts desliga o
 * paralelismo entre ficheiros.
 *
 * As credenciais são lidas de backend/api-gateway/.env — a mesma instância de
 * Postgres que o resto do projeto já usa. Nunca são impressas.
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const net  = require('node:net');

const ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Lê um ficheiro .env simples para um objeto.
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;

  for (const linha of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Credenciais base, partilhadas por todos os serviços.
 * @returns {{host: string, port: number, user: string, password: string}}
 */
function baseCredentials() {
  const env = readEnvFile(path.join(ROOT, 'backend', 'api-gateway', '.env'));

  return {
    host:     env.PGHOST     || 'localhost',
    port:     Number(env.PGPORT) || 5432,
    user:     env.PGUSER     || 'postgres',
    password: env.PGPASSWORD || '',
  };
}

/**
 * Aponta o processo para a base de um serviço.
 * DEVE ser chamado antes de importar qualquer módulo do serviço.
 *
 * @param {string} database Ex.: 'routes_db'
 */
function useDatabase(database) {
  const cred = baseCredentials();

  process.env.PGHOST     = cred.host;
  process.env.PGPORT     = String(cred.port);
  process.env.PGUSER     = cred.user;
  process.env.PGPASSWORD = cred.password;
  process.env.PGDATABASE = database;
}

/**
 * O Postgres está a atender? Usado para saltar a suite em vez de a fazer falhar
 * numa máquina sem base de dados levantada.
 *
 * @param {number} [timeoutMs]
 * @param {{host?: string, port?: number}} [override] Só para testar este helper
 * @returns {Promise<boolean>}
 */
function isPostgresReachable(timeoutMs = 1500, override = {}) {
  const cred = { ...baseCredentials(), ...override };

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (resultado) => {
      socket.destroy();
      resolve(resultado);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error',   () => done(false));
    socket.connect(cred.port, cred.host);
  });
}

module.exports = {
  ROOT,
  readEnvFile,
  baseCredentials,
  useDatabase,
  isPostgresReachable,
};
