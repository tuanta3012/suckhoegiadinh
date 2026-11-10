import { Capacitor, CapacitorHttp } from '@capacitor/core';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OCR_MODEL = 'gemini-3.5-flash-lite';

let sharedGeminiKeys: string[] = [];
let sharedGeminiKeysLoad: Promise<void> | null = null;

export function parseGeminiKeyInput(input: string): string[] {
  return Array.from(new Set(input.split(/[,\r\n]+/).map((key) => key.trim()).filter(Boolean)));
}

export function setSharedGeminiKeys(keys: string[]): void {
  sharedGeminiKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
  sharedGeminiKeysLoad = null;
}

export function trackSharedGeminiKeysLoad(load: Promise<void>): void {
  sharedGeminiKeysLoad = load;
}

export function getSharedGeminiKeys(): string[] {
  return [...sharedGeminiKeys];
}

async function requestGemini<T>(url: string, key: string, body: Record<string, unknown>): Promise<T> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      data: body,
      connectTimeout: 20000,
      readTimeout: 300000,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = typeof response.data === 'object' && response.data !== null
        ? (response.data as { error?: { message?: string } }).error?.message
        : undefined;
      throw new Error(error || `Google Gemini trả về mã lỗi ${response.status}.`);
    }
    return response.data as T;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof data === 'object' && data !== null
      ? (data as { error?: { message?: string } }).error?.message
      : undefined;
    throw new Error(error || `Google Gemini trả về mã lỗi ${response.status}.`);
  }
  return data as T;
}

export async function testGeminiApiKey(key: string): Promise<void> {
  const response = await requestGemini<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(
    `${GEMINI_API_BASE}/models/${OCR_MODEL}:generateContent`,
    key,
    {
      contents: [{ parts: [{ text: 'Reply with OK only.' }] }],
      generationConfig: { maxOutputTokens: 4, temperature: 0 },
    },
  );
  if (!response.candidates?.[0]?.content?.parts?.some((part) => Boolean(part.text?.trim()))) {
    throw new Error('Gemini không trả về nội dung kiểm tra hợp lệ.');
  }
}

export interface GeminiGenerateOptions {
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export async function generateNativeGeminiContent(
  model: string,
  contents: Array<Record<string, unknown>>,
  options: GeminiGenerateOptions = {},
): Promise<{ text: string; modelUsed: string }> {
  if (sharedGeminiKeysLoad) await sharedGeminiKeysLoad;
  if (sharedGeminiKeys.length === 0) {
    throw new Error('Chưa có Gemini API key. Hãy liên kết folder dùng chung hoặc nhờ quản trị viên cấu hình Tài nguyên AI.');
  }

  let lastError: Error | undefined;
  for (const key of sharedGeminiKeys) {
    try {
      const response = await requestGemini<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        promptFeedback?: { blockReason?: string };
      }>(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, key, {
        contents: contents.map((content) => {
          if ('text' in content) return { role: 'user', parts: [{ text: content.text }] };
          return {
            role: 'user',
            parts: [
              ...(content.inlineData ? [{ inlineData: content.inlineData }] : []),
              ...(content.text ? [{ text: content.text }] : []),
            ],
          };
        }),
        ...(options.systemInstruction
          ? { systemInstruction: { parts: [{ text: options.systemInstruction }] }
          }
          : {}),
        generationConfig: {
          ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
          ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        },
      });
      const text = response.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim();
      if (!text) {
        throw new Error(response.promptFeedback?.blockReason
          ? `Gemini từ chối yêu cầu (${response.promptFeedback.blockReason}).`
          : 'Gemini không trả về nội dung.');
      }
      return { text, modelUsed: model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Tất cả Gemini API key đều thất bại: ${lastError?.message || 'Lỗi không xác định.'}`);
}
