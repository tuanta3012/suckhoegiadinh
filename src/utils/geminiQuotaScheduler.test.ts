import { describe, expect, it } from 'vitest';
import { GeminiQuotaScheduler, parseGeminiProjects } from './geminiQuotaScheduler';

const quota = { rpm: 1 };

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
  it('rotates calls across independent projects and waits when per-project RPM is exhausted', async () => {
    const scheduler = new GeminiQuotaScheduler([
      { id: 'one', apiKey: 'first-project-api-key' },
      { id: 'two', apiKey: 'second-project-api-key' },
    ]);

    const first = await scheduler.acquire('analysis', 'model-a', quota, new Set(), 100);
    const second = await scheduler.acquire('analysis', 'model-a', quota, new Set(), 100);
    expect(first.project.id).not.toBe(second.project.id);
    await expect(scheduler.acquire('analysis', 'model-a', quota, new Set(), 100))
      .rejects.toThrow('Timed out waiting for an available analysis Gemini quota slot.');
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

  it('can reserve a fallback model on the same project and accounts for that model separately', async () => {
    const scheduler = new GeminiQuotaScheduler([
      { id: 'one', apiKey: 'first-project-api-key' },
      { id: 'two', apiKey: 'second-project-api-key' },
    ]);

    const primary = await scheduler.acquire('digitization', 'model-primary', quota, new Set(), 100);
    primary.release();
    const fallback = await scheduler.acquire(
      'digitization',
      'model-fallback',
      quota,
      new Set(),
      100,
      primary.project.id,
    );

    expect(fallback.project.id).toBe(primary.project.id);
    fallback.release();
  });

  it('skips a project during its temporary cooldown', async () => {
    const scheduler = new GeminiQuotaScheduler([
      { id: 'one', apiKey: 'first-project-api-key' },
      { id: 'two', apiKey: 'second-project-api-key' },
    ]);
    scheduler.markProjectCooldown('one', 10_000);

    const lease = await scheduler.acquire('digitization', 'model-a', quota, new Set(), 100);
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

  it('does not bypass an upstream rate-limit cooldown after the acquire timeout', async () => {
    const scheduler = new GeminiQuotaScheduler([{ id: 'one', apiKey: 'first-project-api-key' }]);
    scheduler.markRateLimited('one', 'model-a', 60_000);

    await expect(scheduler.acquire('assistant', 'model-a', quota, new Set(), 25))
      .rejects.toThrow('Timed out waiting for an available assistant Gemini quota slot.');
  });

  it('cancels a request while it is waiting for RPM capacity', async () => {
    const scheduler = new GeminiQuotaScheduler([{ id: 'one', apiKey: 'first-project-api-key' }]);
    const active = await scheduler.acquire('assistant', 'model-a', quota, new Set(), 100);
    const controller = new AbortController();
    const waiting = scheduler.acquire(
      'assistant',
      'model-a',
      quota,
      new Set(),
      10_000,
      undefined,
      controller.signal,
    );
    controller.abort(new Error('Client disconnected.'));

    await expect(waiting).rejects.toThrow('Client disconnected.');
    active.release();
  });

  it('limits each key to one active request and releases the slot after completion', async () => {
    const scheduler = new GeminiQuotaScheduler([{ id: 'one', apiKey: 'first-project-api-key' }]);
    const active = await scheduler.acquire('assistant', 'model-a', { rpm: 2 }, new Set(), 100);
    const waiting = scheduler.acquire('assistant', 'model-a', { rpm: 2 }, new Set(), 1_000);
    setTimeout(active.release, 20);

    const next = await waiting;

    expect(next.project.id).toBe('one');
    next.release();
  });
});
