import { describe, expect, it } from 'vitest';
import { GeminiQuotaScheduler, parseGeminiProjects } from './geminiQuotaScheduler';

const quota = { rpm: 1, rpd: 2, maxConcurrent: 1 };

describe('parseGeminiProjects', () => {
  it('parses six separately named projects', () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      id: `project-${index + 1}`,
      apiKey: `project-api-key-${index + 1}`,
    }));
    expect(parseGeminiProjects(JSON.stringify(projects), [], undefined)).toHaveLength(6);
  });

  it('rejects duplicate project ids instead of silently merging quota pools', () => {
    expect(() => parseGeminiProjects(
      JSON.stringify([
        { id: 'same', apiKey: 'first-project-api-key' },
        { id: 'same', apiKey: 'second-project-api-key' },
      ]),
      [],
      undefined,
    )).toThrow('must be unique');
  });

  it('rejects reusing a key across project entries', () => {
    expect(() => parseGeminiProjects(
      JSON.stringify([
        { id: 'one', apiKey: 'same-project-api-key' },
        { id: 'two', apiKey: 'same-project-api-key' },
      ]),
      [],
      undefined,
    )).toThrow('API keys must be unique');
  });

  it('keeps backwards compatibility with legacy key lists', () => {
    expect(parseGeminiProjects(undefined, ['first-legacy-api-key'], 'second-legacy-api-key')).toEqual([
      { id: 'legacy-1', apiKey: 'first-legacy-api-key' },
      { id: 'legacy-2', apiKey: 'second-legacy-api-key' },
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
