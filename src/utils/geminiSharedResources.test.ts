import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  generateGeminiContent,
  getSharedGeminiKeys,
  parseGeminiKeyInput,
  setSharedGeminiKeys,
  testGeminiApiKey,
} from './geminiSharedResources';

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    CapacitorHttp: { request: vi.fn() },
  };
});

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

  it('sends web generation requests directly to Gemini with the requested model and payload', async () => {
    setSharedGeminiKeys(['test-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"title":"Kết quả"}' }] } }],
    }), { status: 200 }));

    const result = await generateGeminiContent(
      'gemini-3.5-flash-lite',
      [{ inlineData: { mimeType: 'image/jpeg', data: 'base64-image' } }, { text: 'Đọc tài liệu' }],
      { systemInstruction: 'OCR y tế', responseMimeType: 'application/json' },
    );

    expect(result).toEqual({ text: '{"title":"Kết quả"}', modelUsed: 'gemini-3.5-flash-lite' });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain(
      'generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    );
    expect(String(url)).toContain('key=test-key');
    const payload = JSON.parse(String(init?.body));
    expect(payload.systemInstruction.parts[0].text).toBe('OCR y tế');
    expect(payload.generationConfig.responseMimeType).toBe('application/json');
    expect(payload.contents[0].parts[0].inlineData.data).toBe('base64-image');
    expect(payload.contents[1].parts[0].text).toBe('Đọc tài liệu');
  });

  it('validates API keys directly with Google Gemini', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: 'models/gemini-3.5-flash-lite' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      }), { status: 200 }));

    await expect(testGeminiApiKey('configured-key'))
      .resolves.toEqual({ valid: true, workingModel: 'gemini-3.5-flash-lite' });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toContain('generativelanguage.googleapis.com/v1beta/models?pageSize=20');
    expect(String(calls[0][0])).toContain('key=configured-key');
    expect(String(calls[1][0])).toContain('gemini-3.5-flash-lite:generateContent');
  });

  it('fails over to the next configured key when the first key is rate limited', async () => {
    setSharedGeminiKeys(['first-key', 'second-key']);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' },
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'OCR result' }] } }],
      }), { status: 200 }));

    await expect(generateGeminiContent('gemini-3.5-flash-lite', [{ text: 'OCR' }]))
      .resolves.toEqual({ text: 'OCR result', modelUsed: 'gemini-3.5-flash-lite' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[1][0])).toContain('key=second-key');
  });

  it('uses Capacitor native HTTP for APK requests instead of a relative server route', async () => {
    setSharedGeminiKeys(['native-key']);
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const request = vi.spyOn(CapacitorHttp, 'request').mockImplementation(async (options) => ({
      data: { candidates: [{ content: { parts: [{ text: 'Native OCR result' }] } }] },
      status: 200,
      headers: {},
      url: options.url,
    }));

    await expect(generateGeminiContent('gemini-3.5-flash-lite', [{ text: 'OCR' }]))
      .resolves.toEqual({ text: 'Native OCR result', modelUsed: 'gemini-3.5-flash-lite' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].url).toContain('generativelanguage.googleapis.com');
    expect(request.mock.calls[0][0].url).not.toContain('/api/gemini/');
  });
});
