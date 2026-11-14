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

  it('masks API keys and redacted fields while retaining error diagnostics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));
    vi.resetModules();
    const { digitizationLogger, sanitizeSensitiveText } = await import('./digitizationLogger');

    expect(sanitizeSensitiveText('https://example.com?key=AIzaSy1234567890abcdef')).toBe(
      'https://example.com?key=***',
    );
    expect(sanitizeSensitiveText('Invalid key AIzaSy1234567890abcdef')).toBe(
      'Invalid key AIza***',
    );

    digitizationLogger.log(
      'error',
      'api_attempt_error',
      'Failed with key AIzaSySecretKey1234567890',
      {
        requestId: 'req-1',
        apiKey: 'AIzaSySecretKey1234567890',
        clientGeminiKeys: ['k1', 'k2'],
        errorMessage: 'Bearer secret_token_1234567890 rejected AIzaSySecretKey1234567890',
      },
    );

    const [entry] = digitizationLogger.getLogs();
    expect(entry.message).toBe('Failed with key AIza***');
    expect(entry.data.apiKey).toBe('[REDACTED]');
    expect(entry.data.clientGeminiKeys).toBe('[REDACTED]');
    expect(entry.data.errorMessage).toContain('Bearer ***');
    expect(entry.data.errorMessage).not.toContain('AIzaSySecretKey');
  });
});
