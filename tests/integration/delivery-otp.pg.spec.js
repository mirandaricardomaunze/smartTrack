/**
 * @file delivery-otp.pg.spec.js
 * @description Testes de integração do código de entrega (OTP) por SMS.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1, § 3.3
 *
 * Prova, contra a base real (`track`): emitir o OTP grava o hash no pedido e envia
 * o código por SMS; a entrega exige o código correto (código errado/expirado/
 * ausente são rejeitados); e um pedido sem OTP entrega normalmente. Dados via factories.
 *
 * Pré-requisitos: PostgreSQL a atender + migrações do gateway e do notifications-service.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { OrderFactory } from '../harness/factories/order.factory';
import { DeliveryOtpFactory, KNOWN_OTP_CODE } from '../harness/factories/otp.factory';

const require = createRequire(import.meta.url);
const { ROOT, useDatabase, isPostgresReachable } = require('./helpers/pg-env.js');

useDatabase('track');
const disponivel = await isPostgresReachable();

const orders = disponivel ? require(`${ROOT}/backend/api-gateway/src/application/orders.service`) : null;
const repo = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/pg.repository`).OrderRepository : null;
const outboundRepo = disponivel ? require(`${ROOT}/backend/notifications-service/src/infrastructure/pg.repository`).OutboundMessageRepository : null;
const pool = disponivel ? require(`${ROOT}/backend/api-gateway/src/infrastructure/db`) : null;

const PHONE = '+258849888881';
const IDS = ['order-itest-otp-0001', 'order-itest-otp-0002', 'order-itest-otp-0003', 'order-itest-otp-0004', 'order-itest-otp-0005'];

async function seed(id, code, extra = {}) {
  const base = OrderFactory.buildOutForDelivery({ id, tracking_code: code, client_phone: PHONE, ...extra });
  const now = new Date().toISOString();
  await repo.create({ ...base, value: 1990, history: [{ status: 'out_for_delivery', description: 'seed', location: 'x', timestamp: now }] });
}

async function cleanup() {
  await pool.query('DELETE FROM outbound_messages WHERE order_id = ANY($1::text[])', [IDS]);
  for (const id of IDS) await pool.query('DELETE FROM orders WHERE id = $1', [id]);
}

describe.skipIf(!disponivel)('api-gateway · OTP de entrega · PostgreSQL', () => {
  beforeAll(async () => {
    await cleanup();
    await seed(IDS[0], 'TRK-ITESTOTP-0001');                                   // emite OTP real
    await seed(IDS[1], 'TRK-ITESTOTP-0002', { delivery_otp: DeliveryOtpFactory.build() });        // OTP válido conhecido
    await seed(IDS[2], 'TRK-ITESTOTP-0003', { delivery_otp: DeliveryOtpFactory.buildExpired() }); // OTP expirado
    await seed(IDS[3], 'TRK-ITESTOTP-0004');                                   // sem OTP
    // IDS[4]: sem telefone (para NoContactForOtpError)
    const base = OrderFactory.buildOutForDelivery({ id: IDS[4], tracking_code: 'TRK-ITESTOTP-0005' });
    await repo.create({ ...base, client_phone: undefined, value: 1990, history: [{ status: 'out_for_delivery', description: 'seed', location: 'x', timestamp: new Date().toISOString() }] });
  });

  afterAll(async () => {
    if (!disponivel) return;
    await cleanup();
    await pool.end();
  });

  it('should issue an OTP and send it by SMS', async () => {
    const res = await orders.requestDeliveryOtp(IDS[0]);
    expect(res.sent).toBe(true);
    expect(res.expires_at).toBeTruthy();

    const order = await repo.findById(IDS[0]);
    expect(order.delivery_otp.code_hash).toBeTruthy();
    expect(order.delivery_otp.verified_at).toBeNull();

    const sms = (await outboundRepo.findAll(200)).find((m) => m.order_id === IDS[0] && m.channel === 'sms');
    expect(sms).toBeTruthy();
    expect(sms.body).toMatch(/\b\d{6}\b/); // o código vai no SMS
  });

  it('should deliver when the correct OTP is provided', async () => {
    // Extrai o código do SMS emitido (viaja só por SMS).
    const sms = (await outboundRepo.findAll(200)).find((m) => m.order_id === IDS[0] && m.channel === 'sms');
    const code = sms.body.match(/\b(\d{6})\b/)[1];

    const delivered = await orders.deliverOrder(IDS[0], { recipient_name: 'Ana', otp: code });
    expect(delivered.current_status).toBe('delivered');
    expect(delivered.delivery_otp.verified_at).toBeTruthy();
  });

  it('should require the OTP and reject a wrong one', async () => {
    await expect(orders.deliverOrder(IDS[1], { recipient_name: 'X' }))
      .rejects.toMatchObject({ name: 'MissingRequiredFieldError' });
    await expect(orders.deliverOrder(IDS[1], { recipient_name: 'X', otp: '000000' }))
      .rejects.toMatchObject({ name: 'OtpInvalidError', statusCode: 400 });
    // o código conhecido da factory
    const ok = await orders.deliverOrder(IDS[1], { recipient_name: 'X', otp: KNOWN_OTP_CODE });
    expect(ok.current_status).toBe('delivered');
  });

  it('should reject an expired OTP', async () => {
    await expect(orders.deliverOrder(IDS[2], { recipient_name: 'X', otp: KNOWN_OTP_CODE }))
      .rejects.toMatchObject({ name: 'OtpExpiredError' });
  });

  it('should deliver without OTP when none was issued', async () => {
    const delivered = await orders.deliverOrder(IDS[3], { recipient_name: 'Sem OTP' });
    expect(delivered.current_status).toBe('delivered');
  });

  it('should reject issuing an OTP when the order has no phone', async () => {
    await expect(orders.requestDeliveryOtp(IDS[4]))
      .rejects.toMatchObject({ name: 'NoContactForOtpError', statusCode: 409 });
  });
});
