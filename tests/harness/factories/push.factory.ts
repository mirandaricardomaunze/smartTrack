/**
 * @file push.factory.ts
 * @description Test factory para notificações push via Firebase Cloud Messaging.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3, § 4
 *
 * As credenciais são geradas na hora, com um par RSA real: o adaptador assina um
 * JWT de service account e um teste com uma chave falsa não provaria nada — o
 * `crypto.createSign` recusaria o PEM antes de chegar à lógica que interessa.
 *
 * REGRA: nunca criar dados de teste inline nos .spec — usar sempre estas factories.
 */
import { generateKeyPairSync } from 'node:crypto';

export interface TestFirebaseCredentials {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
}

export interface TestPushRequest {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Gerar RSA é caro; uma vez por processo de teste chega. */
let _cachedKey: string | null = null;

function privateKeyPem(): string {
  if (_cachedKey) return _cachedKey;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  _cachedKey = privateKey as string;
  return _cachedKey;
}

let _counter = 1;

export class PushFactory {
  /**
   * Credenciais válidas de service account, com a chave já escapada como sai de
   * um ficheiro .env — é essa a forma que o adaptador tem de saber desfazer.
   */
  static buildCredentials(overrides: Partial<TestFirebaseCredentials> = {}): TestFirebaseCredentials {
    return {
      FIREBASE_PROJECT_ID:   'sistematrack-test',
      FIREBASE_CLIENT_EMAIL: 'push@sistematrack-test.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY:  privateKeyPem().replace(/\n/g, '\\n'),
      ...overrides,
    };
  }

  /** Envio normal: um dispositivo, título e corpo. */
  static build(overrides: Partial<TestPushRequest> = {}): TestPushRequest {
    const n = _counter++;
    return {
      tokens: [`tok-live-${n}`],
      title:  'Encomenda a caminho',
      body:   `A encomenda TRK-PUSH-${n} saiu para entrega.`,
      data:   undefined,
      ...overrides,
    };
  }

  /** Envio para vários dispositivos do mesmo utilizador. */
  static buildMulticast(count = 3, overrides: Partial<TestPushRequest> = {}): TestPushRequest {
    return this.build({
      tokens: Array.from({ length: count }, (_, i) => `tok-live-${i + 1}`),
      ...overrides,
    });
  }

  /**
   * Payload `data` com valores não-string. O FCM só aceita strings e recusa o
   * resto com 400 — o adaptador tem de converter antes de enviar.
   */
  static buildWithData(overrides: Partial<TestPushRequest> = {}): TestPushRequest {
    return this.build({
      data: { order_id: 42, tracking_code: 'TRK-PUSH-0042', delivered: false },
      ...overrides,
    });
  }

  /** Resposta de sucesso da troca de JWT por access token. */
  static buildTokenResponse(overrides: Record<string, unknown> = {}) {
    return { access_token: 'ya29.test-access-token', expires_in: 3599, token_type: 'Bearer', ...overrides };
  }

  /**
   * Erros do FCM que significam "este token morreu" — e os que NÃO significam.
   * A distinção é o que separa limpar a base de perder dispositivos bons.
   */
  static deadTokenCases(): Array<{ label: string; status: number; payload: unknown }> {
    return [
      { label: 'app desinstalada (404)', status: 404, payload: { error: { status: 'NOT_FOUND' } } },
      { label: 'token não registado',    status: 400, payload: { error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } } },
      { label: 'token malformado',       status: 400, payload: { error: { status: 'INVALID_ARGUMENT' } } },
    ];
  }

  static survivableErrorCases(): Array<{ label: string; status: number; payload: unknown }> {
    return [
      { label: 'FCM em baixo (503)',      status: 503, payload: { error: { status: 'UNAVAILABLE' } } },
      { label: 'limite excedido (429)',   status: 429, payload: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      { label: 'erro interno (500)',      status: 500, payload: { error: { status: 'INTERNAL' } } },
    ];
  }
}
