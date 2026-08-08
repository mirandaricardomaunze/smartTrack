/**
 * @file logger.spec.ts
 * @description Testes unitários do registo estruturado.
 *
 * Spec ref: docs/spec/especificacao-tecnica-v1.md § 3.31 (Observabilidade)
 *
 * O valor deste módulo está em duas garantias: nenhum segredo sai numa linha de
 * log, e o que sai pode ser ligado à requisição que o produziu. É isso que se
 * prova aqui — sem capturar a consola, usando o construtor puro.
 */
import { describe, expect, it } from 'vitest';

const { buildEntry, sanitize } = require('./logger');

describe('Logger · segredos', () => {
  it.each(['password', 'token', 'authorization', 'secret', 'signature', 'photo', 'api_key', 'private_key'])(
    'should never write %s', (chave) => {
      expect(sanitize({ [chave]: 'valor-real' })[chave]).toBe('[removido]');
    });

  it('should remove a secret nested inside another object', () => {
    // Um segredo escondido num objeto aninhado fica igualmente num ficheiro que
    // vive anos — a limpeza tem de descer.
    const limpo: any = sanitize({ user: { name: 'Ana', password: 'segredo' } });

    expect(limpo.user.password).toBe('[removido]');
    expect(limpo.user.name).toBe('Ana');
  });

  it('should mask PII instead of removing it', () => {
    // Remover o email tornaria o log inútil para investigar; escrevê-lo inteiro
    // é PII em texto limpo. Mascarado dá para reconhecer sem expor.
    const limpo: any = sanitize({ email: 'joao.silva@empresa.mz', phone: '+258841234567' });

    expect(limpo.email).not.toBe('joao.silva@empresa.mz');
    expect(limpo.email).toContain('@empresa.mz');
    expect(limpo.phone).not.toContain('1234');
  });

  it('should not hang on a self-referencing object', () => {
    const ciclico: any = { nome: 'a' };
    ciclico.proprio = ciclico;

    expect(() => sanitize(ciclico)).not.toThrow();
  });

  it('should keep an Error readable instead of writing an empty object', () => {
    // `JSON.stringify(new Error('x'))` dá `{}` — a mensagem desaparecia
    // exatamente na linha que existe para a mostrar.
    const limpo: any = sanitize({ err: new TypeError('valor em falta') });

    expect(limpo.err.name).toBe('TypeError');
    expect(limpo.err.message).toBe('valor em falta');
  });
});

describe('Logger · formato da linha', () => {
  it('should carry the correlation id so the line can be tied to the request', () => {
    const linha = buildEntry('error', 'Erro inesperado', { status: 500 }, {
      correlationId: 'corr-123',
      companyId: 'company-1',
      at: '2026-08-08T12:00:00.000Z',
    });

    expect(linha).toMatchObject({
      at: '2026-08-08T12:00:00.000Z',
      level: 'error',
      message: 'Erro inesperado',
      correlation_id: 'corr-123',
      company_id: 'company-1',
      status: 500,
    });
  });

  it('should omit the correlation id outside a request instead of writing null', () => {
    // Tarefas de fundo e testes não têm requisição. Uma chave a null em todas as
    // linhas é ruído que o agente de recolha indexa sem proveito nenhum.
    const linha = buildEntry('info', 'Tarefa de fundo', {}, { correlationId: null, companyId: null });

    expect(linha).not.toHaveProperty('correlation_id');
    expect(linha).not.toHaveProperty('company_id');
  });

  it('should survive being serialized — that is the whole point of the format', () => {
    const linha = buildEntry('warn', 'aviso', { err: new Error('falhou'), email: 'a@b.mz' });

    expect(() => JSON.stringify(linha)).not.toThrow();
    expect(JSON.parse(JSON.stringify(linha)).message).toBe('aviso');
  });
});
