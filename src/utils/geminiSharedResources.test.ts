import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSharedGeminiKeys,
  getSharedGeminiKeysForRequest,
  parseGeminiKeyInput,
  setSharedGeminiKeys,
  testGeminiApiKey,
  trackSharedGeminiKeysLoad,
} from './geminiSharedResources';

describe('shared Gemini resources', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setSharedGeminiKeys([]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses comma- and newline-separated keys, trims, and removes duplicates', () => {
    expect(parseGeminiKeyInput(' first-key,\nsecond-key \r\nfirst-key,, ')).toEqual([
      'first-key',
      'second-key',
    ]);
  });

  it('keeps the active key list in memory without exposing the internal array', () => {
    const keys = ['key-one', 'key-two'];
    setSharedGeminiKeys(keys);
    keys.push('external-mutation');

    const loaded = getSharedGeminiKeys();
    expect(loaded).toEqual(['key-one', 'key-two']);
    loaded.push('caller-mutation');
    expect(getSharedGeminiKeys()).toEqual(['key-one', 'key-two']);
  });

  it('waits for shared Drive keys to load before returning request keys', async () => {
    const loading = Promise.resolve().then(() => setSharedGeminiKeys(['drive-key']));
    trackSharedGeminiKeysLoad(loading);

    await expect(getSharedGeminiKeysForRequest()).resolves.toEqual(['drive-key']);
  });

  it('validates API keys through the server proxy', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      valid: true,
      workingModel: 'gemini-3.5-flash-lite',
    }), { status: 200 }));

    const result = await testGeminiApiKey('test-key-123');
    
    expect(result).toEqual({ valid: true, workingModel: 'gemini-3.5-flash-lite' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain('/api/gemini/test-key');
    const payload = JSON.parse(String(init?.body));
    expect(payload.key).toBe('test-key-123');
  });

  it('throws error if server returns non-ok status during key validation', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Invalid API key',
    }), { status: 400 }));

    await expect(testGeminiApiKey('bad-key')).rejects.toThrow('Invalid API key');
  });
});
