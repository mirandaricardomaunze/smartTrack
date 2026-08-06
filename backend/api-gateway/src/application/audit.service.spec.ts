/**
 * @file audit.service.spec.ts
 * @description Testes unitários do núcleo do registo de auditoria.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.21 (Registo de auditoria)
 *
 * Prova, sem base de dados, o que dá valor ao registo: os segredos nunca entram,
 * a ação deriva corretamente da rota, o estado reflete o código HTTP, e a cadeia
 * deteta tanto uma alteração como um evento apagado. Dados via factories.
 */
import { describe, expect, it } from 'vitest';
import { AuditEventFactory, AuditChainFactory } from '../../../../tests/harness';

const {
  redact, packMetadata, deriveAction, outcomeFromStatus, describe: summarize,
  canonicalize, signEvent, verifyChain, GENESIS_HASH, Outcome,
} = require('./audit.service');

describe('Auditoria · dados sensíveis', () => {
  it('should never store a password, even nested', () => {
    const clean = redact({ email: 'a@b.mz', password: 'segredo', user: { password_hash: 'x', name: 'Ana' } });

    expect(clean.password).toBe('[oculto]');
    expect(clean.user.password_hash).toBe('[oculto]');
    expect(clean.user.name).toBe('Ana');
    expect(clean.email).toBe('a@b.mz');
  });

  it.each(['token', 'authorization', 'secret', 'signature', 'photo', 'otp', 'msisdn'])(
    'should hide %s', (key) => {
      expect(redact({ [key]: 'valor' })[key]).toBe('[oculto]');
    },
  );

  it('should cut long strings instead of storing walls of text', () => {
    const clean = redact({ notes: 'x'.repeat(900) });
    expect(clean.notes.length).toBeLessThan(520);
    expect(clean.notes.endsWith('…')).toBe(true);
  });

  it('should stop at a sane depth instead of walking a huge object', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'fundo' } } } } } };
    expect(JSON.stringify(redact(deep))).toContain('profundo');
  });

  it('should truncate metadata that exceeds the ceiling', () => {
    const packed = packMetadata({ items: Array.from({ length: 500 }, (_, i) => `linha ${i} com texto suficiente`) });
    expect(JSON.stringify(packed).length).toBeLessThan(6000);
  });

  it('should drop null and undefined instead of storing noise', () => {
    expect(redact({ a: null, b: undefined, c: 1 })).toEqual({ c: 1 });
  });
});

describe('Auditoria · ação derivada da rota', () => {
  it.each([
    ['POST', '/v1/orders', 'orders.create'],
    ['PUT', '/v1/orders/order-1', 'orders.update'],
    ['DELETE', '/v1/clients/client-1', 'clients.delete'],
    ['POST', '/v1/invoices/inv-1/void', 'invoices.void'],
    ['POST', '/v1/invoices/inv-1/credit-note', 'invoices.credit_note'],
    ['POST', '/v1/subscriptions/me/plan', 'subscriptions.plan'],
    ['POST', '/v1/hr/leaves/leave-1/decision', 'hr.decision'],
    ['POST', '/v1/companies/company-1/status', 'companies.status'],
  ])('should map %s %s to %s', (method, path, expected) => {
    expect(deriveAction(method, path)).toBe(expected);
  });

  it('should ignore the query string', () => {
    expect(deriveAction('POST', '/v1/orders?page=2')).toBe('orders.create');
  });

  it('should survive an unexpected path', () => {
    expect(deriveAction('POST', '/')).toBe('http.request');
  });
});

describe('Auditoria · estado do evento', () => {
  it.each([
    [200, Outcome.SUCCESS],
    [201, Outcome.SUCCESS],
    [401, Outcome.DENIED],
    [402, Outcome.DENIED],
    [403, Outcome.DENIED],
    [404, Outcome.ERROR],
    [409, Outcome.ERROR],
    [500, Outcome.ERROR],
  ])('should read %i as %s', (status, expected) => {
    expect(outcomeFromStatus(status)).toBe(expected);
  });

  it('should write a readable sentence for an automatic capture', () => {
    expect(summarize({ action: 'orders.create', actorEmail: 'ana@x.mz', outcome: Outcome.DENIED, statusCode: 403 }))
      .toBe('ana@x.mz: orders.create — sem permissão');
    expect(summarize({ action: 'orders.create', outcome: Outcome.SUCCESS, statusCode: 201 }))
      .toContain('visitante');
  });
});

describe('Auditoria · assinatura e cadeia', () => {
  const event = AuditEventFactory.build();

  it('should be deterministic for the same content', () => {
    expect(signEvent(event)).toBe(signEvent(event));
  });

  it('should include the fields that matter in the canonical text', () => {
    const canonical = canonicalize(event);
    expect(canonical).toContain(event.action);
    expect(canonical).toContain(event.company_id);
    expect(canonical).toContain(event.previous_hash);
  });

  it.each(['action', 'actor_id', 'entity_id', 'outcome'])('should change when %s is tampered with', (field) => {
    expect(signEvent({ ...event, [field]: 'outro-valor' })).not.toBe(signEvent(event));
  });

  it('should validate a well-formed chain', () => {
    const chain = AuditChainFactory.build(signEvent, 5);
    expect(verifyChain(chain)).toMatchObject({ ok: true, checked: 5, broken: [], gaps: [] });
  });

  it('should start the chain from the genesis value', () => {
    expect(AuditChainFactory.build(signEvent, 1)[0].previous_hash).toBe(GENESIS_HASH);
  });

  it('should catch an event edited in place', () => {
    const chain = AuditChainFactory.build(signEvent, 4);
    chain[2].summary = 'alguém reescreveu isto';
    chain[2].action = 'orders.delete';       // o campo assinado

    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.broken[0]).toMatchObject({ seq: 3 });
    expect(result.broken[0].reason).toMatch(/não corresponde/i);
  });

  it('should catch an event deleted from the middle', () => {
    const chain = AuditChainFactory.build(signEvent, 4);
    const withHole = [chain[0], chain[1], chain[3]];

    const result = verifyChain(withHole);
    expect(result.ok).toBe(false);
    expect(result.gaps).toEqual([{ expected: 3, found: 4 }]);
  });

  it('should report an empty chain as healthy', () => {
    expect(verifyChain([])).toMatchObject({ ok: true, checked: 0 });
  });
});
