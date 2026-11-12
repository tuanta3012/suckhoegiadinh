import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import type { FamilyMember, HealthProfile } from '../types';

vi.mock('./digitizationLogger', () => ({
  digitizationLogger: {
    log: vi.fn(),
    startTimer: () => () => 0,
  },
}));

vi.mock('./googleDriveService', () => ({
  getValidGoogleAccessToken: vi.fn().mockResolvedValue(null),
}));

vi.mock('./geminiSharedResources', () => ({
  getSharedGeminiKeysForRequest: vi.fn().mockResolvedValue([]),
}));

import { askHealthAssistant } from './geminiService';

describe('askHealthAssistant API routing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the configured backend and explains HTML fallback responses', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html' },
      status: 200,
    }));

    await expect(askHealthAssistant(
      'Question',
      {} as FamilyMember,
      {} as HealthProfile,
    )).rejects.toThrow('trả về HTML thay vì JSON (HTTP 200)');

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe(
      'https://api.example.com/api/gemini/ask-assistant',
    );
  });

  it('fails before fetching when an APK has no configured backend URL', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    globalThis.fetch = vi.fn();

    await expect(askHealthAssistant(
      'Question',
      {} as FamilyMember,
      {} as HealthProfile,
    )).rejects.toThrow('Chưa cấu hình máy chủ AI');

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sends chat history and exposes only approved citation links', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      answer: 'Thông tin tham khảo [1].',
      citations: [
        { title: 'WHO', url: 'https://www.who.int/health-topics/example' },
        { title: 'Untrusted', url: 'https://example.com/health' },
      ],
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));

    await expect(askHealthAssistant(
      'Question',
      {} as FamilyMember,
      {} as HealthProfile,
      [{ role: 'user', text: 'Previous question' }],
    )).resolves.toEqual({
      answer: 'Thông tin tham khảo [1].',
      citations: [{ title: 'WHO', url: 'https://www.who.int/health-topics/example' }],
    });

    const requestBody = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(requestBody.history).toEqual([{ role: 'user', text: 'Previous question' }]);
  });
});
