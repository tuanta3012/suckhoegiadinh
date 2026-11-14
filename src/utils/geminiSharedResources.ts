import { Capacitor } from '@capacitor/core';
import { buildApiUrl } from './apiConfig';
import { readApiJson } from './apiResponse';
import { testGeminiApiKeyDirect } from './geminiUnifiedExecutor';
import { getFirebaseIdToken } from './googleDriveService';
import { createApiRequestId } from './apiRequestId';
import { digitizationLogger } from './digitizationLogger';

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

  const requestId = createApiRequestId();
  const startedAt = Date.now();
  let response: Response;
  try {
    const url = buildApiUrl('/api/gemini/test-key');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    };
    const token = await getFirebaseIdToken().catch(() => null);
    if (token) headers.Authorization = `Bearer ${token}`;
    digitizationLogger.log('info', 'api_request_start', 'Bắt đầu kiểm tra key qua Gemini gateway.', {
      requestId,
      endpoint: 'test-key',
    });
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: cleanKey }),
    });
  } catch (error) {
    digitizationLogger.log('warn', 'api_request_failed', 'Không kết nối được gateway khi kiểm tra key.', {
      requestId,
      endpoint: 'test-key',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      durationMs: Date.now() - startedAt,
    }, Date.now() - startedAt);
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
    digitizationLogger.log('warn', 'api_request_failed', 'Gateway không sẵn sàng; kiểm tra key trực tiếp.', {
      requestId,
      endpoint: 'test-key',
      status: response.status,
      durationMs: Date.now() - startedAt,
    }, Date.now() - startedAt);
    return await runDirectGeminiKeyTest(cleanKey);
  }

  try {
    const result = await readApiJson<{
      valid: boolean;
      workingModel?: string;
      quotaExhausted?: boolean;
    }>(response, 'Server Gemini (test-key)');
    digitizationLogger.log('info', 'api_request_complete', 'Kiểm tra key qua gateway hoàn tất.', {
      requestId,
      endpoint: 'test-key',
      status: response.status,
      durationMs: Date.now() - startedAt,
    }, Date.now() - startedAt);
    return result;
  } catch (error) {
    digitizationLogger.log('error', 'api_response_error', 'Gateway trả lỗi khi kiểm tra key.', {
      requestId,
      endpoint: 'test-key',
      status: response.status,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      durationMs: Date.now() - startedAt,
    }, Date.now() - startedAt);
    throw error;
  }
}
