/**
 * @file providers.status.js
 * @description Que integrações externas estão reais e quais estão simuladas.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.24 (Saúde das integrações)
 *
 * PORQUÊ EXISTE: cada cliente externo já sabia responder `isSimulated()`, mas a
 * resposta ficava no arranque, num `console.info` que ninguém relê. O resultado
 * prático era o pior tipo de avaria: em modo simulado o sistema responde
 * "enviado" e o SMS nunca sai. Não há erro, não há alerta, e quem descobre é o
 * cliente que não recebeu o código de entrega.
 *
 * Aqui a pergunta passa a ter uma resposta consultável — usada pelo alerta que
 * dispara quando um provedor simulado está a correr em produção.
 *
 * O QUE ISTO NÃO FAZ: não contacta os provedores. "Tem credenciais
 * configuradas" e "está a responder" são perguntas diferentes; esta responde à
 * primeira, que é a que distingue um sistema mal configurado de um sistema com
 * uma avaria externa momentânea.
 */
'use strict';

/**
 * Cada entrada é carregada em `try` porque um serviço a jusante pode não estar
 * instalado num recorte do monólito — nesse caso a integração é reportada como
 * indisponível em vez de derrubar a consulta de saúde inteira.
 *
 * @type {Array<{ name: string, load: () => { isSimulated: () => boolean }, env_hint: string }>}
 */
const REGISTRY = [
  {
    name: 'email',
    env_hint: 'RESEND_API_KEY + EMAIL_FROM',
    load: () => require('../../../notifications-service/src/infrastructure/email.client'),
  },
  {
    name: 'sms',
    env_hint: 'SMS_API_KEY',
    load: () => require('../../../notifications-service/src/infrastructure/sms.client'),
  },
  {
    name: 'whatsapp',
    env_hint: 'WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN (+ WHATSAPP_TEMPLATE_NAME aprovado)',
    load: () => require('../../../notifications-service/src/infrastructure/whatsapp.client'),
  },
  {
    name: 'push',
    env_hint: 'FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY',
    load: () => require('../../../notifications-service/src/infrastructure/fcm.client'),
  },
  {
    name: 'pagamentos',
    env_hint: 'PAYMENT_GATEWAY_KEY',
    load: () => require('../../../payments-service/src/infrastructure/gateway.client'),
  },
  {
    name: 'rastreio-internacional',
    env_hint: 'TRACK17_API_KEY',
    load: () => require('../../../tracking-intl-service/src/infrastructure/carrier.client'),
  },
];

/**
 * Estado de cada integração.
 *
 * @returns {Array<{ name: string, simulated: boolean, available: boolean, env_hint: string, error?: string }>}
 */
function listProviders() {
  return REGISTRY.map((entry) => {
    try {
      return {
        name:      entry.name,
        simulated: Boolean(entry.load().isSimulated()),
        available: true,
        env_hint:  entry.env_hint,
      };
    } catch (err) {
      // Um módulo que não carrega conta como simulado: seguramente não está a
      // entregar nada ao mundo real.
      return {
        name:      entry.name,
        simulated: true,
        available: false,
        env_hint:  entry.env_hint,
        error:     err.message,
      };
    }
  });
}

module.exports = { listProviders, REGISTRY };
