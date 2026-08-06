/**
 * @file notifications.pg.spec.js
 * @description Testes de integração do notifications-service contra PostgreSQL real.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * O que só se prova aqui: o `ON CONFLICT` que torna o registo de token
 * idempotente (a app reenvia o token a cada arranque), o round-trip de JSONB
 * aninhado no payload, e a limpeza efetiva de tokens que o FCM reporta mortos.
 *
 * Pré-requisitos:
 *   - PostgreSQL a atender (senão a suite é saltada)
 *   - `cd backend/notifications-service && npm run migrate`
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

// DEVE vir antes de importar o serviço — ver nota em helpers/pg-env.js
useDatabase('notifications_db');

const disponivel = await isPostgresReachable();

const svc  = disponivel ? require(`${ROOT}/backend/notifications-service/src/application/notifications.service`) : null;
const pool = disponivel ? require(`${ROOT}/backend/notifications-service/src/infrastructure/db`) : null;

const userId   = `user-itest-${Date.now()}`;
const tokenVivo = `tok-${userId}`;
const tokenMorto = `dead-${userId}`;

describe.skipIf(!disponivel)('notifications-service · PostgreSQL', () => {
  afterAll(async () => {
    if (!disponivel) return;
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM device_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM preferences WHERE user_id = $1', [userId]);
    await pool.query("DELETE FROM notifications WHERE id = 'n-itest-bad'");
    await pool.end();
  });

  describe('tokens de dispositivo', () => {
    it('should be idempotent on re-register (ON CONFLICT)', async () => {
      // A app reenvia o token a cada arranque — não pode duplicar linhas
      await svc.registerDevice({ user_id: userId, token: tokenVivo, platform: 'android' });
      await svc.registerDevice({ user_id: userId, token: tokenVivo, platform: 'android' });

      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM device_tokens WHERE user_id = $1',
        [userId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('envio', () => {
    it('should send and record the delivered count', async () => {
      const n = await svc.sendNotification({
        user_id: userId, role: 'CLIENT', category: 'ORDER_STATUS',
        title: 'Pedido a caminho', body: 'Saiu para entrega.',
        data: { orderId: 'ord-9', nested: { a: 1 } },
      });

      expect(n.status).toBe('sent');
      expect(typeof n.delivered_count).toBe('number');
      expect(n.delivered_count).toBe(1);
    });

    it('should round-trip a nested JSONB payload', async () => {
      const lista = await svc.listNotifications({ user_id: userId });
      const comData = lista.find((n) => n.data && n.data.orderId === 'ord-9');

      expect(comData.data.nested.a).toBe(1);
    });

    it('should clean up tokens the FCM reports as dead', async () => {
      await svc.registerDevice({ user_id: userId, token: tokenMorto });

      await svc.sendNotification({
        user_id: userId, role: 'CLIENT', category: 'DESTINATION_REQUEST',
        title: 'Confirme o destino', body: 'Tem 24h.',
      });

      const { rows } = await pool.query(
        'SELECT token FROM device_tokens WHERE user_id = $1',
        [userId],
      );
      expect(rows.map((r) => r.token)).toEqual([tokenVivo]);
    });
  });

  describe('preferências persistidas', () => {
    it('should suppress a category the user turned off', async () => {
      await svc.updatePreferences(userId, { ORDER_STATUS: false });

      const n = await svc.sendNotification({
        user_id: userId, role: 'CLIENT', category: 'ORDER_STATUS',
        title: 'x', body: 'y',
      });

      expect(n.status).toBe('suppressed');
    });

    it('should still deliver a critical category', async () => {
      // Spec § 8.2 — sem esta notificação o pedido fica em hold
      const n = await svc.sendNotification({
        user_id: userId, role: 'CLIENT', category: 'DESTINATION_REQUEST',
        title: 'Confirme o destino', body: 'Tem 24h.',
      });

      expect(n.status).toBe('sent');
    });

    it('should read the stored preference back', async () => {
      const prefs = await svc.getPreferences(userId, 'CLIENT');
      const status = prefs.categories.find((c) => c.category === 'ORDER_STATUS');

      expect(status.enabled).toBe(false);
    });
  });

  describe('consultas', () => {
    it('should return counts as numbers', async () => {
      const stats = await svc.getStats();

      expect(typeof stats.sent).toBe('number');
      expect(typeof stats.suppressed).toBe('number');
    });
  });

  describe('constraints', () => {
    it('should reject an unknown category at the database level', async () => {
      await expect(pool.query(
        `INSERT INTO notifications (id, user_id, role, category, title, body, created_at, updated_at)
         VALUES ('n-itest-bad', 'u', 'CLIENT', 'INVENTADA', 't', 'b', NOW(), NOW())`,
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});
