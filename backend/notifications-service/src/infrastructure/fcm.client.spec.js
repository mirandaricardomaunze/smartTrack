/**
 * @file fcm.client.spec.js
 * @description Contrato do adaptador FCM (API HTTP v1) para notificações push.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3, § 4
 *
 * O que estes testes protegem: que o canal continua simulado sem credenciais, e
 * que — com elas — um token morto é devolvido para limpeza enquanto uma falha
 * passageira NÃO é. Confundir as duas apaga dispositivos bons da base.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { PushFactory } from '../../../../tests/harness/factories/push.factory';

const require = createRequire(import.meta.url);
const { getFcmClient, isSimulated, resetAccessToken, buildAssertion, isDeadToken, EmptyTokenListError } = require('./fcm.client.js');

const ORIGINAL_ENV = { ...process.env };
const FCM_URL = 'https://fcm.googleapis.com/v1/projects/sistematrack-test/messages:send';
const OAUTH_URL = 'https://oauth2.googleapis.com/token';

/** Instala credenciais válidas e devolve um fetch que responde ao OAuth e ao FCM. */
function withCredentials(fcmResponder) {
  Object.assign(process.env, PushFactory.buildCredentials());
  resetAccessToken();
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) === OAUTH_URL) {
      return { ok: true, status: 200, json: async () => PushFactory.buildTokenResponse() };
    }
    return fcmResponder(String(url));
  });
}

const okResponse = () => ({ ok: true, status: 200, json: async () => ({ name: 'projects/x/messages/1' }) });

beforeEach(() => { resetAccessToken(); });

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetAccessToken();
  vi.restoreAllMocks();
});

describe('fcm.client · seleção do adaptador', () => {
  it('should stay simulated without credentials', () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;

    expect(isSimulated()).toBe(true);
    expect(getFcmClient().name).toBe('SIMULATED');
  });

  it('should stay simulated when only part of the credentials is present', () => {
    const creds = PushFactory.buildCredentials();
    process.env.FIREBASE_PROJECT_ID = creds.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;

    // Meia credencial é pior do que nenhuma: falharia em produção sem aviso.
    expect(isSimulated()).toBe(true);
  });

  it('should switch to the real adapter once all three are set', () => {
    Object.assign(process.env, PushFactory.buildCredentials());

    expect(isSimulated()).toBe(false);
    expect(getFcmClient().name).toBe('FCM');
  });
});

describe('fcm.client · autenticação', () => {
  it('should sign a service-account JWT with the escaped .env key', () => {
    Object.assign(process.env, PushFactory.buildCredentials());

    const [header, claims, signature] = buildAssertion(1_700_000_000).split('.');
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
    const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString());

    expect(decodedHeader).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodedClaims.iss).toBe(process.env.FIREBASE_CLIENT_EMAIL);
    expect(decodedClaims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(decodedClaims.exp - decodedClaims.iat).toBe(3600);
    expect(signature.length).toBeGreaterThan(0);
  });

  it('should reuse the access token instead of re-authenticating per push', async () => {
    const fetchMock = withCredentials(okResponse);
    const client = getFcmClient();

    await client.send(PushFactory.build());
    await client.send(PushFactory.build());

    const oauthCalls = fetchMock.mock.calls.filter(([url]) => String(url) === OAUTH_URL);
    expect(oauthCalls).toHaveLength(1);
  });

  it('should report unavailable — and keep every token — when credentials are refused', async () => {
    Object.assign(process.env, PushFactory.buildCredentials());
    resetAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }),
    });

    const result = await getFcmClient().send(PushFactory.buildMulticast(3));

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(3);
    // O problema é a nossa configuração; os dispositivos não têm culpa nenhuma.
    expect(result.invalidTokens).toEqual([]);
    expect(result.message).toContain('invalid_grant');
  });
});

describe('fcm.client · envio', () => {
  it('should refuse an empty token list in both adapters', async () => {
    Object.assign(process.env, PushFactory.buildCredentials());
    await expect(getFcmClient().send({ tokens: [], title: 't', body: 'b' })).rejects.toBeInstanceOf(EmptyTokenListError);

    delete process.env.FIREBASE_PROJECT_ID;
    await expect(getFcmClient().send({ tokens: [], title: 't', body: 'b' })).rejects.toBeInstanceOf(EmptyTokenListError);
  });

  it('should post one message per token to the v1 endpoint', async () => {
    const fetchMock = withCredentials(okResponse);
    const req = PushFactory.buildMulticast(3);

    const result = await getFcmClient().send(req);

    const sends = fetchMock.mock.calls.filter(([url]) => String(url) === FCM_URL);
    expect(sends).toHaveLength(3);
    expect(result).toMatchObject({ httpCode: 200, successCount: 3, failureCount: 0, invalidTokens: [] });

    const payload = JSON.parse(sends[0][1].body);
    expect(payload.message).toMatchObject({
      token: req.tokens[0],
      notification: { title: req.title, body: req.body },
    });
  });

  it('should stringify the data payload — FCM rejects anything else', async () => {
    const fetchMock = withCredentials(okResponse);

    await getFcmClient().send(PushFactory.buildWithData());

    const send = fetchMock.mock.calls.find(([url]) => String(url) === FCM_URL);
    expect(JSON.parse(send[1].body).message.data).toEqual({
      order_id: '42', tracking_code: 'TRK-PUSH-0042', delivered: 'false',
    });
  });
});

describe('fcm.client · tokens mortos', () => {
  it.each(PushFactory.deadTokenCases())('should mark for removal on $label', ({ status, payload }) => {
    expect(isDeadToken(status, payload)).toBe(true);
  });

  it.each(PushFactory.survivableErrorCases())('should NOT mark for removal on $label', ({ status, payload }) => {
    expect(isDeadToken(status, payload)).toBe(false);
  });

  it('should return only the dead tokens while delivering to the healthy ones', async () => {
    const req = PushFactory.buildMulticast(3);
    const dead = req.tokens[1];
    withCredentials((url) => url);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === OAUTH_URL) return { ok: true, status: 200, json: async () => PushFactory.buildTokenResponse() };
      const sent = JSON.parse(init.body).message.token;
      if (sent === dead) {
        return { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) };
      }
      return okResponse();
    });

    const result = await getFcmClient().send(req);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.invalidTokens).toEqual([dead]);
    expect(result.message).toContain('1 token(s) a remover');
  });

  it('should keep the token when the network drops', async () => {
    withCredentials(() => { throw new Error('socket hang up'); });

    const result = await getFcmClient().send(PushFactory.build());

    expect(result.successCount).toBe(0);
    expect(result.invalidTokens).toEqual([]);
    expect(result.httpCode).toBeNull();
  });
});
