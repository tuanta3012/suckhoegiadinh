import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import type { FamilyMember, HealthProfile } from '../types';

const { generateContentMock, generateContentStreamMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
  generateContentStreamMock: vi.fn(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      apiKey: string;
      models: {
        generateContent: (args: unknown) => Promise<unknown>;
        generateContentStream: (args: unknown) => Promise<unknown>;
      };
      constructor(opts: { apiKey: string }) {
        this.apiKey = opts.apiKey;
        this.models = {
          generateContent: (args: unknown) => generateContentMock(this.apiKey, args),
          generateContentStream: (args: unknown) => generateContentStreamMock(this.apiKey, args),
        };
      }
    },
  };
});

vi.mock('./digitizationLogger', () => ({
  digitizationLogger: {
    log: vi.fn(),
    startTimer: () => () => 0,
  },
}));

vi.mock('./googleDriveService', () => ({
  getFirebaseIdToken: vi.fn().mockResolvedValue(null),
}));

vi.mock('./geminiSharedResources', () => ({
  getSharedGeminiKeysForRequest: vi.fn().mockResolvedValue([]),
}));

import {
  analyzeComprehensiveHealth,
  askHealthAssistant,
  extractHealthEventWithProgress,
  streamHealthAssistant,
} from './geminiService';
import { getSharedGeminiKeysForRequest } from './geminiSharedResources';
import { getFirebaseIdToken } from './googleDriveService';

const member = { id: 'm1', name: 'Truong Anh Tuan' } as FamilyMember;
const profile = { timeline: [], metrics: [] } as unknown as HealthProfile;

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Gemini service backend routing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    generateContentMock.mockReset();
    generateContentStreamMock.mockReset();
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue([]);
    vi.mocked(getFirebaseIdToken).mockResolvedValue(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the configured backend and explains HTML responses instead of parsing them as JSON', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html>', {
      headers: { 'Content-Type': 'text/html' },
      status: 200,
    }));

    await expect(askHealthAssistant('Question', member, profile))
      .rejects.toThrow('trả về HTML thay vì JSON (HTTP 200)');

    expect(vi.mocked(globalThis.fetch).mock.calls[0][0])
      .toBe('https://api.example.com/api/gemini/ask-assistant');
  });

  it('uses the shared device executor when an APK has no configured backend URL', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-device-key']);
    generateContentMock.mockResolvedValue({ text: 'Câu trả lời từ Gemini trên thiết bị.' });
    globalThis.fetch = vi.fn();

    const result = await askHealthAssistant('Lần gần nhất tôi khám ở đâu?', member, profile);

    expect(result.answer).toBe('Câu trả lời từ Gemini trên thiết bị.');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('falls back to the shared device executor when an APK backend fetch fails', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-device-key']);
    generateContentMock.mockResolvedValue({ text: 'Câu trả lời sau khi chuyển sang Gemini trực tiếp.' });
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await askHealthAssistant('Lần gần nhất tôi khám ở đâu?', member, profile);

    expect(result.answer).toBe('Câu trả lời sau khi chuyển sang Gemini trực tiếp.');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('streams APK assistant responses directly when the backend URL is missing', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-stream-device-key']);
    generateContentStreamMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: 'Luồng trả lời trực tiếp.' };
      },
    }));
    globalThis.fetch = vi.fn();

    const chunks: string[] = [];
    const result = await streamHealthAssistant(
      'Lần gần nhất tôi khám ở đâu?',
      member,
      profile,
      (chunk) => chunks.push(chunk),
    );

    expect(result.answer).toBe('Luồng trả lời trực tiếp.');
    expect(chunks.join('')).toBe(result.answer);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(generateContentStreamMock).toHaveBeenCalledOnce();
  });

  it('routes APK chat and its AI-resource keys through the shared backend', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-workspace-key']);
    vi.mocked(getFirebaseIdToken).mockResolvedValue('firebase-id-token');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      answer: 'Thông tin tham khảo [1].',
      citations: [{ title: 'WHO', url: 'https://www.who.int/health-topics/example' }],
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));

    const result = await askHealthAssistant(
      'Question',
      member,
      profile,
      [{ role: 'user', text: 'Previous question' }],
    );

    expect(result.answer).toBe('Thông tin tham khảo [1].');
    expect(result.citations).toEqual([
      { title: 'WHO', url: 'https://www.who.int/health-topics/example' },
    ]);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0])
      .toBe('https://api.example.com/api/gemini/ask-assistant');
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers)
      .toMatchObject({ Authorization: 'Bearer firebase-id-token' });
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body.clientGeminiKeys).toEqual(['AIzaSy-workspace-key']);
    expect(body.history).toEqual([{ role: 'user', text: 'Previous question' }]);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('routes APK assistant streaming through the backend and forwards trusted citations', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-stream-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([
      { type: 'sources', citations: [{ title: 'CDC', url: 'https://www.cdc.gov/diabetes/basics/index.html' }] },
      { text: 'Câu trả lời từ backend.' },
      { type: 'done' },
    ]));

    const chunks: string[] = [];
    const sources: Array<{ title: string; url: string }> = [];
    const result = await streamHealthAssistant(
      'Câu hỏi y tế',
      member,
      profile,
      (chunk) => chunks.push(chunk),
      [],
      (citations) => sources.push(...citations),
    );

    expect(result.answer).toBe('Câu trả lời từ backend.');
    expect(chunks.join('')).toBe(result.answer);
    expect(sources).toEqual([
      { title: 'CDC', url: 'https://www.cdc.gov/diabetes/basics/index.html' },
    ]);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0])
      .toBe('https://api.example.com/api/gemini/ask-assistant');
    expect(generateContentStreamMock).not.toHaveBeenCalled();
  });

  it('routes APK OCR through the backend with the same workspace keys', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-ocr-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([{
      type: 'complete',
      extracted: {
        title: 'Kết quả khám',
        type: 'test_result',
        contentIndexPages: ['Nội dung trang 1'],
        contentIndexComplete: true,
      },
      modelUsed: 'gemini-3.5-flash-lite',
      totalPages: 1,
      processedPages: 1,
    }]));

    const result = await extractHealthEventWithProgress(
      new File(['image'], 'report.jpg', { type: 'image/jpeg' }),
      member,
    );

    expect(result.extracted.title).toBe('Kết quả khám');
    expect(result.contentIndexComplete).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0])
      .toBe('https://api.example.com/api/gemini/extract-health-event');
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body.clientGeminiKeys).toEqual(['AIzaSy-ocr-key']);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('runs APK OCR directly when the backend URL is missing', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-ocr-device-key']);
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        title: 'Kết quả khám trực tiếp',
        type: 'test_result',
        pageTexts: ['Nội dung trang 1'],
      }),
    });
    globalThis.fetch = vi.fn();

    const result = await extractHealthEventWithProgress(
      new File(['image'], 'report.jpg', { type: 'image/jpeg' }),
      member,
    );

    expect(result.extracted.title).toBe('Kết quả khám trực tiếp');
    expect(result.contentIndexComplete).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('forwards OCR cancellation to the backend request', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-ocr-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([{
      type: 'complete',
      extracted: { title: 'Kết quả khám' },
      modelUsed: 'gemini-3.5-flash-lite',
      totalPages: 1,
      processedPages: 1,
    }]));
    const controller = new AbortController();

    await extractHealthEventWithProgress(
      new File(['image'], 'report.jpg', { type: 'image/jpeg' }),
      member,
      undefined,
      { signal: controller.signal },
    );

    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('routes comprehensive analysis to the backend with the selected model', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-analysis-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: {
        healthScore: 88,
        overallAssessment: 'Đánh giá tổng quát.',
        crossCorrelations: [],
        velocityTrends: [],
        chronicSurveillance: [],
        roadmap: {
          criticalAlerts: [],
          specialistReferrals: [],
          timeBoundPlan: { next3Months: [], next6Months: [], next12Months: [] },
        },
      },
      modelUsed: 'gemini-4-hydrogen',
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));

    const analysis = await analyzeComprehensiveHealth(member, profile);

    expect(analysis.modelUsed).toBe('gemini-4-hydrogen');
    expect(analysis.result.healthScore).toBe(88);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0])
      .toBe('https://api.example.com/api/gemini/analyze-comprehensive');
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body.model).toBe('gemini-4-hydrogen');
    expect(body.clientGeminiKeys).toEqual(['AIzaSy-analysis-key']);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('does not bypass the central backend when a configured API returns HTML', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-device-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>Not found</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    await expect(askHealthAssistant('Question', member, profile))
      .rejects.toThrow('trả về HTML thay vì JSON (HTTP 404)');

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(generateContentMock).not.toHaveBeenCalled();
  });
});
