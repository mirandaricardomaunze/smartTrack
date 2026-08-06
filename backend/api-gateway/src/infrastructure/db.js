/**
 * @file db.js
 * @description Pool de conexões PostgreSQL para o api-gateway.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Stack — PostgreSQL 15+)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — nunca hardcode credentials)
 *
 * Credenciais lidas exclusivamente de variáveis de ambiente (.env).
 * NUNCA hardcodar credenciais neste arquivo.
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'track',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || '',
  // Pool sizing conservador para desenvolvimento local
  max:             10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Nunca silenciar erros de conexão de DB
  console.error('[db] Erro inesperado no cliente idle do pool:', err.message);
});

module.exports = pool;
