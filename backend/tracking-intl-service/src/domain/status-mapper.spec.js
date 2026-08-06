/**
 * @file status-mapper.spec.js
 * @description Testes do StatusMapper.
 *
 * Portado de status-mapper.spec.ts, preservando a cobertura orientada por
 * fixture. Continua a usar `tests/harness/fixtures/carrier-status-samples.json`
 * — conforme a regra do harness, nunca criar dados de teste inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import carrierSamples from '../../../../tests/harness/fixtures/carrier-status-samples.json';

const require = createRequire(import.meta.url);
const { StatusMapper, OrderStatus, FALLBACK_STATUS } = require('./status-mapper.js');

describe('StatusMapper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('mapeamento canônico (fixtures do harness)', () => {
    // Um teste por amostra — a fixture é a fonte da verdade, não o código
    for (const { carrier, raw_status, expected_canonical, note } of carrierSamples) {
      const sufixo = note ? ` (${note})` : '';

      it(`should map [${carrier}] "${raw_status}" to "${expected_canonical}"${sufixo}`, () => {
        // Silenciar o aviso: os casos de fallback verificam-no à parte
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(StatusMapper.map(carrier, raw_status)).toBe(expected_canonical);
      });
    }
  });

  describe('fallback e observabilidade', () => {
    it('should warn and fall back when the carrier is unknown', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(StatusMapper.map('MOCK_CARRIER_FAKE', 'Any Status')).toBe(OrderStatus.IN_TRANSIT);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Carrier desconhecido "MOCK_CARRIER_FAKE"'),
      );
    });

    it('should warn distinctly when the carrier is known but the status is new', () => {
      // Aviso diferente de propósito: sinaliza que o mapa precisa de atualização
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(StatusMapper.map('17TRACK', 'UNKNOWN_RAW_DELIVERY_STATUS')).toBe(OrderStatus.IN_TRANSIT);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Status desconhecido "UNKNOWN_RAW_DELIVERY_STATUS" para o carrier "17TRACK"'),
      );
    });

    it('should never return a raw carrier string', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const canonicos = Object.values(OrderStatus);
      expect(canonicos).toContain(StatusMapper.map('QUALQUER', 'Coisa Estranha'));
      expect(FALLBACK_STATUS).toBe(OrderStatus.IN_TRANSIT);
    });
  });

  describe('introspecção', () => {
    it('should recognise the mapped carriers', () => {
      expect(StatusMapper.isKnownCarrier('17TRACK')).toBe(true);
      expect(StatusMapper.isKnownCarrier('CAINIAO')).toBe(true);
      expect(StatusMapper.isKnownCarrier('INVENTADA')).toBe(false);
    });

    it('should list every mapped carrier', () => {
      expect(StatusMapper.knownCarriers()).toEqual(
        expect.arrayContaining(['17TRACK', 'CAINIAO', 'CORREIOS_BR']),
      );
    });
  });
});
