/**
 * @file messaging.service.spec.js
 * @description Testes do envio de SMS/email ao cliente (best-effort).
 *
 * Repo e clientes SMS/email substituídos por duplos via `configurePorts`; os
 * dados de registo vêm da factory do harness. Prova: envia nos dois canais quando
 * há contactos; salta o canal sem destinatário; regista cada envio; e uma falha
 * de canal NÃO interrompe (best-effort, nunca lança).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { OutboundMessageFactory } from '../../../../tests/harness/factories/messaging.factory';

const require = createRequire(import.meta.url);
const service = require('./messaging.service.js');
const { sendClientMessage, configurePorts, resetPorts } = service;

/** Regista o que foi persistido. */
const recorded = [];

const fakeRepo = {
  async create(msg) { recorded.push(msg); return msg; },
};

function okClient(status = 'sent') {
  return { send: vi.fn(async () => ({ ok: true, status, provider: 'FAKE', providerMessageId: 'fake-1', message: 'ok' })) };
}
function failingClient() {
  return { send: vi.fn(async () => ({ ok: false, status: 'failed', provider: 'FAKE', message: 'recusado' })) };
}
function throwingClient() {
  return { send: vi.fn(async () => { throw new Error('boom rede'); }) };
}

describe('messaging.service · sendClientMessage', () => {
  beforeEach(() => {
    recorded.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => resetPorts());

  it('should send SMS and email when both contacts are present', async () => {
    const sms = okClient(); const email = okClient();
    configurePorts({ repo: fakeRepo, getSms: () => sms, getEmail: () => email });

    const { results } = await sendClientMessage({
      to_phone: '+258841111111', to_email: 'ana@exemplo.mz',
      subject: 'Recebida', body: 'Recebemos a sua encomenda no armazém.',
      order_id: 'o1', tracking_code: 'TRK1',
    });

    expect(sms.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    expect(recorded.map((m) => m.channel).sort()).toEqual(['email', 'sms']);
    expect(recorded.find((m) => m.channel === 'sms').recipient).toBe('+258841111111');
  });

  it('should skip a channel without a recipient', async () => {
    const sms = okClient(); const email = okClient();
    configurePorts({ repo: fakeRepo, getSms: () => sms, getEmail: () => email });

    const { results } = await sendClientMessage({ to_phone: '+258842222222', body: 'Olá' }); // sem email

    expect(sms.send).toHaveBeenCalledOnce();
    expect(email.send).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('should record a failed send without throwing', async () => {
    configurePorts({ repo: fakeRepo, getSms: () => failingClient(), getEmail: () => okClient() });

    const { results } = await sendClientMessage({ to_phone: '+258840000000', to_email: 'x@y.mz', body: 'Olá' });

    const sms = recorded.find((m) => m.channel === 'sms');
    expect(sms.status).toBe('failed');
    expect(sms.error).toBe('recusado');
    expect(results).toHaveLength(2); // ambos registados, apesar da falha do SMS
  });

  it('should be best-effort when a client throws (never propagates)', async () => {
    configurePorts({ repo: fakeRepo, getSms: () => throwingClient(), getEmail: () => okClient() });

    await expect(sendClientMessage({ to_phone: '+258843333333', to_email: 'x@y.mz', body: 'Olá' }))
      .resolves.toBeTruthy();

    const sms = recorded.find((m) => m.channel === 'sms');
    expect(sms.status).toBe('failed');
  });

  it('should not send when the body is empty', async () => {
    const sms = okClient();
    configurePorts({ repo: fakeRepo, getSms: () => sms });
    const { results } = await sendClientMessage({ to_phone: '+258844444444', body: '   ' });
    expect(sms.send).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
  });

  it('factory produces valid outbound rows', () => {
    const m = OutboundMessageFactory.buildEmail();
    expect(m.channel).toBe('email');
    expect(m.recipient).toContain('@');
  });
});
