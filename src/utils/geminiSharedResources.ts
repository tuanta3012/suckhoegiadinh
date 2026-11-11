import { Capacitor, CapacitorHttp } from '@capacitor/core';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LOCAL_AI_KEYS_STORAGE_KEY = 'health_local_ai_resources_keys_v1';

export function parseGeminiKeyInput(input: string): string[] {
  return Array.from(new Set(input.split(/[,\r\n]+/).map((key) => key.trim()).filter(Boolean)));
}

export function getLocalSavedGeminiKeys(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_AI_KEYS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parseGeminiKeyInput(parsed.join(','));
    }
    return [];
  } catch {
    return [];
  }
}

export function saveLocalGeminiKeys(keys: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const cleanKeys = parseGeminiKeyInput(keys.join(','));
    localStorage.setItem(LOCAL_AI_KEYS_STORAGE_KEY, JSON.stringify(cleanKeys));
  } catch (e) {
    console.warn('[AI Resources] Không thể lưu keys vào localStorage:', e);
  }
}

let sharedGeminiKeys: string[] = getLocalSavedGeminiKeys();
let sharedGeminiKeysLoad: Promise<void> | null = null;

export function setSharedGeminiKeys(keys: string[]): void {
  const cleanKeys = parseGeminiKeyInput(keys.join(','));
  sharedGeminiKeys = cleanKeys;
  saveLocalGeminiKeys(cleanKeys);
  sharedGeminiKeysLoad = null;
}

export function trackSharedGeminiKeysLoad(load: Promise<void>): void {
  sharedGeminiKeysLoad = load;
}

export function getSharedGeminiKeys(): string[] {
  if (sharedGeminiKeys.length === 0) {
    const local = getLocalSavedGeminiKeys();
    if (local.length > 0) {
      sharedGeminiKeys = local;
    }
  }
  return [...sharedGeminiKeys];
}

async function requestGemini<T>(
  url: string,
  key: string,
  body: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
): Promise<T> {
  const urlWithKey = url.includes('?')
    ? `${url}&key=${encodeURIComponent(key)}`
    : `${url}?key=${encodeURIComponent(key)}`;

  const headers: Record<string, string> = {
    'x-goog-api-key': key,
  };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: urlWithKey,
      method,
      headers,
      data: method === 'GET' ? undefined : body,
      connectTimeout: 20000,
      readTimeout: 60000,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = typeof response.data === 'object' && response.data !== null
        ? (response.data as { error?: { message?: string } }).error?.message
        : undefined;
      throw new Error(error || `Google Gemini trả về mã lỗi ${response.status}.`);
    }
    return response.data as T;
  }

  const response = await fetch(urlWithKey, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
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

/**
 * Kiểm tra tính hợp lệ của API Key một cách toàn diện và chính xác:
 * - Bước 1: Gọi endpoint metadata Google Gemini API (/models?pageSize=20) để kiểm tra xác thực và lấy danh sách model thực tế.
 * - Bước 2: Thử nghiệm với các model phổ biến (gemini-2.0-flash, gemini-1.5-flash,...).
 * - Nếu key đúng nhưng đang bị rate limit (429), vẫn xác nhận key hợp lệ.
 */
export async function testGeminiApiKey(key: string): Promise<{ valid: boolean; workingModel?: string }> {
  const cleanKey = key.trim();
  if (!cleanKey) {
    throw new Error('API key không được để trống.');
  }

  // Verify the key directly with Google so Web and APK use the same path.
  let modelsMetadataVerified = false;
  let discoveredModels: string[] = [];
  try {
    const modelsRes = await requestGemini<{ models?: Array<{ name?: string }> }>(
      `${GEMINI_API_BASE}/models?pageSize=20`,
      cleanKey,
      {},
      'GET',
    );
    if (modelsRes && Array.isArray(modelsRes.models) && modelsRes.models.length > 0) {
      modelsMetadataVerified = true;
      discoveredModels = modelsRes.models
        .map((m) => (m.name ? m.name.replace(/^models\//, '') : ''))
        .filter(Boolean);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/API_KEY_INVALID|INVALID_ARGUMENT|PERMISSION_DENIED|key not valid|unauthorized|401|403/i.test(msg)) {
      throw new Error(`API key không hợp lệ: ${msg}`);
    }
  }

  // 3. Thử nghiệm với các model phổ biến nhất
  const candidateModels = Array.from(
    new Set([
      ...discoveredModels.filter((m) => m.includes('flash')),
      ...discoveredModels,
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
    ]),
  );

  let lastError: Error | null = null;
  for (const model of candidateModels) {
    try {
      const response = await requestGemini<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }>(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
        cleanKey,
        {
          contents: [{ parts: [{ text: 'OK' }] }],
          generationConfig: { maxOutputTokens: 16, temperature: 0 },
        },
        'POST',
      );
      if (response.candidates?.[0]?.content?.parts?.some((part) => Boolean(part.text?.trim()))) {
        return { valid: true, workingModel: model };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(errMsg);

      // Nếu lỗi Quota 429: Key hoàn toàn đúng, chỉ tạm thời hết quota!
      if (/RESOURCE_EXHAUSTED|429|quota/i.test(errMsg)) {
        return { valid: true, workingModel: model };
      }
      // Nếu 404 (model not found), tiếp tục thử model khác
      if (/404|not found|unsupported/i.test(errMsg)) {
        continue;
      }
      // Nếu API key không hợp lệ
      if (/API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(errMsg)) {
        throw new Error(`API key không hợp lệ: ${errMsg}`);
      }
    }
  }

  // Nếu danh sách models đã được xác thực thành công từ Google, key chắc chắn hợp lệ
  if (modelsMetadataVerified) {
    const fallbackModel = discoveredModels.find((m) => m.includes('flash')) || discoveredModels[0] || 'gemini-2.0-flash';
    return { valid: true, workingModel: fallbackModel };
  }

  throw lastError || new Error('Không thể kiểm tra API key với Google Gemini.');
}

export interface GeminiGenerateOptions {
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export async function generateGeminiContent(
  model: string,
  contents: Array<Record<string, unknown>>,
  options: GeminiGenerateOptions = {},
): Promise<{ text: string; modelUsed: string }> {
  const activeKeys = getSharedGeminiKeys();
  if (activeKeys.length === 0) {
    throw new Error('Chưa có Gemini API key. Hãy vào menu "Tài nguyên AI" để nhập key.');
  }

  const requestBody = {
    contents: contents.map((content) => ({
      role: 'user',
      parts: [
        ...(content.inlineData ? [{ inlineData: content.inlineData }] : []),
        ...(content.text ? [{ text: content.text }] : []),
      ],
    })),
    ...(options.systemInstruction
      ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
      : {}),
    generationConfig: {
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
      ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    },
  };
  let lastError: Error | undefined;

  for (const key of activeKeys) {
    try {
      const response = await requestGemini<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }>(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
        key,
        requestBody,
      );
      const text = response.candidates?.[0]?.content?.parts
        ?.flatMap((part) => typeof part.text === 'string' ? [part.text] : [])
        .join('')
        .trim();
      if (!text) {
        throw new Error(`Gemini không trả về nội dung cho model ${model}.`);
      }
      return { text, modelUsed: model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `Không thể xử lý bằng Gemini với model ${model} qua các API key đã cấu hình. ${lastError?.message || ''}`.trim(),
    { cause: lastError },
  );
}
