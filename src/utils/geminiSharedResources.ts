import { buildApiUrl } from './apiConfig';
import { readApiJson } from './apiResponse';
import { GoogleGenAI } from '@google/genai';

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

export async function getSharedGeminiKeysForRequest(): Promise<string[]> {
  if (sharedGeminiKeysLoad) {
    await sharedGeminiKeysLoad;
  }
  return getSharedGeminiKeys();
}

/**
 * Kiểm tra tính hợp lệ của API Key thông qua server.
 */
export async function testGeminiApiKey(key: string): Promise<{ valid: boolean; workingModel?: string; quotaExhausted?: boolean }> {
  const cleanKey = key.trim();
  if (!cleanKey) {
    throw new Error('API key không được để trống.');
  }

  const url = buildApiUrl('/api/gemini/test-key');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cleanKey }),
    });
  } catch (e) {
    // Direct client-side test fallback for standalone APKs / offline mode when backend is unreachable
    try {
      const ai = new GoogleGenAI({ apiKey: cleanKey });
      await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: 'OK',
        config: { maxOutputTokens: 16 },
      });
      return { valid: true, workingModel: 'gemini-3.5-flash-lite' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|quota/i.test(msg)) {
        return { valid: true, workingModel: 'gemini-3.5-flash-lite', quotaExhausted: true };
      }
      return { valid: false };
    }
  }

  return await readApiJson(response, 'Server Gemini (test-key)');
}
