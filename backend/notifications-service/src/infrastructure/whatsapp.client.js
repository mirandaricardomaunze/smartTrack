/**
 * @file whatsapp.client.js
 * @description Adaptador de WhatsApp — simulado por default, real via ambiente.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.3, § 4 (credenciais só por env)
 *
 * MODO:
 *   - `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN` → cliente REAL
 *     (WhatsApp Business Cloud API, da Meta).
 *   - Sem env → `SimulatedWhatsApp` determinista, como o SMS.
 *
 * DUAS REGRAS DO WHATSAPP QUE NÃO SE PODEM IGNORAR, e que são a razão de este
 * adaptador não ser um `fetch` de três linhas:
 *
 *  1. **A janela de 24 horas.** Texto livre só é aceite nas 24 horas seguintes à
 *     última mensagem QUE O CLIENTE ENVIOU. Fora dela, a Meta recusa com o erro
 *     131047 e a mensagem nunca chega. Uma notificação de logística ("a sua
 *     encomenda saiu para entrega") é quase sempre fora da janela — por isso o
 *     default aqui é **template**, e o texto livre é uma escolha explícita de
 *     quem chama. Ao contrário, teríamos um canal que responde "enviado" e não
 *     entrega nada, que é a pior falha possível (§ 3.24).
 *
 *  2. **O número tem de ir só com dígitos**, com indicativo e sem '+', espaços
 *     ou parênteses. Um número guardado como "+258 84 123 4567" — que é como as
 *     pessoas o escrevem — é recusado. A normalização vive aqui e não em cada
 *     chamador.
 *
 * Devolve sempre `{ ok, status, providerMessageId?, provider, message }` — nunca
 * lança por causa da rede (o messaging.service trata best-effort).
 */
'use strict';

const TIMEOUT_MS = () => Number(process.env.WHATSAPP_TIMEOUT_MS) || 8_000;

/** Versão da Graph API. Fixada por ambiente para uma atualização da Meta não mudar o comportamento sozinha. */
const API_VERSION = () => process.env.WHATSAPP_API_VERSION || 'v21.0';

function phoneNumberId() { return process.env.WHATSAPP_PHONE_NUMBER_ID; }
function accessToken()   { return process.env.WHATSAPP_ACCESS_TOKEN; }

/** Template aprovado usado nas notificações de estado. */
function defaultTemplate() { return process.env.WHATSAPP_TEMPLATE_NAME || 'order_status_update'; }
function defaultLanguage() { return process.env.WHATSAPP_TEMPLATE_LANG || 'pt_PT'; }

/** true quando não há provedor real configurado. */
function isSimulated() {
  return !(phoneNumberId() && accessToken());
}

/**
 * Normaliza um número para o formato que a Cloud API aceita: só dígitos, com
 * indicativo. PURA.
 *
 * Devolve `null` quando não sobra um número plausível — é melhor recusar aqui,
 * com uma mensagem clara, do que mandar lixo à Meta e receber um erro genérico.
 *
 * @param {string} raw
 * @param {string} [defaultCountryCode] Indicativo a assumir num número local.
 * @returns {string|null}
 */
function normalizePhone(raw, defaultCountryCode = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '258') {
  const digitos = String(raw ?? '').replace(/\D/g, '');
  if (!digitos) return null;

  // Um número local moçambicano tem 9 dígitos e começa por 8. Sem indicativo, a
  // Meta interpreta-o como outro país qualquer e a mensagem some-se.
  const comIndicativo = digitos.length <= 9 ? `${defaultCountryCode}${digitos}` : digitos;

  // Abaixo de 8 dígitos não é um número de telemóvel de lado nenhum; acima de 15
  // ultrapassa o E.164.
  if (comIndicativo.length < 8 || comIndicativo.length > 15) return null;
  return comIndicativo;
}

/**
 * Monta o corpo da mensagem. PURA — é o que se pode afirmar num teste sem rede.
 *
 * @param {{ to: string, message: string, template?: string, language?: string, freeText?: boolean, variables?: string[] }} req
 * @returns {object|null} null quando o número não é utilizável.
 */
function buildPayload(req) {
  const to = normalizePhone(req.to);
  if (!to) return null;

  if (req.freeText) {
    // Só válido dentro da janela de 24 horas — ver a nota no topo.
    return { messaging_product: 'whatsapp', to, type: 'text', text: { body: String(req.message ?? '') } };
  }

  // As variáveis do template são posicionais na Cloud API. Sem variáveis
  // explícitas, o corpo da mensagem entra como a primeira — é o caso simples de
  // um template com um só campo.
  const variaveis = Array.isArray(req.variables) && req.variables.length
    ? req.variables
    : [String(req.message ?? '')];

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: req.template || defaultTemplate(),
      language: { code: req.language || defaultLanguage() },
      components: [{
        type: 'body',
        parameters: variaveis.map((v) => ({ type: 'text', text: String(v) })),
      }],
    },
  };
}

/**
 * Traduz um erro da Meta para uma mensagem que diz o que fazer. PURA.
 *
 * O 131047 é o que mais aparece e o mais confuso: a mensagem da Meta fala de
 * "re-engagement" e não de templates, e quem lê o log não percebe porque é que
 * "enviou" e não chegou.
 *
 * @param {object} data Corpo devolvido pela Graph API.
 * @param {number} httpStatus
 * @returns {string}
 */
function describeError(data, httpStatus) {
  const code = data?.error?.code;
  const detalhe = data?.error?.message || `HTTP ${httpStatus}`;

  if (code === 131047) {
    return 'WhatsApp recusou: fora da janela de 24 horas. Use um template aprovado em vez de texto livre.';
  }
  if (code === 132001) {
    return 'WhatsApp recusou: o template não existe ou não está aprovado para este idioma.';
  }
  if (code === 190 || httpStatus === 401) {
    return 'WhatsApp recusou: token de acesso inválido ou expirado.';
  }
  if (code === 131026) {
    return 'WhatsApp recusou: o número de destino não tem conta WhatsApp.';
  }
  return `WhatsApp indisponível: ${detalhe}.`;
}

const SimulatedWhatsApp = {
  provider: 'SIMULATED',
  /**
   * @param {{ to: string, message: string }} req
   * @returns {Promise<{ ok: boolean, status: string, providerMessageId?: string, provider: string, message: string }>}
   */
  async send(req) {
    const to = normalizePhone(req.to);
    if (!to) {
      return { ok: false, status: 'failed', provider: 'SIMULATED', message: 'Número de WhatsApp inválido.' };
    }
    // Determinista, como o SMS: número terminado em '0' falha.
    return to.endsWith('0')
      ? { ok: false, status: 'failed', provider: 'SIMULATED', message: 'Número recusado (simulado).' }
      : {
        ok: true,
        status: 'simulated',
        provider: 'SIMULATED',
        providerMessageId: `sim-wa-${Date.now().toString(36)}`,
        message: 'WhatsApp simulado (sem provedor real).',
      };
  },
};

const RealWhatsApp = {
  provider: 'META_CLOUD',
  async send(req) {
    const payload = buildPayload(req);
    if (!payload) {
      return { ok: false, status: 'failed', provider: 'META_CLOUD', message: 'Número de WhatsApp inválido.' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS());
    try {
      const res = await fetch(`https://graph.facebook.com/${API_VERSION()}/${phoneNumberId()}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken()}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, status: 'failed', provider: 'META_CLOUD', message: describeError(data, res.status) };
      }
      return {
        ok: true,
        status: 'sent',
        provider: 'META_CLOUD',
        providerMessageId: data?.messages?.[0]?.id,
        message: 'WhatsApp enviado.',
      };
    } catch (err) {
      const reason = err.name === 'AbortError' ? 'timeout' : err.message;
      return { ok: false, status: 'failed', provider: 'META_CLOUD', message: `WhatsApp indisponível: ${reason}.` };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** @returns {typeof SimulatedWhatsApp | typeof RealWhatsApp} */
function getWhatsAppClient() {
  return isSimulated() ? SimulatedWhatsApp : RealWhatsApp;
}

module.exports = {
  SimulatedWhatsApp,
  RealWhatsApp,
  getWhatsAppClient,
  isSimulated,
  // Puros — exportados para teste
  normalizePhone,
  buildPayload,
  describeError,
};
