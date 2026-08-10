/**
 * @file migrate-pod-images.js
 * @description Migração ADITIVA das imagens do comprovativo de entrega.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.28
 *
 * Uso:
 *   node src/infrastructure/migrate-pod-images.js
 */
'use strict';

require('dotenv').config();
const pool = require('./db');
const { applyPodImagesSchema } = require('./migrations/pod-images');

async function migrate() {
  const client = await pool.connect();
  try {
    console.info('[migrate:pod-images] A mover imagens do comprovativo para tabela própria...');
    await client.query('BEGIN');
    await applyPodImagesSchema(client);
    await client.query('COMMIT');
    console.info('[migrate:pod-images] ✅ Imagens separadas do pedido.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate:pod-images] ❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch(() => { pool.end(); process.exit(1); });
}

module.exports = { migrate };
