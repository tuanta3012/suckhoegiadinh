import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TASK_MODEL_CONFIG } from './geminiPoolManager';

describe('Gemini Pool Manager', () => {
  it('correctly configures task-specific models and quota limits', () => {
    // Task 1: Digitization
    const digConfig = TASK_MODEL_CONFIG.digitization;
    expect(digConfig.primaryModels).toContain('gemini-3.5-flash-lite');
    expect(digConfig.primaryModels).toContain('gemini-3.1-flash-lite');
    expect(digConfig.quota.rpm).toBe(15);
    expect(digConfig.quota.rpd).toBe(500);

    // Task 2: Analysis
    const anaConfig = TASK_MODEL_CONFIG.analysis;
    expect(anaConfig.primaryModels).toContain('gemini-3.8-flash');
    expect(anaConfig.primaryModels).toContain('gemini-3.6-flash');
    expect(anaConfig.primaryModels).toContain('gemini-3-flash');
    expect(anaConfig.quota.rpm).toBe(5);
    expect(anaConfig.quota.rpd).toBe(20);
  });

  it('correctly parses 6 API keys from string and manages keys', async () => {
    const { geminiPool } = await import('./geminiPoolManager');

    const testKeys = [
      'AIzaSyTestKeyAccount1_abcdefghijk1',
      'AIzaSyTestKeyAccount2_abcdefghijk2',
      'AIzaSyTestKeyAccount3_abcdefghijk3',
      'AIzaSyTestKeyAccount4_abcdefghijk4',
      'AIzaSyTestKeyAccount5_abcdefghijk5',
      'AIzaSyTestKeyAccount6_abcdefghijk6',
    ];

    await geminiPool.setKeys(testKeys);
    expect(geminiPool.getKeys().length).toBe(6);

    const state = geminiPool.getPoolState();
    expect(state.totalKeys).toBe(6);
    expect(state.activeKeys).toBe(6);
    expect(state.cooldownKeys).toBe(0);
    expect(state.keys[0].label).toBe('Tài khoản Google 1');
    expect(state.keys[0].maskedKey).toBe('AIzaSy...ijk1');
  });

  it('handles multi-threading, runner execution, and failover when a key encounters 429 quota exhaustion', async () => {
    const { geminiPool } = await import('./geminiPoolManager');

    await geminiPool.setKeys([
      'AIzaSyFailingKey_first_account1111',
      'AIzaSyHealthyKey_second_account2222',
    ]);

    const calls: string[] = [];

    const result = await geminiPool.executeTask('digitization', async (apiKey, model) => {
      calls.push(apiKey);
      if (apiKey.includes('FailingKey')) {
        throw new Error('Gemini API Error [429]: RESOURCE_EXHAUSTED rate limit exceeded');
      }
      return `Success from ${model} with key ${apiKey}`;
    });

    expect(result).toContain('Success from');
    // First key failed with 429, second key succeeded
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('FailingKey');
    expect(calls[1]).toContain('HealthyKey');

    // Check pool state reflects cooldown
    const state = geminiPool.getPoolState();
    const failingKeyState = state.keys.find((k) => k.maskedKey.includes('1111'));
    expect(failingKeyState?.status).toBe('cooldown');
    expect(failingKeyState?.cooldownRemainingSec).toBeGreaterThan(0);
  });
});
