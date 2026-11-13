import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = {
        generateContent: generateContentMock,
      };
    },
  };
});

import { createGeminiRequestContext } from './geminiRequestContext';
import { cleanErrorMessage } from './geminiErrorMessages';
import {
  describeGeminiError,
  executeGeminiWithPool,
  getTaskQuota,
  getModelQuota,
} from './geminiUnifiedExecutor';
import { TASK_MODELS } from './geminiModels';

describe('Gemini unified executor', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('executes a short assistant research request within its configured timeout', async () => {
    generateContentMock.mockResolvedValue({ text: 'Medical source summary.' });

    await expect(executeGeminiWithPool({
      task: 'assistant',
      contents: [{ text: 'Search for a medical source.' }],
      requestContext: createGeminiRequestContext(['AIzaSy-test-key-012345678901234567890123456789012345']),
      timeoutMs: 12_000,
      attemptTimeoutMs: 10_000,
      maxPoolPasses: 1,
    })).resolves.toMatchObject({ text: 'Medical source summary.' });

    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('uses the same model quota source for task and model reporting', () => {
    expect(getTaskQuota('digitization')).toEqual(getModelQuota(TASK_MODELS.digitization[0]));
    expect(getTaskQuota('analysis')).toEqual(getModelQuota(TASK_MODELS.analysis[0]));
    expect(getTaskQuota('assistant')).toEqual(getModelQuota(TASK_MODELS.assistant[0]));
    expect(getModelQuota('gemini-3.5-flash-lite')).toEqual({ rpm: 15 });
    expect(getModelQuota('gemini-4-hydrogen')).toEqual({ rpm: 5 });
  });

  it('fails over when Gemini confirms RPD exhaustion for one key', async () => {
    generateContentMock
      .mockRejectedValueOnce(Object.assign(
        new Error('Quota exceeded for requests per day (RPD).'),
        { status: 429 },
      ))
      .mockResolvedValueOnce({ text: 'Succeeded with the next key.' });
    const requestContext = createGeminiRequestContext([
      'AIzaSy-test-key-012345678901234567890123456789012345',
      'AIzaSy-another-test-key-01234567890123456789012345678901',
    ]);

    await expect(executeGeminiWithPool({
      task: 'assistant',
      contents: [{ text: 'Answer the question.' }],
      requestContext,
      maxPoolPasses: 1,
    })).resolves.toMatchObject({
      text: 'Succeeded with the next key.',
      projectId: 'account-2',
    });

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('reports RPD exhaustion only after every configured key returns an RPD error', async () => {
    generateContentMock.mockRejectedValue(Object.assign(
      new Error('Quota exceeded for requests per day (RPD).'),
      { status: 429 },
    ));
    const requestContext = createGeminiRequestContext([
      'AIzaSy-test-key-012345678901234567890123456789012345',
      'AIzaSy-another-test-key-01234567890123456789012345678901',
    ]);

    await expect(executeGeminiWithPool({
      task: 'assistant',
      contents: [{ text: 'Answer the question.' }],
      requestContext,
      maxPoolPasses: 1,
    })).rejects.toThrow('All configured Gemini API keys have exhausted daily quota');

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('does not classify a generic 429 or quota-exceeded response as daily exhaustion', () => {
    expect(describeGeminiError(Object.assign(
      new Error('RESOURCE_EXHAUSTED: quota exceeded.'),
      { status: 429 },
    ))).toMatchObject({
      status: 429,
      isRateLimit: true,
      isDailyQuota: false,
      message: expect.stringContaining('giới hạn tần suất'),
    });
    expect(cleanErrorMessage('429 RESOURCE_EXHAUSTED')).toContain('giới hạn tần suất');
    expect(cleanErrorMessage('429 RESOURCE_EXHAUSTED')).not.toContain('Quota Exhausted');
  });

  it('surfaces an RPD quota message only for the all-keys-exhausted result', () => {
    expect(cleanErrorMessage('All configured Gemini API keys have exhausted daily quota.'))
      .toContain('đã hết quota RPD');
  });

  it('reports an internal scheduler wait as backend capacity pressure, not Google quota exhaustion', () => {
    expect(describeGeminiError(
      new Error('Timed out waiting for an available assistant Gemini quota slot.'),
    )).toMatchObject({
      status: 503,
      isRateLimit: false,
      isTransient: true,
      message: expect.stringContaining('chưa cấp được lượt gọi Gemini'),
    });
  });
});
