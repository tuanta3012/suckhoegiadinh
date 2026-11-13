import { Capacitor } from '@capacitor/core';
import { buildApiUrl } from './apiConfig';
import { readApiJson } from './apiResponse';
import { testGeminiApiKeyDirect } from './geminiUnifiedExecutor';
import { getFirebaseIdToken } from './googleDriveService';

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

function isNativeApkRuntime(): boolean {
  return (
    Capacitor.isNativePlatform() ||
    import.meta.env.VITE_APP_MODE === 'apk' ||
    import.meta.env.VITE_APP_MODE === 'play'
  );
}

async function runDirectGeminiKeyTest(
  cleanKey: string,
): Promise<{ valid: boolean; workingModel?: string; quotaExhausted?: boolean }> {
  const direct = await testGeminiApiKeyDirect(cleanKey);
  if (!direct.valid) {
    throw new Error(direct.error || 'API key không hợp lệ.');
  }
  return {
    valid: true,
    workingModel: direct.workingModel,
    ...(direct.quotaExhausted ? { quotaExhausted: true } : {}),
  };
}

/**
 * Kiểm tra tính hợp lệ của API Key trực tiếp trên APK hoặc qua server proxy trên Web.
 */
export async function testGeminiApiKey(key: string): Promise<{ valid: boolean; workingModel?: string; quotaExhausted?: boolean }> {
  const cleanKey = key.trim();
  if (!cleanKey) {
    throw new Error('API key không được để trống.');
  }

  if (isNativeApkRuntime()) {
    return await runDirectGeminiKeyTest(cleanKey);
  }

  let response: Response;
  try {
    const url = buildApiUrl('/api/gemini/test-key');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await getFirebaseIdToken().catch(() => null);
    if (token) headers.Authorization = `Bearer ${token}`;
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: cleanKey }),
    });
  } catch {
    return await runDirectGeminiKeyTest(cleanKey);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (
    response.status === 404 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504 ||
    contentType.includes('text/html')
  ) {
    return await runDirectGeminiKeyTest(cleanKey);
  }

  return await readApiJson(response, 'Server Gemini (test-key)');
}
