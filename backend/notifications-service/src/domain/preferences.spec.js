/**
 * @file preferences.spec.js
 * @description Testes da resolução de preferências de notificação.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * É aqui que um erro se traduz em clientes a não receber avisos que pediram, ou
 * a receber os que recusaram — por isso a ordem de decisão é exercitada regra a
 * regra, e não só no caminho feliz.
 */
import { describe, it, expect } from 'vitest';
import preferences from './preferences.js';
import entity from './notification.entity.js';

const {
  DecisionReason,
  defaultPreferences,
  normalizePreferences,
  shouldSend,
  listPreferencesForRole,
} = preferences;

const { NotificationCategory } = entity;

describe('defaultPreferences', () => {
  it('should enable every category (opt-out model)', () => {
    const prefs = defaultPreferences();

    expect(Object.values(prefs).every((v) => v === true)).toBe(true);
    expect(Object.keys(prefs)).toContain(NotificationCategory.ORDER_STATUS);
  });
});

describe('normalizePreferences', () => {
  it('should fall back to defaults for null or malformed input', () => {
    expect(normalizePreferences(null)).toEqual(defaultPreferences());
    expect(normalizePreferences('nada')).toEqual(defaultPreferences());
    expect(normalizePreferences(undefined)).toEqual(defaultPreferences());
  });

  it('should keep known categories', () => {
    const prefs = normalizePreferences({ [NotificationCategory.PAYMENT]: false });
    expect(prefs[NotificationCategory.PAYMENT]).toBe(false);
  });

  it('should discard unknown categories', () => {
    // Um cliente antigo pode enviar uma chave que já não existe
    const prefs = normalizePreferences({ CATEGORIA_ANTIGA: false });
    expect(prefs.CATEGORIA_ANTIGA).toBeUndefined();
  });

  it('should ignore non-boolean values', () => {
    const prefs = normalizePreferences({ [NotificationCategory.PAYMENT]: 'não' });
    // Valor inválido não deve silenciar a categoria
    expect(prefs[NotificationCategory.PAYMENT]).toBe(true);
  });
});

describe('shouldSend — segmentação por perfil', () => {
  it('should send an order status notification to a CLIENT', () => {
    const d = shouldSend({ category: NotificationCategory.ORDER_STATUS, role: 'CLIENT' });
    expect(d.allowed).toBe(true);
  });

  it('should not send an order status notification to a DRIVER', () => {
    const d = shouldSend({ category: NotificationCategory.ORDER_STATUS, role: 'DRIVER' });

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DecisionReason.BLOCKED_WRONG_ROLE);
  });

  it('should send a route assignment to a DRIVER but not to a CLIENT', () => {
    expect(shouldSend({ category: NotificationCategory.ROUTE_ASSIGNED, role: 'DRIVER' }).allowed).toBe(true);
    expect(shouldSend({ category: NotificationCategory.ROUTE_ASSIGNED, role: 'CLIENT' }).allowed).toBe(false);
  });

  it('should send a delivery issue to every role it targets', () => {
    for (const role of ['CLIENT', 'DRIVER', 'SUPPORT']) {
      expect(shouldSend({ category: NotificationCategory.DELIVERY_ISSUE, role }).allowed).toBe(true);
    }
  });
});

describe('shouldSend — preferências do utilizador', () => {
  it('should respect a category the user turned off', () => {
    const d = shouldSend(
      { category: NotificationCategory.PAYMENT, role: 'CLIENT' },
      { [NotificationCategory.PAYMENT]: false },
    );

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DecisionReason.BLOCKED_BY_PREFERENCE);
  });

  it('should respect a category the user turned on explicitly', () => {
    const d = shouldSend(
      { category: NotificationCategory.PAYMENT, role: 'CLIENT' },
      { [NotificationCategory.PAYMENT]: true },
    );

    expect(d.allowed).toBe(true);
    expect(d.reason).toBe(DecisionReason.ALLOWED_BY_PREFERENCE);
  });

  it('should default to sending when the user never expressed a preference', () => {
    const d = shouldSend(
      { category: NotificationCategory.PAYMENT, role: 'CLIENT' },
      { [NotificationCategory.ORDER_STATUS]: false }, // outra categoria
    );

    expect(d.allowed).toBe(true);
    expect(d.reason).toBe(DecisionReason.ALLOWED_BY_DEFAULT);
  });

  it('should not let one disabled category silence another', () => {
    const prefs = { [NotificationCategory.ORDER_STATUS]: false };

    expect(shouldSend({ category: NotificationCategory.ORDER_STATUS, role: 'CLIENT' }, prefs).allowed).toBe(false);
    expect(shouldSend({ category: NotificationCategory.PAYMENT, role: 'CLIENT' }, prefs).allowed).toBe(true);
  });
});

describe('shouldSend — categorias críticas', () => {
  it('should send a destination request even when turned off', () => {
    // Spec § 8.2: sem esta notificação o pedido fica em hold
    const d = shouldSend(
      { category: NotificationCategory.DESTINATION_REQUEST, role: 'CLIENT' },
      { [NotificationCategory.DESTINATION_REQUEST]: false },
    );

    expect(d.allowed).toBe(true);
    expect(d.reason).toBe(DecisionReason.ALLOWED_CRITICAL);
  });

  it('should send a route assignment even when turned off', () => {
    const d = shouldSend(
      { category: NotificationCategory.ROUTE_ASSIGNED, role: 'DRIVER' },
      { [NotificationCategory.ROUTE_ASSIGNED]: false },
    );

    expect(d.allowed).toBe(true);
    expect(d.reason).toBe(DecisionReason.ALLOWED_CRITICAL);
  });

  it('should still respect role segmentation for critical categories', () => {
    // Crítica não significa "envia a toda a gente"
    const d = shouldSend({ category: NotificationCategory.ROUTE_ASSIGNED, role: 'CLIENT' });

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DecisionReason.BLOCKED_WRONG_ROLE);
  });
});

describe('shouldSend — categoria desconhecida', () => {
  it('should fail closed', () => {
    const d = shouldSend({ category: 'INVENTADA', role: 'CLIENT' });

    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DecisionReason.BLOCKED_UNKNOWN);
  });
});

describe('listPreferencesForRole', () => {
  it('should only list categories that apply to the role', () => {
    const doCliente = listPreferencesForRole('CLIENT');
    const categorias = doCliente.map((c) => c.category);

    expect(categorias).toContain(NotificationCategory.ORDER_STATUS);
    expect(categorias).not.toContain(NotificationCategory.ROUTE_ASSIGNED);
  });

  it('should mark critical categories as locked and enabled', () => {
    const doCliente = listPreferencesForRole('CLIENT', {
      [NotificationCategory.DESTINATION_REQUEST]: false,
    });

    const destino = doCliente.find(
      (c) => c.category === NotificationCategory.DESTINATION_REQUEST,
    );

    // Mesmo tendo sido desligada, aparece ligada e bloqueada
    expect(destino.locked).toBe(true);
    expect(destino.enabled).toBe(true);
  });

  it('should reflect the stored state of configurable categories', () => {
    const doCliente = listPreferencesForRole('CLIENT', {
      [NotificationCategory.PAYMENT]: false,
    });

    const pagamento = doCliente.find((c) => c.category === NotificationCategory.PAYMENT);

    expect(pagamento.locked).toBe(false);
    expect(pagamento.enabled).toBe(false);
  });

  it('should include a human label for every category', () => {
    for (const c of listPreferencesForRole('DRIVER')) {
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});
