import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { PDFDocument } from 'pdf-lib';
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
  getValidGoogleAccessToken: vi.fn().mockResolvedValue(null),
}));

vi.mock('./geminiSharedResources', () => ({
  getSharedGeminiKeysForRequest: vi.fn().mockResolvedValue([]),
}));

import {
  analyzeComprehensiveHealth,
  askHealthAssistant,
  extractHealthEventWithProgress,
  resetClientGeminiKeyStateForTests,
  streamHealthAssistant,
} from './geminiService';
import { getSharedGeminiKeysForRequest } from './geminiSharedResources';

describe('askHealthAssistant API routing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetClientGeminiKeyStateForTests();
    generateContentMock.mockReset();
    generateContentStreamMock.mockReset();
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue([]);
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

  it('fails before fetching when an APK has no configured backend URL and no client keys', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue([]);
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

  it('falls back to client-side GoogleGenAI with Google Search citations and key failover on APK when backend URL is not configured', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-key-1', 'AIzaSy-key-2']);
    globalThis.fetch = vi.fn();

    // 1. Research step (AIzaSy-key-1): returns Google Search grounding from approved medical domain
    // 2. Answer step (AIzaSy-key-2 via round-robin): hits 503, fails back to AIzaSy-key-1
    generateContentMock
      .mockResolvedValueOnce({
        text: 'Tăng huyết áp là tình trạng áp lực máu lên thành động mạch tăng cao.',
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { title: 'WHO Hypertension', uri: 'https://www.who.int/news-room/fact-sheets/detail/hypertension' } },
              ],
            },
          },
        ],
      })
      .mockRejectedValueOnce({ status: 503, message: '503 Service Unavailable' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          success: true,
          answer: 'Khám gần nhất tại BV Đại học Y [1].',
          citations: [],
        }),
      });

    const result = await askHealthAssistant(
      'Tăng huyết áp là gì và lần gần nhất khám ở đâu?',
      { id: 'm1', name: 'Vũ Thị Tú Anh' } as FamilyMember,
      { timeline: [] } as unknown as HealthProfile,
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(generateContentMock).toHaveBeenCalledTimes(3);
    expect(generateContentMock.mock.calls[0][0]).toBe('AIzaSy-key-1');
    expect(generateContentMock.mock.calls[1][0]).toBe('AIzaSy-key-2');
    expect(generateContentMock.mock.calls[2][0]).toBe('AIzaSy-key-1');
    expect(result.answer).toBe('Khám gần nhất tại BV Đại học Y [1].');
    expect(result.citations).toEqual([
      {
        title: 'WHO Hypertension',
        url: 'https://www.who.int/news-room/fact-sheets/detail/hypertension',
      },
    ]);
  });

  it('streams chunks and emits trusted citations via Google Search on APK standalone streamHealthAssistant', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-stream-1', 'AIzaSy-stream-2']);
    globalThis.fetch = vi.fn();

    generateContentMock.mockResolvedValueOnce({
      text: 'Hướng dẫn từ Bộ Y tế và WHO về kiểm soát đường huyết.',
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'CDC Diabetes', uri: 'https://www.cdc.gov/diabetes/basics/diabetes.html' } },
            ],
          },
        },
      ],
    });

    generateContentStreamMock.mockResolvedValueOnce((async function* () {
      yield { text: 'Đường huyết ' };
      yield { text: 'bình thường [1].' };
    })());

    const chunks: string[] = [];
    const emittedSources: Array<{ title: string; url: string }> = [];
    const result = await streamHealthAssistant(
      'Đường huyết bao nhiêu là bình thường?',
      { id: 'm1', name: 'Trương Anh Tuấn' } as FamilyMember,
      { timeline: [] } as unknown as HealthProfile,
      (chunk) => chunks.push(chunk),
      [],
      (sources) => emittedSources.push(...sources),
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(chunks.join('')).toBe('Đường huyết bình thường [1].');
    expect(result.answer).toBe('Đường huyết bình thường [1].');
    expect(emittedSources).toEqual([
      { title: 'CDC Diabetes', url: 'https://www.cdc.gov/diabetes/basics/diabetes.html' },
    ]);
    expect(result.citations).toEqual(emittedSources);
  });

  it('sends multi-page PDFs as a whole file first with key failover on APK client OCR', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-ocr-key-1', 'AIzaSy-ocr-key-2']);

    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) doc.addPage();
    const pdfBytes = await doc.save();
    const file = new File([pdfBytes], 'tuanta 2026.pdf', { type: 'application/pdf' });

    // Whole-file 1-pass: key-1 hits 429, key-2 succeeds for all 6 pages at once
    generateContentMock
      .mockRejectedValueOnce({ status: 429, message: 'RESOURCE_EXHAUSTED quota' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Khám sức khỏe tổng quát 2026',
          date: '2026-06-15',
          type: 'comprehensive_exam',
          patientName: 'Trương Anh Tuấn',
          diagnoses: ['Gan nhiễm mỡ nhẹ', 'Rối loạn lipid máu'],
          metrics: [
            { name: 'Creatinin', standardKey: 'CREATININ', value: 84, unit: 'umol/L' },
            { name: 'eGFR', standardKey: 'EGFR', value: 92, unit: 'mL/min' },
          ],
          pageTexts: ['Trang 1', 'Trang 2', 'Trang 3', 'Trang 4', 'Trang 5', 'Trang 6'],
        }),
      });

    const result = await extractHealthEventWithProgress(
      file,
      { id: 'm1', name: 'Staging' } as FamilyMember,
      undefined,
      { isAutoDetect: true },
    );

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(result.totalPages).toBe(6);
    expect(result.processedPages).toBe(6);
    expect(result.contentIndexComplete).toBe(true);
    expect(result.contentIndexPages).toHaveLength(6);
    expect(result.extracted.patientName).toBe('Trương Anh Tuấn');
    expect(result.extracted.metrics?.length).toBeGreaterThanOrEqual(2);
  });

  it('automatically falls back to context-preserving PDF chunks when whole-PDF OCR fails with timeout/504', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-chunk-key-1', 'AIzaSy-chunk-key-2']);

    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) doc.addPage();
    const pdfBytes = await doc.save();
    const file = new File([pdfBytes], 'tuanta-large-2026.pdf', { type: 'application/pdf' });

    // Whole-file attempt hits 504 on both keys -> triggers fallback into 2 chunks (pages 1-4 & 5-6)
    generateContentMock
      .mockRejectedValueOnce({ status: 504, message: '504 Gateway Timeout' })
      .mockRejectedValueOnce({ status: 504, message: '504 Gateway Timeout' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Khám sức khỏe tổng quát 2026',
          date: '2026-06-15',
          type: 'comprehensive_exam',
          patientName: 'Trương Anh Tuấn',
          diagnoses: ['Gan nhiễm mỡ nhẹ'],
          metrics: [{ name: 'Creatinin', standardKey: 'CREATININ', value: 84, unit: 'umol/L' }],
          pageTexts: ['Trang 1', 'Trang 2', 'Trang 3', 'Trang 4'],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'Khám sức khỏe tổng quát 2026',
          date: '2026-06-15',
          type: 'comprehensive_exam',
          patientName: 'Trương Anh Tuấn',
          diagnoses: ['Rối loạn lipid máu'],
          metrics: [{ name: 'eGFR', standardKey: 'EGFR', value: 92, unit: 'mL/min' }],
          pageTexts: ['Trang 5', 'Trang 6'],
        }),
      });

    const result = await extractHealthEventWithProgress(
      file,
      { id: 'm1', name: 'Staging' } as FamilyMember,
      undefined,
      { isAutoDetect: true },
    );

    expect(generateContentMock).toHaveBeenCalledTimes(4);
    expect(result.totalPages).toBe(6);
    expect(result.processedPages).toBe(6);
    expect(result.contentIndexComplete).toBe(true);
    expect(result.contentIndexPages).toHaveLength(6);
    expect(result.extracted.patientName).toBe('Trương Anh Tuấn');
    expect(result.extracted.metrics?.length).toBeGreaterThanOrEqual(2);
  });

  it('persists shared GeminiQuotaScheduler state across sequential APK requests so invalid keys are skipped immediately', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-bad-key-1', 'AIzaSy-good-key-2']);
    globalThis.fetch = vi.fn();

    // Ask 1: research tries bad-key-1 (400 API_KEY_INVALID -> excluded permanently), falls back to good-key-2,
    // then answer skips bad-key-1 and runs directly on good-key-2.
    // Ask 2: both research and answer skip bad-key-1 immediately and run on good-key-2.
    generateContentMock
      .mockRejectedValueOnce({ status: 400, message: 'API_KEY_INVALID: bad key' })
      .mockResolvedValueOnce({ text: 'Tóm tắt tham khảo 1' })
      .mockResolvedValueOnce({
        text: JSON.stringify({ success: true, answer: 'Trả lời 1', citations: [] }),
      })
      .mockResolvedValueOnce({ text: 'Tóm tắt tham khảo 2' })
      .mockResolvedValueOnce({
        text: JSON.stringify({ success: true, answer: 'Trả lời 2', citations: [] }),
      });

    const first = await askHealthAssistant(
      'Câu hỏi 1',
      { id: 'm1', name: 'Vũ Thị Tú Anh' } as FamilyMember,
      { timeline: [] } as unknown as HealthProfile,
    );
    const second = await askHealthAssistant(
      'Câu hỏi 2',
      { id: 'm1', name: 'Vũ Thị Tú Anh' } as FamilyMember,
      { timeline: [] } as unknown as HealthProfile,
    );

    expect(first.answer).toBe('Trả lời 1');
    expect(second.answer).toBe('Trả lời 2');
    expect(generateContentMock).toHaveBeenCalledTimes(5);
    expect(generateContentMock.mock.calls[0][0]).toBe('AIzaSy-bad-key-1');
    expect(generateContentMock.mock.calls[1][0]).toBe('AIzaSy-good-key-2');
    expect(generateContentMock.mock.calls[2][0]).toBe('AIzaSy-good-key-2');
    expect(generateContentMock.mock.calls[3][0]).toBe('AIzaSy-good-key-2');
    expect(generateContentMock.mock.calls[4][0]).toBe('AIzaSy-good-key-2');
  });

  it('uses gemini-4-hydrogen directly on APK when client keys exist even if VITE_BACKEND_URL is baked in', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://baked-backend.example.com');
    vi.stubEnv('VITE_APP_MODE', 'apk');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-apk-4h-key']);
    globalThis.fetch = vi.fn();

    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({
        healthScore: 88,
        overallAssessment: 'Tổng quan ổn định.',
        crossCorrelations: [],
        velocityTrends: [],
        chronicSurveillance: [],
        roadmap: {
          criticalAlerts: [],
          specialistReferrals: [],
          timeBoundPlan: { next3Months: [], next6Months: [], next12Months: [] },
        },
      }),
    });

    const analysis = await analyzeComprehensiveHealth(
      { id: 'm1', name: 'Trương Anh Tuấn' } as FamilyMember,
      { timeline: [], metrics: [] } as unknown as HealthProfile,
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const callArgs = generateContentMock.mock.calls[0][1] as { model: string };
    expect(callArgs.model).toBe('gemini-4-hydrogen');
    expect(analysis.modelUsed).toBe('gemini-4-hydrogen');
    expect(analysis.result.healthScore).toBe(88);
  });

  it('falls back to client-side keys on Web if backend returns 502 HTML while Tài nguyên AI has keys', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com');
    vi.mocked(getSharedGeminiKeysForRequest).mockResolvedValue(['AIzaSy-web-fallback-key']);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    }));

    generateContentMock
      .mockResolvedValueOnce({ text: 'Thông tin tổng hợp' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          success: true,
          answer: 'Trả lời qua fallback client key.',
          citations: [],
        }),
      });

    const result = await askHealthAssistant(
      'Hỏi thử',
      { id: 'm1', name: 'Vũ Thị Tú Anh' } as FamilyMember,
      { timeline: [] } as unknown as HealthProfile,
    );

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('Trả lời qua fallback client key.');
  });
});

