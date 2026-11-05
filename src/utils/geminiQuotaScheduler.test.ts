import { describe, expect, it } from 'vitest';
import { GeminiQuotaScheduler, parseGeminiProjects } from './geminiQuotaScheduler';

const quota = { rpm: 1, rpd: 2, maxConcurrent: 1 };

describe('parseGeminiProjects', () => {
  it('parses list of independent API keys into project objects', () => {
    const keys = Array.from({ length: 6 }, (_, index) => `project-api-key-${index + 1}`);
    const projects = parseGeminiProjects(keys, undefined);
    expect(projects).toHaveLength(6);
    expect(projects[0]).toEqual({ id: 'account-1', apiKey: 'project-api-key-1' });
  });

  it('deduplicates API keys and appends defaultKey if distinct', () => {
    expect(parseGeminiProjects(['key-1', 'key-1', 'key-2'], 'key-3')).toEqual([
      { id: 'account-1', apiKey: 'key-1' },
      { id: 'account-2', apiKey: 'key-2' },
      { id: 'account-3', apiKey: 'key-3' },
    ]);
  });
});

describe('GeminiQuotaScheduler', () => {
  it('rotates calls across independent projects and enforces per-project RPM', async () => {
    const scheduler = new GeminiQuotaScheduler([
      { id: 'one', apiKey: 'first-project-api-key' },
      { id: 'two', apiKey: 'second-project-api-key' },
    ]);

    const first = await scheduler.acquire('analysis', 'model-a', quota, new Set(), 100);
    const second = await scheduler.acquire('analysis', 'model-a', quota, new Set(), 100);
    expect(first.project.id).not.toBe(second.project.id);
    await expect(scheduler.acquire('analysis', 'model-a', quota, new Set(), 100))
      .rejects.toThrow('No RPM capacity remains');
    first.release();
    second.release();
  });

  it('skips a rate-limited project and continues on the same model elsewhere', async () => {
    const scheduler = new GeminiQuotaScheduler([
      { id: 'one', apiKey: 'first-project-api-key' },
      { id: 'two', apiKey: 'second-project-api-key' },
    ]);
    scheduler.markRateLimited('one', 'model-a', 60_000);

    const lease = await scheduler.acquire('analysis', 'model-a', quota, new Set(), 100);
    expect(lease.project.id).toBe('two');
    lease.release();
  });

  it('skips a project whose API key is invalid', async () => {
    const scheduler = new GeminiQuotaScheduler([
      { id: 'one', apiKey: 'first-project-api-key' },
      { id: 'two', apiKey: 'second-project-api-key' },
    ]);
    scheduler.markProjectUnavailable('one');

    const lease = await scheduler.acquire('analysis', 'model-a', quota, new Set(), 100);
    expect(lease.project.id).toBe('two');
    lease.release();
  });

  it('marks a project-model daily quota as unavailable', async () => {
    const scheduler = new GeminiQuotaScheduler([{ id: 'one', apiKey: 'first-project-api-key' }]);
    scheduler.markDailyQuotaExhausted('one', 'model-a');
    await expect(scheduler.acquire('analysis', 'model-a', quota, new Set(), 100))
      .rejects.toThrow('No daily analysis quota remains');
  });
});
