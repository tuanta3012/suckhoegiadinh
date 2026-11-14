import { afterEach, describe, expect, it, vi } from 'vitest';

describe('digitization logger daily retention', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('clears the previous Vietnam calendar day when logs are read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T16:59:00.000Z'));
    vi.resetModules();
    const { digitizationLogger } = await import('./digitizationLogger');

    digitizationLogger.log('info', 'test', 'Before Vietnam midnight');
    expect(digitizationLogger.getLogs()).toHaveLength(1);

    vi.setSystemTime(new Date('2025-01-01T17:01:00.000Z'));
    expect(digitizationLogger.getLogs()).toEqual([]);
  });
});
