/**
 * @file db.js
 * @description Pool de conexões PostgreSQL do routes-service.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 6 (Stack — PostgreSQL 15+)
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 4 (Segurança — nunca hardcode credentials)
 *
 * Cada microsserviço tem a SUA base de dados (default: routes_db) — não partilha
 * tabelas com o api-gateway. Credenciais lidas exclusivamente de .env.
 * NUNCA hardcodar credenciais neste arquivo.
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'routes_db',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || '',
  max:             10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Nunca silenciar erros de conexão de DB
  console.error('[db] Erro inesperado no cliente idle do pool:', err.message);
});

module.exports = pool;
