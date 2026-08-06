import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineDeliveryFactory, OfflineSyncRepositoryMock } from '../../../../tests/harness';

const service = require('./driver-sync.service.js');

beforeEach(() => service.resetPorts());

describe('Driver sync offline POD', () => {
  it('should apply a signed delivery through the canonical delivery handler', async () => {
    const scenario = OfflineDeliveryFactory.delivered();
    const repo = new OfflineSyncRepositoryMock(scenario.order);
    const applyFinalStatus = vi.fn(async () => undefined);
    service.configurePorts({ repo, applyFinalStatus });

    const result = await service.syncDriverEvents(scenario.batch);

    expect(result.applied).toBe(1);
    expect(applyFinalStatus).toHaveBeenCalledOnce();
    expect(applyFinalStatus.mock.calls[0][0].payload.signature).toMatch(/^data:image\/png;base64,/);
  });

  it('should acknowledge a replay without applying the POD twice', async () => {
    const scenario = OfflineDeliveryFactory.delivered();
    const repo = new OfflineSyncRepositoryMock(scenario.order);
    const applyFinalStatus = vi.fn(async () => undefined);
    service.configurePorts({ repo, applyFinalStatus });

    await service.syncDriverEvents(scenario.batch);
    const replay = await service.syncDriverEvents(scenario.batch);

    expect(applyFinalStatus).toHaveBeenCalledOnce();
    expect(replay.duplicates).toBe(1);
  });

  it('should apply an offline failure through the canonical failure handler', async () => {
    const scenario = OfflineDeliveryFactory.failed();
    const repo = new OfflineSyncRepositoryMock(scenario.order);
    const applyFinalStatus = vi.fn(async () => undefined);
    service.configurePorts({ repo, applyFinalStatus });

    const result = await service.syncDriverEvents(scenario.batch);

    expect(result.applied).toBe(1);
    expect(applyFinalStatus.mock.calls[0][0]).toMatchObject({ newStatus: 'failed' });
    expect(applyFinalStatus.mock.calls[0][0].payload.reason).toBeTruthy();
  });
});
