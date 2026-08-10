/**
 * @file email.client.spec.js
 * @description Contrato do adaptador Resend para email transacional.
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3, § 4.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { OutboundMessageFactory } from '../../../../tests/harness/factories/messaging.factory';

const require = createRequire(import.meta.url);
const { getEmailClient, isSimulated } = require('./email.client.js');

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('email.client · Resend', () => {
  it('should remain simulated without provider credentials', () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_API_URL;
    delete process.env.EMAIL_API_KEY;

    expect(isSimulated()).toBe(true);
    expect(getEmailClient().provider).toBe('SIMULATED');
  });

  it('should send the canonical message through the Resend API', async () => {
    const message = OutboundMessageFactory.buildEmail();
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'SistemaTrack <notificacoes@example.com>';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: message.provider_message_id }),
    });

    const result = await getEmailClient().send({
      to: message.recipient,
      subject: message.subject,
      body: message.body,
    });

    expect(result).toMatchObject({ ok: true, status: 'sent', provider: 'RESEND' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ method: 'POST' }));
    const request = fetchMock.mock.calls[0][1];
    const payload = JSON.parse(request.body);
    expect(payload).toMatchObject({
      from: process.env.EMAIL_FROM,
      to: [message.recipient],
      subject: message.subject,
      text: message.body,
    });
  });

  it('should return a failed result when Resend rejects the request', async () => {
    const message = OutboundMessageFactory.buildEmail();
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'SistemaTrack <notificacoes@example.com>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: 'validation_error' }),
    });

    await expect(getEmailClient().send({
      to: message.recipient,
      subject: message.subject,
      body: message.body,
    })).resolves.toMatchObject({ ok: false, status: 'failed', provider: 'RESEND' });
  });
});
