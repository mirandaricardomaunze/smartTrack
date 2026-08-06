/**
 * @file seed-superadmin.js
 * @description Provisiona o SUPERADMIN da plataforma (multi-tenant) em produção.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 2.4
 *
 * Em produção as contas de demonstração estão DESLIGADAS, por isso é preciso criar
 * o SUPERADMIN (dono da plataforma) explicitamente. Idempotente: se o email já
 * existir, não faz nada. Credenciais por ambiente:
 *   SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD
 *
 * Uso: node scripts/seed-superadmin.js
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
process.env.PGDATABASE = process.env.PGDATABASE || 'track';

const { UserRepository } = require('../src/infrastructure/pg.repository');
const { hashPassword } = require('../src/infrastructure/password.utils');
const pool = require('../src/infrastructure/db');

(async () => {
  const email = String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD || '';

  if (!email || password.length < 8) {
    console.error('[seed-superadmin] Defina SUPERADMIN_EMAIL e SUPERADMIN_PASSWORD (>= 8 caracteres).');
    process.exit(1);
  }

  try {
    await UserRepository.ensureTable();
    const existing = await UserRepository.findByEmailWithHash(email);
    if (existing) {
      console.info(`[seed-superadmin] Já existe uma conta com ${email} — nada a fazer.`);
      await pool.end();
      return;
    }

    await UserRepository.create({
      id: crypto.randomUUID(),
      name: 'Plataforma',
      email,
      password_hash: hashPassword(password),
      role: 'SUPERADMIN',
      company_id: null, // SUPERADMIN não pertence a nenhuma empresa
    });

    console.info(`[seed-superadmin] SUPERADMIN criado: ${email}`);
    await pool.end();
  } catch (err) {
    console.error('[seed-superadmin] Erro:', err.message);
    process.exit(1);
  }
})();
