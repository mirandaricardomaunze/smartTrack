/**
 * @file otp.factory.ts
 * @description Test factory para o código de entrega (OTP).
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.1, § 3.3
 *
 * O backend guarda apenas o HASH do código. Esta factory usa um código conhecido
 * e o seu sha256 para os specs poderem semear um pedido com um OTP determinista
 * (válido, expirado ou com tentativas esgotadas) sem recalcular hashes inline.
 */

/** Código de entrega conhecido e o seu sha256 (para semear OTPs em testes). */
export const KNOWN_OTP_CODE = '123456';
export const KNOWN_OTP_HASH = '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92';

export interface TestDeliveryOtp {
  code_hash: string;
  expires_at: string;
  attempts: number;
  created_at: string;
  verified_at: string | null;
}

export class DeliveryOtpFactory {
  /** OTP válido (código KNOWN_OTP_CODE, expira daqui a 4h). */
  static build(overrides: Partial<TestDeliveryOtp> = {}): TestDeliveryOtp {
    const now = new Date();
    return {
      code_hash:  KNOWN_OTP_HASH,
      expires_at: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(),
      attempts:   0,
      created_at: now.toISOString(),
      verified_at: null,
      ...overrides,
    };
  }

  /** OTP já expirado. */
  static buildExpired(overrides: Partial<TestDeliveryOtp> = {}): TestDeliveryOtp {
    return this.build({ expires_at: new Date(Date.now() - 60_000).toISOString(), ...overrides });
  }

  /** OTP com o número máximo de tentativas atingido. */
  static buildMaxAttempts(overrides: Partial<TestDeliveryOtp> = {}): TestDeliveryOtp {
    return this.build({ attempts: 5, ...overrides });
  }
}
