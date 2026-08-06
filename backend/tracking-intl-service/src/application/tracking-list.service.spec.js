/**
 * @file tracking-list.service.spec.js
 * @description Testes dos casos de uso listShipments/listCarriers.
 *
 * O repositório é substituído por um fake via `configurePorts`; os dados vêm da
 * factory do harness (TrackedShipmentFactory) — nada inline. Prova que
 * listShipments delega ao repositório e propaga o limite, e que listCarriers
 * expõe as transportadoras conhecidas do StatusMapper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { TrackedShipmentFactory } from '../../../../tests/harness/factories/tracking.factory';

const require = createRequire(import.meta.url);
const service = require('./tracking.service.js');
const { StatusMapper } = require('./../domain/status-mapper.js');

const { listShipments, listCarriers, configurePorts, resetPorts } = service;

describe('tracking-intl · listShipments / listCarriers', () => {
  /** @type {{ receivedLimit: number|null, rows: object[] }} */
  const spy = { receivedLimit: null, rows: [] };

  beforeEach(() => {
    spy.receivedLimit = null;
    spy.rows = TrackedShipmentFactory.buildList(3);
    configurePorts({
      repo: {
        async listShipments(limite) {
          spy.receivedLimit = limite;
          return spy.rows;
        },
      },
    });
  });

  afterEach(() => resetPorts());

  it('should return the shipments from the repository', async () => {
    const result = await listShipments();
    expect(result).toHaveLength(3);
    expect(result[0].tracking_code).toBe(spy.rows[0].tracking_code);
  });

  it('should propagate the default limit of 100', async () => {
    await listShipments();
    expect(spy.receivedLimit).toBe(100);
  });

  it('should propagate an explicit limit', async () => {
    await listShipments(25);
    expect(spy.receivedLimit).toBe(25);
  });

  it('should expose the known carriers from the StatusMapper', () => {
    expect(listCarriers()).toEqual(StatusMapper.knownCarriers());
    expect(listCarriers()).toContain('17TRACK');
  });
});
