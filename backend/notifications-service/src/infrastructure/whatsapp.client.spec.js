/**
 * @file whatsapp.client.spec.js
 * @description Testes do adaptador de WhatsApp (Cloud API da Meta).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3
 *
 * Sem rede: o `fetch` é substituído por um duplo. O que se prova é o que
 * distingue um canal que funciona de um que responde "enviado" e não entrega
 * nada — o formato do número, o uso de template fora da janela de 24 horas, e a
 * tradução dos erros da Meta para algo acionável.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizePhone, buildPayload, describeError,
  SimulatedWhatsApp, RealWhatsApp, getWhatsAppClient, isSimulated,
} = require('./whatsapp.client.js');

const ENV_ORIGINAL = { ...process.env };

/** Liga o modo real com credenciais de teste. */
function comCredenciais() {
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'token-de-teste';
}

/** Duplo do fetch que devolve uma resposta controlada. */
function fetchQueDevolve(status, body) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
});

afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
  vi.restoreAllMocks();
});

describe('WhatsApp · número de destino', () => {
  it('should strip everything the Cloud API refuses', () => {
    // "+258 84 123 4567" é como as pessoas escrevem; a Meta recusa.
    expect(normalizePhone('+258 84 123 4567')).toBe('258841234567');
    expect(normalizePhone('(258) 84-1234567')).toBe('258841234567');
  });

  it('should add the country code to a local number', () => {
    // Sem indicativo, a Meta interpreta-o como outro país e a mensagem some-se.
    expect(normalizePhone('841234567', '258')).toBe('258841234567');
  });

  it('should keep a number that already has its country code', () => {
    expect(normalizePhone('258841234567', '258')).toBe('258841234567');
  });

  it('should refuse what is not a phone number, instead of sending rubbish', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('1234567890123456789')).toBeNull();
  });
});

describe('WhatsApp · corpo da mensagem', () => {
  it('should build a template message by default', () => {
    // Texto livre fora da janela de 24 horas é recusado com 131047, e uma
    // notificação de logística está quase sempre fora dela.
    const payload = buildPayload({ to: '258841234567', message: 'A sua encomenda saiu para entrega' });

    expect(payload.type).toBe('template');
    expect(payload.messaging_product).toBe('whatsapp');
    expect(payload.template.components[0].parameters[0].text).toContain('saiu para entrega');
  });

  it('should send free text only when explicitly asked', () => {
    const payload = buildPayload({ to: '258841234567', message: 'Olá', freeText: true });

    expect(payload.type).toBe('text');
    expect(payload.text.body).toBe('Olá');
  });

  it('should place template variables in order', () => {
    const payload = buildPayload({
      to: '258841234567', message: 'ignorado',
      variables: ['TRK123', 'hoje às 14h'],
    });

    expect(payload.template.components[0].parameters.map((p) => p.text))
      .toEqual(['TRK123', 'hoje às 14h']);
  });

  it('should give null for an unusable number, before touching the network', () => {
    expect(buildPayload({ to: 'não é número', message: 'x' })).toBeNull();
  });
});

describe('WhatsApp · erros da Meta traduzidos', () => {
  it('should explain the 24-hour window instead of repeating the raw message', () => {
    // A mensagem da Meta fala de "re-engagement" e não de templates; quem lê o
    // log não percebe porque é que "enviou" e não chegou.
    const texto = describeError({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
    expect(texto).toMatch(/janela de 24 horas/i);
    expect(texto).toMatch(/template/i);
  });

  it('should name an unapproved template', () => {
    expect(describeError({ error: { code: 132001 } }, 400)).toMatch(/não está aprovado/i);
  });

  it('should name an expired token', () => {
    expect(describeError({ error: { code: 190 } }, 401)).toMatch(/token/i);
  });

  it('should name a destination without WhatsApp', () => {
    expect(describeError({ error: { code: 131026 } }, 400)).toMatch(/não tem conta WhatsApp/i);
  });

  it('should fall back to the provider message for an unknown code', () => {
    expect(describeError({ error: { code: 999, message: 'Algo novo' } }, 500)).toContain('Algo novo');
  });
});

describe('WhatsApp · escolha do cliente', () => {
  it('should be simulated without credentials', () => {
    expect(isSimulated()).toBe(true);
    expect(getWhatsAppClient().provider).toBe('SIMULATED');
  });

  it('should go real once both credentials are present', () => {
    comCredenciais();
    expect(isSimulated()).toBe(false);
    expect(getWhatsAppClient().provider).toBe('META_CLOUD');
  });

  it('should stay simulated with only half the credentials', () => {
    // Metade das credenciais é um deploy a meio; mandar para a Meta sem token
    // dava um 401 por mensagem em vez de um estado claro.
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    expect(isSimulated()).toBe(true);
  });
});

describe('WhatsApp · envio simulado', () => {
  it('should accept a valid number deterministically', async () => {
    const r = await SimulatedWhatsApp.send({ to: '258841234561', message: 'olá' });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('SIMULATED');
  });

  it('should fail on a number ending in zero, like the SMS double', async () => {
    const r = await SimulatedWhatsApp.send({ to: '258841234560', message: 'olá' });
    expect(r.ok).toBe(false);
  });

  it('should refuse an invalid number', async () => {
    const r = await SimulatedWhatsApp.send({ to: 'xyz', message: 'olá' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/inválido/i);
  });
});

describe('WhatsApp · envio real (com duplo de rede)', () => {
  it('should return the provider message id on success', async () => {
    comCredenciais();
    global.fetch = fetchQueDevolve(200, { messages: [{ id: 'wamid.ABC' }] });

    const r = await RealWhatsApp.send({ to: '258841234567', message: 'A sua encomenda saiu' });

    expect(r.ok).toBe(true);
    expect(r.providerMessageId).toBe('wamid.ABC');
  });

  it('should post to the configured phone number id with a bearer token', async () => {
    comCredenciais();
    global.fetch = fetchQueDevolve(200, { messages: [{ id: 'x' }] });

    await RealWhatsApp.send({ to: '258841234567', message: 'olá' });

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/1234567890/messages');
    expect(opts.headers.Authorization).toBe('Bearer token-de-teste');
    expect(JSON.parse(opts.body).to).toBe('258841234567');
  });

  it('should translate a rejection instead of leaking the raw payload', async () => {
    comCredenciais();
    global.fetch = fetchQueDevolve(400, { error: { code: 131047, message: 'Re-engagement message' } });

    const r = await RealWhatsApp.send({ to: '258841234567', message: 'olá', freeText: true });

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/janela de 24 horas/i);
  });

  it('should never throw when the network fails', async () => {
    // O messaging.service trata isto best-effort: uma falha de rede não pode
    // derrubar a entrega que provocou a notificação.
    comCredenciais();
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const r = await RealWhatsApp.send({ to: '258841234567', message: 'olá' });

    expect(r.ok).toBe(false);
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('should not call the network at all for an invalid number', async () => {
    comCredenciais();
    global.fetch = fetchQueDevolve(200, {});

    const r = await RealWhatsApp.send({ to: 'abc', message: 'olá' });

    expect(r.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
