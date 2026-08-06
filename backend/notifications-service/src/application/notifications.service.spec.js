/**
 * @file notifications.service.spec.js
 * @description Testes do fluxo de envio de notificações.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * Repositórios substituídos por fakes em memória via `configurePorts` — os
 * testes exercitam a orquestração sem PostgreSQL. O FCM simulado já é
 * determinístico (o desfecho depende do prefixo do token).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fcmClient from '../infrastructure/fcm.client.js';
import service from './notifications.service.js';
import entity from '../domain/notification.entity.js';

const { SimulatedFcm } = fcmClient;
const { NotificationCategory } = entity;

const {
  sendNotification,
  getPreferences,
  updatePreferences,
  registerDevice,
  unregisterDevice,
  listNotifications,
  configurePorts,
  resetPorts,
  MissingRequiredFieldError,
  UnknownCategoryError,
} = service;

// ─── Fakes ────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const notifStore = new Map();
/** @type {Map<string, string>} token → user_id */
const tokenStore = new Map();
/** @type {Map<string, object>} */
const prefStore = new Map();

const fakeNotifications = {
  async findAll(f = {}) {
    const todas = [...notifStore.values()];
    return f.user_id ? todas.filter((n) => n.user_id === f.user_id) : todas;
  },
  async findById(id) { return notifStore.get(id); },
  async create(n) { notifStore.set(n.id, { ...n }); return { ...n }; },
  async update(n) {
    if (!notifStore.has(n.id)) return undefined;
    notifStore.set(n.id, { ...n });
    return { ...n };
  },
  async getStats() { return {}; },
};

const fakeTokens = {
  async findByUser(userId) {
    return [...tokenStore.entries()].filter(([, u]) => u === userId).map(([t]) => t);
  },
  async register(dto) { tokenStore.set(dto.token, dto.user_id); return dto; },
  async unregister(token) { return tokenStore.delete(token); },
  async removeMany(tokens) {
    let n = 0;
    for (const t of tokens) if (tokenStore.delete(t)) n++;
    return n;
  },
};

const fakePreferences = {
  async findByUser(userId) { return prefStore.get(userId) ?? null; },
  async upsert(userId, categories) { prefStore.set(userId, categories); return categories; },
};

beforeEach(() => {
  notifStore.clear();
  tokenStore.clear();
  prefStore.clear();

  resetPorts();
  configurePorts({
    notifications: fakeNotifications,
    tokens:        fakeTokens,
    preferences:   fakePreferences,
    getFcm:        () => SimulatedFcm,
  });
});

/** Notificação base válida para um cliente. */
function baseDto(overrides = {}) {
  return {
    user_id:  'user-1',
    role:     'CLIENT',
    category: NotificationCategory.ORDER_STATUS,
    title:    'Pedido a caminho',
    body:     'O seu pedido saiu para entrega.',
    ...overrides,
  };
}

// ─── Envio ────────────────────────────────────────────────────────────────────

describe('sendNotification — caminho feliz', () => {
  it('should send and record the delivered count', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a', platform: 'android' });
    await registerDevice({ user_id: 'user-1', token: 'tok-b', platform: 'ios' });

    const n = await sendNotification(baseDto());

    expect(n.status).toBe('sent');
    expect(n.delivered_count).toBe(2);
    expect(n.failure_reason).toBeNull();
  });

  it('should carry the free-form data payload', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });

    const n = await sendNotification(baseDto({ data: { orderId: 'ord-9' } }));

    expect(n.data).toEqual({ orderId: 'ord-9' });
  });

  it('should keep a history record for every attempt', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });

    await sendNotification(baseDto());
    await sendNotification(baseDto({ title: 'Segunda' }));

    expect((await listNotifications({ user_id: 'user-1' }))).toHaveLength(2);
  });
});

describe('sendNotification — validação', () => {
  it('should require the mandatory fields', async () => {
    await expect(sendNotification({ role: 'CLIENT', category: NotificationCategory.ORDER_STATUS, title: 't', body: 'b' }))
      .rejects.toThrow(MissingRequiredFieldError);

    await expect(sendNotification(baseDto({ title: undefined })))
      .rejects.toThrow(MissingRequiredFieldError);
  });

  it('should reject an unknown category', async () => {
    await expect(sendNotification(baseDto({ category: 'INVENTADA' })))
      .rejects.toThrow(UnknownCategoryError);
  });
});

describe('sendNotification — supressão', () => {
  it('should suppress a category the user turned off', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });
    await updatePreferences('user-1', { [NotificationCategory.ORDER_STATUS]: false });

    const n = await sendNotification(baseDto());

    expect(n.status).toBe('suppressed');
    expect(n.decision.allowed).toBe(false);
    // Suprimida não é falha — o motivo fica registado
    expect(n.failure_reason).toMatch(/desligada/);
  });

  it('should suppress when the category does not apply to the role', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });

    const n = await sendNotification(baseDto({ role: 'DRIVER' }));

    expect(n.status).toBe('suppressed');
    expect(n.decision.reason).toMatch(/perfil/);
  });

  it('should still send a critical category the user turned off', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });
    await updatePreferences('user-1', { [NotificationCategory.DESTINATION_REQUEST]: false });

    const n = await sendNotification(baseDto({
      category: NotificationCategory.DESTINATION_REQUEST,
    }));

    expect(n.status).toBe('sent');
  });

  it('should not call the FCM when suppressed', async () => {
    let chamou = false;
    configurePorts({
      getFcm: () => ({ async send(r) { chamou = true; return SimulatedFcm.send(r); } }),
    });

    await registerDevice({ user_id: 'user-1', token: 'tok-a' });
    await updatePreferences('user-1', { [NotificationCategory.ORDER_STATUS]: false });
    await sendNotification(baseDto());

    expect(chamou).toBe(false);
  });
});

describe('sendNotification — sem dispositivos', () => {
  it('should fail when the user has no registered device', async () => {
    const n = await sendNotification(baseDto());

    expect(n.status).toBe('failed');
    expect(n.failure_reason).toMatch(/Nenhum dispositivo/);
  });
});

describe('sendNotification — tokens inválidos', () => {
  it('should remove tokens the FCM reported as dead', async () => {
    await registerDevice({ user_id: 'user-1', token: 'dead-1' });
    await registerDevice({ user_id: 'user-1', token: 'tok-viva' });

    const n = await sendNotification(baseDto());

    expect(n.status).toBe('sent');
    expect(n.delivered_count).toBe(1);
    // O token morto foi limpo da base
    expect(await fakeTokens.findByUser('user-1')).toEqual(['tok-viva']);
  });

  it('should fail when every token is dead, and clean them all up', async () => {
    await registerDevice({ user_id: 'user-1', token: 'dead-1' });
    await registerDevice({ user_id: 'user-1', token: 'dead-2' });

    const n = await sendNotification(baseDto());

    expect(n.status).toBe('failed');
    expect(n.delivered_count).toBe(0);
    expect(await fakeTokens.findByUser('user-1')).toEqual([]);
  });
});

describe('sendNotification — falha do FCM', () => {
  it('should fail on an FCM outage without dropping tokens', async () => {
    await registerDevice({ user_id: 'user-1', token: 'outage-1' });

    const n = await sendNotification(baseDto());

    expect(n.status).toBe('failed');
    // Uma indisponibilidade do FCM não torna o token inválido
    expect(await fakeTokens.findByUser('user-1')).toEqual(['outage-1']);
  });

  it('should fail on a network timeout', async () => {
    await registerDevice({ user_id: 'user-1', token: 'timeout-1' });

    const n = await sendNotification(baseDto());

    expect(n.status).toBe('failed');
    expect(n.failure_reason).toMatch(/Timeout/);
  });
});

// ─── Dispositivos ─────────────────────────────────────────────────────────────

describe('registerDevice', () => {
  it('should be idempotent for the same token', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });

    expect(await fakeTokens.findByUser('user-1')).toEqual(['tok-a']);
  });

  it('should move a token to a new user on re-register', async () => {
    // Mesmo telemóvel, outro login
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });
    await registerDevice({ user_id: 'user-2', token: 'tok-a' });

    expect(await fakeTokens.findByUser('user-1')).toEqual([]);
    expect(await fakeTokens.findByUser('user-2')).toEqual(['tok-a']);
  });

  it('should require user_id and token', async () => {
    await expect(registerDevice({ token: 'tok-a' })).rejects.toThrow(MissingRequiredFieldError);
    await expect(registerDevice({ user_id: 'user-1' })).rejects.toThrow(MissingRequiredFieldError);
  });
});

describe('unregisterDevice', () => {
  it('should report whether something was removed', async () => {
    await registerDevice({ user_id: 'user-1', token: 'tok-a' });

    expect(await unregisterDevice('tok-a')).toEqual({ removed: true });
    expect(await unregisterDevice('tok-a')).toEqual({ removed: false });
  });
});

// ─── Preferências ─────────────────────────────────────────────────────────────

describe('getPreferences / updatePreferences', () => {
  it('should return every category applicable to the role', async () => {
    const p = await getPreferences('user-1', 'CLIENT');

    expect(p.user_id).toBe('user-1');
    expect(p.categories.length).toBeGreaterThan(0);
    expect(p.categories.every((c) => typeof c.enabled === 'boolean')).toBe(true);
  });

  it('should persist a change and reflect it on read', async () => {
    await updatePreferences('user-1', { [NotificationCategory.PAYMENT]: false });

    const p = await getPreferences('user-1', 'CLIENT');
    const pagamento = p.categories.find((c) => c.category === NotificationCategory.PAYMENT);

    expect(pagamento.enabled).toBe(false);
  });

  it('should require a role to resolve segmentation', async () => {
    await expect(getPreferences('user-1', undefined)).rejects.toThrow(MissingRequiredFieldError);
  });

  it('should reject a non-object payload', async () => {
    await expect(updatePreferences('user-1', 'nada')).rejects.toThrow(MissingRequiredFieldError);
  });
});
