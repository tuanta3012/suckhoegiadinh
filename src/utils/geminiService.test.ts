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
  isOcrCancelledError,
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

  it('uses the shared client executor when a static preview has no Gemini API route', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-preview-key']);
    generateContentMock.mockResolvedValue({ text: 'Câu trả lời từ preview.' });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    const result = await askHealthAssistant('Lần gần nhất tôi khám ở đâu?', member, profile);

    expect(result.answer).toBe('Câu trả lời từ preview.');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('does not use the client executor when a configured backend route returns 404', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-preview-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    await expect(askHealthAssistant('Lần gần nhất tôi khám ở đâu?', member, profile))
      .rejects.toThrow('trả về HTML thay vì JSON (HTTP 404)');

    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('streams from the shared client executor when a static preview returns 404', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-preview-stream-key']);
    generateContentStreamMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: 'Câu trả lời streaming từ preview.' };
      },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    const chunks: string[] = [];
    const result = await streamHealthAssistant(
      'Lần gần nhất tôi khám ở đâu?',
      member,
      profile,
      (chunk) => chunks.push(chunk),
    );

    expect(result.answer).toBe('Câu trả lời streaming từ preview.');
    expect(chunks.join('')).toBe(result.answer);
    expect(generateContentStreamMock).toHaveBeenCalledOnce();
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

  it('falls back to the shared device executor when an APK backend returns 404 HTML for streaming', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://ais-pre.example.com');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-apk-404-key']);
    generateContentStreamMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: 'Trả lời fallback từ APK khi backend 404.' };
      },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html><html>404</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    const chunks: string[] = [];
    const result = await streamHealthAssistant(
      'Lần gần nhất tôi khám ở đâu?',
      member,
      profile,
      (chunk) => chunks.push(chunk),
    );

    expect(result.answer).toBe('Trả lời fallback từ APK khi backend 404.');
    expect(chunks.join('')).toBe(result.answer);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(generateContentStreamMock).toHaveBeenCalledOnce();
  });

  it('falls back to the shared device executor when an APK backend returns 404 HTML for OCR', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://ais-pre.example.com');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-apk-ocr-404-key']);
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        title: 'Đơn thuốc nội khoa',
        date: '2026-10-12',
        type: 'prescription',
        diagnoses: ['Tăng huyết áp'],
        medications: [],
        metrics: [],
      }),
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html><html>404</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    const file = new File([new Uint8Array([1, 2, 3])], 'don-thuoc.jpg', { type: 'image/jpeg' });
    const result = await extractHealthEventWithProgress(file, member);

    expect(result.extracted.title).toBe('Đơn thuốc nội khoa');
    expect(result.extracted.date).toBe('2026-10-12');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('falls back to the shared client executor when a static preview returns 200 HTML instead of SSE', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-preview-spa-html-key']);
    generateContentStreamMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: 'Trả lời fallback từ SPA preview.' };
      },
    }));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<!doctype html><div id="root"></div>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));

    const chunks: string[] = [];
    const result = await streamHealthAssistant(
      'Lần gần nhất tôi khám ở đâu?',
      member,
      profile,
      (chunk) => chunks.push(chunk),
    );

    expect(result.answer).toBe('Trả lời fallback từ SPA preview.');
    expect(chunks.join('')).toBe(result.answer);
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

  it('falls back to the shared device executor when a configured APK backend returns 404 HTML', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-device-key']);
    generateContentMock.mockResolvedValue({ text: 'Câu trả lời dự phòng trên APK.' });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>Not found</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));

    const result = await askHealthAssistant('Lần gần nhất tôi khám ở đâu?', member, profile);

    expect(result.answer).toBe('Câu trả lời dự phòng trên APK.');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('compacts bulky profile sources and aiDeepAnalysis while preserving the entire longitudinal timeline for comprehensive analysis', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-compact-key']);
    const { prepareDataForDeepDive } = await import('./healthRecordService');

    const timeline = Array.from({ length: 20 }, (_, idx) => {
      const year = 2021 + Math.floor(idx / 4);
      const month = String((idx % 4) * 3 + 1).padStart(2, '0');
      const date = `${year}-${month}-10`;
      return {
        id: `e${idx + 1}`,
        sourceFileId: `f${idx + 1}`,
        sourceFileName: `doc_${idx + 1}.pdf`,
        type: 'test_result',
        title: `Xét nghiệm mốc ${idx + 1}`,
        date,
        diagnoses: idx === 0 ? ['Tiền tiểu đường (khởi phát 2021)'] : ['Rối loạn lipid'],
        medications: [{ name: `Thuốc ${idx + 1}`, dosage: '10mg' }],
        metrics: [
          { name: 'Cholesterol', standardKey: 'CHOLESTEROL', value: 5.5 + idx * 0.1, unit: 'mmol/L', status: 'high' },
          { name: 'Vitamin D phụ trợ', standardKey: 'VITAMIN_D', value: 42, unit: 'ng/mL', status: 'normal' },
        ],
        ...(idx === 19
          ? {
              imagingResults: [{
                modality: 'Siêu âm ổ bụng',
                findings: 'Thành túi mật có nhiều cấu trúc echo dày, dmax# 5 mm.',
                conclusion: 'Đa polyp túi mật.',
              }],
            }
          : {}),
        recordedAt: `${date}T00:00:00.000Z`,
      };
    });

    const bulkyProfile = {
      schemaVersion: 2,
      member,
      timeline,
      sources: [
        {
          driveFileId: 'f1',
          fileName: 'doc.pdf',
          mimeType: 'application/pdf',
          uploadedAt: '2026-11-10T00:00:00.000Z',
          status: 'processed',
          contentIndexPages: ['Huge raw OCR text '.repeat(1000)],
        },
      ],
      summary: {
        latestDiagnoses: ['Rối loạn lipid'],
        latestMetrics: {},
      },
      aiDeepAnalysis: {
        analyzedAt: '2026-11-10T00:00:00.000Z',
        healthScore: 80,
        overallAssessment: 'Verbose prior analysis',
        crossCorrelations: [],
        velocityTrends: [],
        chronicSurveillance: [],
        roadmap: {
          criticalAlerts: [],
          specialistReferrals: [],
          timeBoundPlan: { next3Months: [], next6Months: [], next12Months: [] },
        },
      },
      createdAt: '2021-01-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z',
    } as unknown as HealthProfile;

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: {
        healthScore: 85,
        overallAssessment: 'OK',
        crossCorrelations: [],
        velocityTrends: [],
        chronicSurveillance: [],
        roadmap: { criticalAlerts: [], specialistReferrals: [], timeBoundPlan: { next3Months: [], next6Months: [], next12Months: [] } },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await analyzeComprehensiveHealth(member, bulkyProfile);
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body.profile.sources).toEqual([]);
    expect(body.profile.aiDeepAnalysis).toBeUndefined();
    expect(body.profile.timeline).toHaveLength(20);
    expect(body.profile.timeline[0].id).toBe('e1');
    expect(body.profile.timeline[19].imagingResults[0]).toMatchObject({
      findings: 'Thành túi mật có nhiều cấu trúc echo dày, dmax# 5 mm.',
      conclusion: 'Đa polyp túi mật.',
    });

    const prepared = prepareDataForDeepDive(member, body.profile);
    expect(prepared.totalEvents).toBe(20);
    expect(prepared.tm).toHaveLength(20);
    expect(prepared.focusWindow.years).toBe(3);
    expect(prepared.focusWindow.historicalBefore3YearsCount).toBeGreaterThan(0);
    expect(prepared.focusWindow.recent3YearsEventCount).toBeGreaterThan(0);
    expect(prepared.tm[0].d).toBe('2021-01-10');
    expect(prepared.tm[0].inFocus3Y).toBe(false);
    expect(prepared.tm[0].diag).toContain('Tiền tiểu đường (khởi phát 2021)');
    expect(prepared.tm[0].meds).toEqual([{ n: 'Thuốc 1', dos: '10mg' }]);
    expect(prepared.tm[0].metrics?.map((m: { key: string }) => m.key)).toEqual(['CHOLESTEROL']);
    expect(prepared.tm[prepared.tm.length - 1].inFocus3Y).toBe(true);
    expect(prepared.tm[prepared.tm.length - 1].metrics?.map((m: { key: string }) => m.key)).toEqual([
      'CHOLESTEROL',
      'VITAMIN_D',
    ]);
    expect(prepared.tm[19].img).toEqual([{
      mod: 'Siêu âm ổ bụng',
      finding: 'Thành túi mật có nhiều cấu trúc echo dày, dmax# 5 mm.',
      conclusion: 'Đa polyp túi mật.',
    }]);
  });

  it('preserves quantitative ultrasound findings for assistant questions', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-assistant-imaging-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      answer: 'Hồ sơ ghi nhận polyp túi mật dmax 5 mm.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await askHealthAssistant('Kích thước polyp túi mật là bao nhiêu?', member, {
      ...profile,
      timeline: [{
        id: 'ultrasound-1',
        sourceFileId: 'file-1',
        sourceFileName: 'ultrasound.pdf',
        type: 'imaging',
        title: 'Siêu âm ổ bụng',
        date: '2026-06-08',
        diagnoses: [],
        medications: [],
        metrics: [],
        imagingResults: [{
          modality: 'Siêu âm ổ bụng',
          findings: 'Đa polyp túi mật, dmax# 5 mm.',
          conclusion: 'Đa polyp túi mật.',
        }],
        recordedAt: '2026-06-08T00:00:00.000Z',
      }],
    });

    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body.profile.timeline[0].imagingResults[0]).toMatchObject({
      findings: 'Đa polyp túi mật, dmax# 5 mm.',
      conclusion: 'Đa polyp túi mật.',
    });
  });

  it('falls back from APK direct streaming to non-stream execution when stream fails with zero chunks', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-fallback-key']);
    generateContentStreamMock.mockRejectedValue(new TypeError('Failed to fetch'));
    generateContentMock.mockResolvedValue({ text: 'Câu trả lời dự phòng non-stream.' });

    const chunks: string[] = [];
    const result = await streamHealthAssistant(
      'Lần gần nhất khám ở đâu?',
      member,
      profile,
      (chunk) => chunks.push(chunk),
    );

    expect(result.answer).toBe('Câu trả lời dự phòng non-stream.');
    expect(chunks.join('')).toBe('Câu trả lời dự phòng non-stream.');
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('forwards referenced familyContexts including blood pressure vitals to backend and direct fallback', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-family-key']);
    const tuAnh = { id: 'm2', name: 'Vũ Thị Tú Anh' } as FamilyMember;
    const tuAnhProfile = {
      schemaVersion: 2,
      member: tuAnh,
      timeline: [{
        id: 'evt-bp',
        sourceFileId: 'f-bp',
        sourceFileName: 'kham.pdf',
        type: 'comprehensive_exam',
        title: 'Khám sức khỏe',
        date: '2026-06-15',
        physicalExam: { bp_mmHg: '115/75', pulse_bpm: 72 },
        diagnoses: [],
        medications: [],
        metrics: [],
        recordedAt: '2026-06-15T00:00:00.000Z',
      }],
      sources: [],
      summary: { latestDiagnoses: [], latestMetrics: {} },
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    } as unknown as HealthProfile;

    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([
      { text: 'Huyết áp của Vũ Thị Tú Anh ngày 2026-06-15 là 115/75 mmHg.' },
      { type: 'done' },
    ]));

    const chunks: string[] = [];
    const result = await streamHealthAssistant(
      'Huyết áp của Tú Anh là bao nhiêu ',
      member,
      profile,
      (chunk) => chunks.push(chunk),
      [],
      undefined,
      [{ member: tuAnh, profile: tuAnhProfile }],
    );

    expect(result.answer).toContain('115/75');
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body.familyContexts).toHaveLength(1);
    expect(body.familyContexts[0].member.name).toBe('Vũ Thị Tú Anh');
    expect(body.familyContexts[0].profile.timeline[0].physicalExam.bp_mmHg).toBe('115/75');

    // Now test direct APK streaming fallback sends referencedFamilyMembers in prompt JSON
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    generateContentStreamMock.mockImplementation(async (_apiKey: string, args: any) => {
      const promptJson = JSON.parse(args.contents[0].text);
      expect(promptJson.referencedFamilyMembers).toHaveLength(1);
      expect(promptJson.referencedFamilyMembers[0].memberName).toBe('Vũ Thị Tú Anh');
      expect(promptJson.referencedFamilyMembers[0].healthProfile.latestPhysicalExam.bp_mmHg).toBe('115/75');
      return {
        async *[Symbol.asyncIterator]() {
          yield { text: 'Huyết áp của Vũ Thị Tú Anh là 115/75 mmHg.' };
        },
      };
    });

    const directResult = await streamHealthAssistant(
      'Huyết áp của Tú Anh là bao nhiêu ',
      member,
      profile,
      () => {},
      [],
      undefined,
      [{ member: tuAnh, profile: tuAnhProfile }],
    );
    expect(directResult.answer).toContain('115/75');
  });

  it('correctly detects cancellation errors via isOcrCancelledError', () => {
    const abortedSignal = AbortSignal.abort();
    expect(isOcrCancelledError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isOcrCancelledError(new Error('Tác vụ số hóa đã được dừng lại.'))).toBe(true);
    expect(isOcrCancelledError(new Error('OCR was cancelled.'))).toBe(true);
    expect(isOcrCancelledError(new Error('Failed to fetch'), abortedSignal)).toBe(true);
    expect(isOcrCancelledError(new Error('503 Service Unavailable'))).toBe(false);
  });

  it('propagates server SSE error messages instead of swallowing them', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([
      {
        type: 'error',
        error: 'Máy chủ AI Google hiện đang bận hoặc quá tải (503 Service Unavailable).',
      },
    ]));

    await expect(extractHealthEventWithProgress(
      new File(['data'], 'test.pdf', { type: 'application/pdf' }),
      member,
    )).rejects.toThrow('503 Service Unavailable');
  });

  it('does not fall back to direct OCR when an in-flight request is cancelled', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('The user aborted a request.', 'AbortError');
    });

    await expect(extractHealthEventWithProgress(
      new File(['data'], 'test.pdf', { type: 'application/pdf' }),
      member,
      undefined,
      { signal: controller.signal },
    )).rejects.toThrow();

    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('forwards extractedData, bloodType, and older blood-group events beyond the latest 12 events to assistant', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-blood-group-key']);

    const olderBloodEvent = {
      id: 'evt-blood-2024',
      sourceFileId: 'f-blood',
      sourceFileName: 'nhom_mau.pdf',
      type: 'test_result' as const,
      title: 'Kết quả xét nghiệm nhóm máu',
      date: '2024-05-29',
      diagnoses: [],
      medications: [],
      metrics: [],
      extractedData: {
        nhom_mau: 'AB',
        rhesus_factor: 'Dương',
      },
      notes: 'Nhóm máu (ABO + Rhesus) tự động: AB, Rhesus Factor: Dương.',
      recordedAt: '2024-05-29T00:00:00.000Z',
    };
    const newerEvents = Array.from({ length: 14 }, (_, idx) => ({
      id: `evt-new-${idx + 1}`,
      sourceFileId: `f-${idx + 1}`,
      sourceFileName: `doc-${idx + 1}.pdf`,
      type: 'medical_report' as const,
      title: `Khám định kỳ ${idx + 1}`,
      date: `2025-${String((idx % 12) + 1).padStart(2, '0')}-15`,
      diagnoses: [],
      medications: [],
      metrics: [],
      recordedAt: `2025-${String((idx % 12) + 1).padStart(2, '0')}-15T00:00:00.000Z`,
    }));

    let capturedPromptJson: any;
    generateContentStreamMock.mockImplementation(async (_apiKey: string, args: any) => {
      capturedPromptJson = JSON.parse(args.contents[0].text);
      return {
        async *[Symbol.asyncIterator]() {
          yield { text: 'Nhóm máu của bạn là AB, Rh Dương.' };
        },
      };
    });

    const result = await streamHealthAssistant(
      'Nhóm máu của tôi là gì',
      member,
      {
        ...profile,
        timeline: [olderBloodEvent, ...newerEvents],
      },
      () => {},
    );

    expect(result.answer).toContain('AB');
    expect(capturedPromptJson.healthProfile.bloodType).toBe('AB (Rh Dương)');
    expect(capturedPromptJson.healthProfile.latestMetrics.BLOOD_GROUP.value).toBe('AB');
    expect(capturedPromptJson.healthProfile.latestExtractedData.nhom_mau.value).toBe('AB');
    expect(
      capturedPromptJson.healthProfile.olderTimelineHighlights.some(
        (evt: any) => evt.extractedData?.nhom_mau === 'AB',
      ),
    ).toBe(true);
  });
});

