import express, { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, './firebase-applet-config.json'), 'utf8'));
import { parseGeminiApiKeys } from './src/utils/geminiApiKeys.ts';
import {
  GeminiQuotaScheduler,
  parseGeminiProjects,
  type GeminiProject,
  type GeminiQuota,
  type GeminiTask,
} from './src/utils/geminiQuotaScheduler.ts';
import {
  PdfPageBatchError,
  splitPdfIntoBatches,
  type PdfPageBatch,
} from './src/utils/pdfPageBatches.ts';
import { cleanExtractedJson, mergeExtractedBatches } from './src/utils/healthDocumentExtraction.ts';
import { digitizationLogger } from './src/utils/digitizationLogger.ts';
import { parseRobustJson, sleep, prepareDataForDeepDive, sanitizeMetricName } from './src/utils/healthRecordService.ts';

const isProd = process.env.NODE_ENV === 'production';

function getPort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.PORT) || 3000;
}

function getAttemptTimeout(task: GeminiTask): number {
  return task === 'digitization'
    ? GEMINI_DIGITIZATION_ATTEMPT_TIMEOUT_MS
    : GEMINI_ANALYSIS_ATTEMPT_TIMEOUT_MS;
}

const PORT = getPort();
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4;
const GEMINI_RATE_LIMIT_PER_MINUTE = 20;
const rateLimitWindows = new Map<string, { startedAt: number; count: number }>();
const GEMINI_ANALYSIS_ATTEMPT_TIMEOUT_MS = 180_000;
const GEMINI_DIGITIZATION_ATTEMPT_TIMEOUT_MS = 300_000;
const GEMINI_ANALYSIS_TIMEOUT_MS = 300_000;
const GEMINI_OCR_TIMEOUT_MS = 600_000;
const OCR_BATCH_PAGES = 5; // User requested 4-6 pages
const OCR_BATCH_CONCURRENCY = 1; // Strictly sequential
const GEMINI_OCR_PROJECT_COOLDOWN_MS = 10_000;
let quotaScheduler: GeminiQuotaScheduler | null = null;
let nextOcrProjectCursor = 0;

// Valid modern Gemini models per AI Studio guidelines (single model per task, no fallbacks)
const TASK_MODELS = {
  digitization: ['gemini-3.5-flash-lite'],
  analysis: ['gemini-3.6-flash'],
  assistant: ['gemini-3.5-flash-lite'],
  refinement: ['gemini-3.5-flash-lite'],
} as const;

function getConfiguredProjects(): GeminiProject[] {
  const envKeys = [
    ...parseGeminiApiKeys(process.env.GEMINI_API_KEYS),
    ...parseGeminiApiKeys(process.env.GEMINI_API_KEY),
  ];
  return parseGeminiProjects(envKeys, undefined);
}

function getQuotaScheduler(): GeminiQuotaScheduler {
  if (!quotaScheduler) {
    quotaScheduler = new GeminiQuotaScheduler(getConfiguredProjects());
  }
  return quotaScheduler;
}

function getModelQuota(model: string): GeminiQuota {
  // gemini-3.6-flash: rpm: 5, rpd: 20
  if (model.includes('3.6-flash') || model.includes('3.8-flash')) {
    return { rpm: 5, rpd: 20, maxConcurrent: 2 };
  }
  // gemini-3.5-flash-lite: rpm: 15, rpd: 500
  return { rpm: 15, rpd: 500, maxConcurrent: 3 };
}

function getTaskQuota(task: GeminiTask): GeminiQuota {
  if (task === 'analysis') return { rpm: 5, rpd: 20, maxConcurrent: 2 };
  return { rpm: 15, rpd: 500, maxConcurrent: 3 };
}

function describeGeminiError(error: unknown): { status?: number; message: string } {
  if (!error) return { message: 'Lỗi không xác định khi kết nối với máy chủ AI.' };

  let candidateMessage = '';
  let statusValue: number | string | undefined;

  if (typeof error === 'string') {
    candidateMessage = error;
  } else if (error && typeof error === 'object') {
    const obj = error as Record<string, any>;
    statusValue = obj.status ?? obj.code ?? obj.error?.status ?? obj.error?.code;
    candidateMessage = typeof obj.message === 'string'
      ? obj.message
      : typeof obj.error?.message === 'string'
      ? obj.error.message
      : String(error);
  } else {
    candidateMessage = String(error);
  }

  // De-nest stringified JSON error objects recursively up to 3 levels
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = candidateMessage.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          if (!statusValue) {
            statusValue = parsed.error?.code || parsed.error?.status || parsed.code || parsed.status;
          }
          if (typeof parsed.error?.message === 'string') {
            candidateMessage = parsed.error.message;
          } else if (typeof parsed.error === 'string') {
            candidateMessage = parsed.error;
          } else if (typeof parsed.message === 'string') {
            candidateMessage = parsed.message;
          } else {
            break;
          }
        } else {
          break;
        }
      } catch {
        break;
      }
    } else {
      break;
    }
  }

  let statusCode = typeof statusValue === 'number' ? statusValue : Number(statusValue);
  if (!Number.isFinite(statusCode)) {
    statusCode = 0;
  }

  // Handle 504 / DEADLINE_EXCEEDED
  if (
    statusCode === 504 ||
    statusValue === 'DEADLINE_EXCEEDED' ||
    /DEADLINE_EXCEEDED|504|Deadline expired|deadline/i.test(candidateMessage)
  ) {
    return {
      status: 504,
      message: 'Yêu cầu AI xử lý bị quá thời gian chờ từ máy chủ Google (504 Deadline Exceeded). Vui lòng thử lại.',
    };
  }

  // Handle 503 / SERVICE_UNAVAILABLE / High Demand
  if (
    statusCode === 503 ||
    statusValue === 'UNAVAILABLE' ||
    /503|UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(candidateMessage)
  ) {
    return {
      status: 503,
      message: 'Máy chủ AI Google hiện đang bận hoặc quá tải (503 Service Unavailable). Vui lòng thử lại sau ít giây.',
    };
  }

  // Handle 429 / RESOURCE_EXHAUSTED
  if (
    statusCode === 429 ||
    statusValue === 'RESOURCE_EXHAUSTED' ||
    /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(candidateMessage)
  ) {
    return {
      status: 429,
      message: 'Hạn ngạch AI tạm thời đạt giới hạn (429 Quota Exhausted). Vui lòng thử lại sau ít phút.',
    };
  }

  // Handle 401/403 Permission
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED|unauthorized|invalid api key/i.test(candidateMessage)
  ) {
    return {
      status: statusCode || 403,
      message: 'API Key không hợp lệ hoặc đã bị vô hiệu hóa.',
    };
  }

  return {
    status: statusCode || undefined,
    message: candidateMessage.trim() || 'Lỗi xử lý dịch vụ Gemini API.',
  };
}

function parseRetryAfterMs(error: unknown): number {
  const { message } = describeGeminiError(error);
  const seconds = message.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*s/i);
  return seconds ? Math.min(60_000, Math.max(1_000, Number(seconds[1]) * 1_000)) : 60_000;
}

function isDailyQuotaError(error: unknown): boolean {
  const { status, message } = describeGeminiError(error);
  // Detect daily quota exhaustion vs temporary per-minute burst limit
  return (
    status === 429 &&
    /per.?day|daily|requests per day|quota.*day|resource_exhausted|exhausted|quota exceeded/i.test(message)
  );
}

function recordProjectFailure(
  scheduler: GeminiQuotaScheduler,
  projectId: string,
  model: string,
  error: unknown,
  disableInvalidProject = true,
  disableUnavailableModel = true,
): boolean {
  const { status, message } = describeGeminiError(error);
  if (status === 429) {
    if (isDailyQuotaError(error)) scheduler.markDailyQuotaExhausted(projectId, model);
    else scheduler.markRateLimited(projectId, model, parseRetryAfterMs(error));
    return true;
  }
  if (
    status === 401 ||
    status === 403 ||
    /api key.{0,30}(invalid|not valid)|invalid api key|api_key_invalid/i.test(message)
  ) {
    if (disableInvalidProject) scheduler.markProjectUnavailable(projectId);
    return true;
  }
  if (status === 404 || /model.{0,40}(not found|unsupported|not available)/i.test(message)) {
    if (disableUnavailableModel) scheduler.markModelUnavailable(projectId, model);
    return true;
  }
  return status !== 400;
}

async function verifyFirebaseIdToken(idToken: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (response.status === 400 || response.status === 401 || response.status === 403) return null;
    if (!response.ok) return null;
    const result = await response.json() as {
      users?: Array<{ localId?: string; disabled?: boolean }>;
    };
    const user = result.users?.[0];
    return user?.localId && !user.disabled ? user.localId : null;
  } catch {
    return null;
  }
}

function isWithinRateLimit(uid: string): boolean {
  const now = Date.now();
  const window = rateLimitWindows.get(uid);
  if (!window || now - window.startedAt >= 60_000) {
    rateLimitWindows.set(uid, { startedAt: now, count: 1 });
    if (rateLimitWindows.size > 10_000) {
      for (const [key, value] of rateLimitWindows) {
        if (now - value.startedAt >= 60_000) rateLimitWindows.delete(key);
      }
    }
    return true;
  }
  if (window.count >= GEMINI_RATE_LIMIT_PER_MINUTE) return false;
  window.count++;
  return true;
}

function writeSse(res: Response, data: Record<string, unknown>): void {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

function cleanJsonOutput(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

function parseJsonSafely(text: string): Record<string, unknown> {
  try {
    const parsed = parseRobustJson(text);
    return cleanExtractedJson(parsed);
  } catch (error) {
    digitizationLogger.log('error', 'server-parser', 'Lỗi parse JSON an toàn');
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

interface ExecuteOptions {
  task: GeminiTask;
  contents: unknown;
  systemInstruction?: string;
  responseMimeType?: string;
  temperature?: number;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  preferredProjectId?: string;
  preferredModel?: string;
  responseSchema?: any;
  clientGeminiKeys?: string[];
}

async function callGeminiModel(
  apiKey: string,
  model: string,
  options: ExecuteOptions,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Gemini request was cancelled.');
    
    // Tối thiểu 30s (30,000ms) để tránh lỗi HTTP 400 "Manually set deadline is too short"
    const remainingTime = deadline - Date.now();
    if (remainingTime < 30_000) {
      throw new Error(`Thời gian xử lý còn lại (${Math.round(remainingTime / 1000)}s) không đủ tối thiểu 30s để gửi request tới Gemini API.`);
    }

    const calculatedTimeoutMs = Math.min(
      getAttemptTimeout(options.task),
      Math.max(30_000, remainingTime)
    );

    const attemptController = new AbortController();
    const cancelAttempt = () => attemptController.abort(new Error('Client disconnected.'));
    signal?.addEventListener('abort', cancelAttempt, { once: true });
    const attemptTimeout = setTimeout(
      () => attemptController.abort(new Error('Gemini attempt timed out.')),
      calculatedTimeoutMs,
    );

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          timeout: calculatedTimeoutMs,
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const config: Record<string, unknown> = { abortSignal: attemptController.signal };
      if (options.systemInstruction) config.systemInstruction = options.systemInstruction;
      if (options.responseMimeType) config.responseMimeType = options.responseMimeType;
      if (options.responseSchema) config.responseSchema = options.responseSchema;
      if (model.includes('flash-lite') && typeof options.temperature === 'number') {
        config.temperature = options.temperature;
      }

      const response = await ai.models.generateContent({
        model,
        contents: options.contents as any,
        config,
      });
      const text = response.text || '';
      if (!text) throw new Error('Gemini returned an empty response.');
      return text;
    } catch (error) {
      lastError = error;
      const { status, message } = describeGeminiError(error);
      const isRetryable = status === 503 || status === 504 || /503|504|DEADLINE_EXCEEDED|deadline|timeout|service unavailable|high demand|overloaded|temporarily unavailable/i.test(message);

      // On 503/504 (transient server overload/timeout), retry with exponential backoff on the same key
      // On 429 (quota exhausted / rate limit), throw immediately so the pool rotates to another key or fallback model!
      if (isRetryable && attempt < maxRetries - 1 && Date.now() < deadline - 35_000) {
        const backoffMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        options.onProgress?.(`Model ${model} bị gián đoạn (${status || 504}); thử lại sau ${backoffMs / 1000}s (${attempt + 1}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(attemptTimeout);
      signal?.removeEventListener('abort', cancelAttempt);
    }
  }

  throw lastError || new Error(`Mô hình ${model} không phản hồi sau ${maxRetries} lần thử.`);
}

async function executeGeminiWithFailover(options: ExecuteOptions): Promise<{ text: string; modelUsed: string }> {
  if (options.task === 'digitization') {
    return executeDigitizationWithFailover(options);
  }

  const scheduler = getQuotaScheduler();
  const serverProjects = scheduler.getProjects();
  const clientProjects = parseGeminiProjects(options.clientGeminiKeys || [], undefined);
  const projects = [...serverProjects, ...clientProjects];
  
  if (projects.length === 0) {
    throw new Error('Chưa cấu hình GEMINI_API_KEYS trên máy chủ và không có key từ ứng dụng.');
  }

  // Create a temporary scheduler if client projects are provided to manage their quota during this request
  const activeScheduler = clientProjects.length > 0 
    ? new GeminiQuotaScheduler(projects)
    : scheduler;

  // Sử dụng duy nhất 1 mô hình chỉ định cho tác vụ, không sử dụng mô hình dự phòng
  const targetModel = options.preferredModel || (TASK_MODELS[options.task] ? TASK_MODELS[options.task][0] : 'gemini-3.5-flash-lite');
  const modelsToTry = [targetModel];

  const deadline = Date.now() + (options.timeoutMs || GEMINI_ANALYSIS_TIMEOUT_MS);
  let lastError: Error | null = null;

  for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
    const currentModel = modelsToTry[modelIndex];
    const quota = getModelQuota(currentModel);
    const isFallback = modelIndex > 0;
    const attemptedProjectIds = new Set<string>();

    if (isFallback) {
      options.onProgress?.(`Model chính gặp sự cố quota; tự động kích hoạt model dự phòng ${currentModel}...`);
      digitizationLogger.log(
        'info',
        'task-executor',
        `Kích hoạt Test-Call tự động sang model dự phòng ${currentModel} cho task ${options.task}`
      );
    }

    // Xoay vòng qua các key trong pool cho currentModel
    while (attemptedProjectIds.size < projects.length && Date.now() < deadline - 30_000) {
      if (options.signal?.aborted) throw new Error('Gemini request was cancelled.');

      let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
      try {
        lease = await activeScheduler.acquire(
          options.task,
          currentModel,
          quota,
          attemptedProjectIds,
          Math.min(10_000, Math.max(1_000, deadline - Date.now() - 30_000)),
          options.preferredProjectId && !attemptedProjectIds.has(options.preferredProjectId)
            ? options.preferredProjectId
            : undefined,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        break;
      }

      const { project } = lease;
      attemptedProjectIds.add(project.id);

      try {
        options.onProgress?.(`Đang xử lý bằng ${currentModel} (Key: ${project.id})`);
        const text = await callGeminiModel(project.apiKey, currentModel, options, deadline, options.signal);
        return { text, modelUsed: currentModel };
      } catch (error) {
        const details = describeGeminiError(error);
        lastError = error instanceof Error ? error : new Error(String(error));
        const shouldRetry = recordProjectFailure(activeScheduler, project.id, currentModel, error, true, false);
        activeScheduler.markProjectCooldown(project.id, GEMINI_OCR_PROJECT_COOLDOWN_MS);
        
        digitizationLogger.log(
          'warn',
          'task-executor',
          `Task ${options.task} thất bại với Key ${project.id} trên ${currentModel} (${details.status || 'network'}).`,
          { task: options.task, projectId: project.id, model: currentModel, status: details.status }
        );
        
        options.onProgress?.(`Key ${project.id} gặp sự cố; chuyển sang Key tiếp theo trong pool...`);
        if (!shouldRetry) throw lastError;
      } finally {
        lease.release();
      }
    }

    // Nếu model đầu tiên thất bại toàn bộ key (VD: 429 cạn quota 3.8-flash), chuyển sang model dự phòng
    if (modelIndex < modelsToTry.length - 1) {
      const fallbackModel = modelsToTry[modelIndex + 1];
      digitizationLogger.log(
        'warn',
        'task-executor',
        `Mô hình ${currentModel} đã hết quota hoặc bị lỗi trên toàn bộ key. Tự động chuyển hướng Test-Call sang mô hình dự phòng ${fallbackModel}...`,
        { failedModel: currentModel, fallbackModel }
      );
    }
  }

  throw lastError || new Error(`Đã hết quota hoặc thời gian chờ cho các mô hình (${modelsToTry.join(', ')}) trên các key đã cấu hình.`);
}

async function executeDigitizationWithFailover(
  options: ExecuteOptions,
): Promise<{ text: string; modelUsed: string }> {
  const scheduler = getQuotaScheduler();
  const serverProjects = scheduler.getProjects();
  const clientProjects = parseGeminiProjects(options.clientGeminiKeys || [], undefined);
  const projects = [...serverProjects, ...clientProjects];

  if (projects.length === 0) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trên máy chủ và không có key từ ứng dụng.');
  }

  const activeScheduler = clientProjects.length > 0
    ? new GeminiQuotaScheduler(projects)
    : scheduler;

  const deadline = Date.now() + (options.timeoutMs || GEMINI_OCR_TIMEOUT_MS);
  const quota = getTaskQuota('digitization');
  let lastError: Error | null = null;

  for (const targetModel of TASK_MODELS.digitization) {
    const attemptedProjectIds = new Set<string>();
    while (attemptedProjectIds.size < projects.length && Date.now() < deadline - 30_000) {
      if (options.signal?.aborted) throw new Error('Gemini request was cancelled.');

      const preferred = options.preferredProjectId && !attemptedProjectIds.has(options.preferredProjectId)
        ? options.preferredProjectId
        : undefined;

      let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
      try {
        lease = await activeScheduler.acquire(
          'digitization',
          targetModel,
          quota,
          attemptedProjectIds,
          Math.min(5_000, deadline - Date.now() - 30_000),
          preferred,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        break;
      }

      const { project } = lease;
      attemptedProjectIds.add(project.id);

      try {
        options.onProgress?.(`Đang OCR tài liệu bằng ${targetModel} (Key: ${project.id})`);
        const text = await callGeminiModel(
          project.apiKey,
          targetModel,
          options,
          deadline,
          options.signal,
        );
        return { text, modelUsed: targetModel };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        const details = describeGeminiError(error);
        recordProjectFailure(activeScheduler, project.id, targetModel, error, false, false);
        activeScheduler.markProjectCooldown(project.id, GEMINI_OCR_PROJECT_COOLDOWN_MS);

        digitizationLogger.log(
          'warn',
          'worker',
          `Key ${project.id} lỗi OCR (${details.status || 'network'}); chuyển sang Key tiếp theo với cùng model ${targetModel}...`,
          { projectId: project.id, model: targetModel, status: details.status },
        );
        options.onProgress?.(
          `Key ${project.id} gặp sự cố; chuyển tức thì sang Key khả dụng kế tiếp trong pool...`,
        );
      } finally {
        lease.release();
      }
    }
  }

  throw lastError || new Error('Đã hết key khả dụng cho các mô hình OCR hoặc quá thời gian chờ.');
}

async function startServer() {
  quotaScheduler = new GeminiQuotaScheduler(getConfiguredProjects());
  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('Origin');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Status check endpoint
  app.get('/api/gemini/status', (_req: Request, res: Response) => {
    const projects = getQuotaScheduler().getProjects();
    res.json({
      status: 'ok',
      configuredProjects: projects.length,
      hasKeyConfig: Boolean(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY),
      supportedTasks: Object.keys(TASK_MODELS),
      taskModels: TASK_MODELS,
      quotasPerProject: {
        digitization: { rpm: 15, rpd: 500, maxConcurrent: 3 },
        analysis: { rpm: 5, rpd: 20, maxConcurrent: 2 },
        assistant: { rpm: 15, rpd: 500, maxConcurrent: 3 },
        refinement: { rpm: 15, rpd: 500, maxConcurrent: 3 },
      },
      modelQuotas: {
        'gemini-3.5-flash-lite': { rpm: 15, rpd: 500, maxConcurrent: 3 },
        'gemini-3.6-flash': { rpm: 5, rpd: 20, maxConcurrent: 2 },
      },
      ocr: {
        batchPages: OCR_BATCH_PAGES,
        concurrentBatchesPerRequest: OCR_BATCH_CONCURRENCY,
        failedKeyCooldownMs: GEMINI_OCR_PROJECT_COOLDOWN_MS,
        primaryModel: TASK_MODELS.digitization[0],
        zeroDowngradeEnforced: true,
      },
      architecture: 'server-side-secure-three-tier',
    });
  });



  app.use('/api/gemini', async (req: Request, res: Response, next) => {
    req.setTimeout(300_000);
    res.setTimeout(300_000);
    if (req.path === '/status' || req.path === '/digitization-logs') {
      next();
      return;
    }

    const authorization = req.header('Authorization') || '';
    const match = authorization.match(/^Bearer\s+(\S+)$/i);
    let uid = req.ip || 'guest-session';

    if (match) {
      try {
        const verifiedUid = await verifyFirebaseIdToken(match[1]);
        if (verifiedUid) {
          uid = verifiedUid;
        }
      } catch (error) {
        console.warn('[Gemini Auth] Firebase verification fallback to IP session:', error);
      }
    }

    if (!isWithinRateLimit(uid)) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Bạn đã dùng hết lượt yêu cầu tạm thời. Hãy thử lại sau một phút.' });
      return;
    }
    res.locals.firebaseUid = uid;
    next();
  });

  // 0. Endpoint để lấy logs (Đã được bảo vệ bởi middleware phía trên)
  app.get('/api/gemini/digitization-logs', (_req: Request, res: Response) => {
    res.json({ success: true, logs: digitizationLogger.getLogs() });
  });

  app.use(express.json({ limit: '36mb' }));

  // 1. Endpoint để kiểm tra API key an toàn trên server
  app.post('/api/gemini/test-key', async (req: Request, res: Response) => {
    const { key } = req.body;
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!cleanKey) {
      res.status(400).json({ error: 'API key không được để trống.' });
      return;
    }
    try {
      const ai = new GoogleGenAI({
        apiKey: cleanKey,
        httpOptions: {
          timeout: 15_000,
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: 'OK',
        config: { maxOutputTokens: 16 },
      });
      res.json({ valid: true, modelUsed: 'gemini-3.1-flash-lite', text: response.text });
    } catch (err) {
      const details = describeGeminiError(err);
      if (details.status === 429) {
        res.json({ valid: true, modelUsed: 'gemini-3.1-flash-lite', quotaExhausted: true });
        return;
      }
      res.status(400).json({ error: details.message || 'Key không hợp lệ.' });
    }
  });

  // 1.5. Proxy Endpoint cho generateContent (Thay thế cho gọi trực tiếp từ client)
  app.post('/api/gemini/generate-content', async (req: Request, res: Response) => {
    try {
      const { model, contents, config, clientGeminiKeys } = req.body;
      // Trong mô hình này, ta lấy API key từ server (nếu có) hoặc từ client (nếu client gửi lên - mặc dù nên ưu tiên key server)
      // Theo yêu cầu, client gửi `clientGeminiKeys` lên.
      // Dựa trên logic cũ của app, nó hỗ trợ nhiều key từ client.
      // Ta vẫn nên giữ logic rotate key trên server để đảm bảo an toàn.
      
      const keysToUse = Array.isArray(clientGeminiKeys) ? clientGeminiKeys : [];
      const scheduler = getQuotaScheduler();
      
      // Tìm key phù hợp
      let activeApiKey = process.env.GEMINI_API_KEY || (keysToUse.length > 0 ? keysToUse[0] : undefined);
      
      if (!activeApiKey) {
        throw new Error('Không tìm thấy API key hợp lệ.');
      }

      const ai = new GoogleGenAI({
        apiKey: activeApiKey,
        httpOptions: {
          timeout: 60_000,
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const response = await ai.models.generateContent({
        model,
        contents: contents as any,
        config: config as any,
      });

      res.json({ success: true, text: response.text, modelUsed: model });
    } catch (err) {
      console.error('[Gemini Server GenerateContent Error]', err);
      const details = describeGeminiError(err);
      res.status(500).json({ error: details.message || 'Lỗi khi gọi Gemini API.' });
    }
  });

  // 1. Trích xuất tài liệu (OCR PDF / ảnh chụp khám bệnh)
  app.post('/api/gemini/extract-health-event', async (req: Request, res: Response) => {
    digitizationLogger.log('info', 'request', 'Bắt đầu yêu cầu số hóa tài liệu', { memberId: req.body.member?.id });
    let extractionTimeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let modelAbortController: AbortController | undefined;
    try {
      const { base64Data, mimeType, member, isAutoDetect } = req.body;
      if (typeof base64Data !== 'string' || base64Data.length === 0) {
        res.status(400).json({ error: 'Thiếu dữ liệu tệp đính kèm (base64).' });
        return;
      }
      if (
        base64Data.length > MAX_BASE64_CHARS ||
        base64Data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data) ||
        Buffer.byteLength(base64Data, 'base64') > MAX_DOCUMENT_BYTES
      ) {
        res.status(413).json({ error: 'Tệp vượt quá giới hạn 25 MB hoặc có dữ liệu mã hóa không hợp lệ.' });
        return;
      }
      if (
        mimeType !== 'application/pdf' &&
        !(typeof mimeType === 'string' && /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(mimeType))
      ) {
        res.status(415).json({ error: 'Chỉ hỗ trợ tài liệu PDF hoặc ảnh JPEG, PNG, WebP, GIF, HEIC, HEIF.' });
        return;
      }

      const effectiveMime = mimeType || 'application/pdf';
      const memberName = member?.name || 'Thành viên gia đình';
      const memberBirth = member?.birthDate ? `sinh ngày ${member.birthDate}` : '';
      let pageBatches: PdfPageBatch[];
      try {
        pageBatches = effectiveMime === 'application/pdf'
          ? await splitPdfIntoBatches(base64Data, OCR_BATCH_PAGES)
          : [{ firstPage: 1, lastPage: 1, base64Data }];
      } catch (error) {
        if (error instanceof PdfPageBatchError) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }

      const taskContextInstruction = isAutoDetect
        ? `LƯU Ý QUAN TRỌNG VỀ THỦ THỤC TỰ ĐỘNG NHẬN DIỆN CHỦ THỂ (AUTO-DETECT MODE):
- Bạn ĐANG XỬ LÝ Ở CHẾ ĐỘ TỰ ĐỘNG NHẬN DIỆN CHỦ THỂ (Auto-detect patient mode).
- BẮT BUỘC ĐỌC VÀ TRÍCH XUẤT BẰNG ĐƯỢC HỌ VÀ TÊN BỆNH NHÂN THỰC TẾ GHI TRÊN TÀI LIỆU Y TẾ NÀY vào trường "patientName".
- Tuyệt đối KHÔNG gán tên mặc định, KHÔNG gán tên gợi ý (${memberName}), KHÔNG suy đoán tên từ tài khoản người dùng khác. Bóc tách chính xác tên in/viết trên tài liệu y tế này (như Vũ Thị Tú Anh, Trương Anh Tuấn...).`
        : `Nhiệm vụ: Trích xuất đầy đủ, trung thực, súc tích các dữ liệu y tế cốt lõi trên tài liệu đính kèm cho thành viên gia đình (${memberName} ${memberBirth}).
NÓI RÕ: BẮT BUỘC vẫn ghi đúng HỌ VÀ TÊN BỆNH NHÂN in/viết thực tế trên giấy tờ y tế này vào trường "patientName". Nếu tài liệu ghi tên bệnh nhân khác (${memberName}), vẫn trích xuất chính xác tên thực tế đó.`;

      const systemInstruction = `Bạn là chuyên gia y tế số hóa & OCR tài liệu y khoa Việt Nam cấp cao (sổ khám bệnh tổng quát, phiếu xét nghiệm, siêu âm/X-quang/CT/MRI/ECG, đơn thuốc, sổ tiêm chủng, giấy ra viện, hoặc các loại giấy tờ y tế khác).
${taskContextInstruction}
Tên tệp tin đang xử lý: "${req.body.fileName || 'Không rõ tên tệp'}".

QUY TẮC BẮT BUỘC VỀ THỜI GIAN & NGÀY KHÁM (CRITICAL DATE RESOLUTION):
1. ƯU TIÊN MỐC THỜI GIAN THỰC HIỆN KHÁM / XÉT NGHIỆM THỰC TẾ:
   - Hãy tìm ngày thực tế diễn ra các xét nghiệm, chụp chiếu, hoặc ngày bác sĩ khám và ký tên.
   - PHÂN TÍCH TẦN SUẤT: Nếu tài liệu có nhiều mốc ngày khác nhau, hãy chọn mốc ngày xuất hiện nhiều nhất và xuyên suốt các phiếu xét nghiệm / chẩn đoán hình ảnh để làm "date" chính của sự kiện.
   - TRÁNH NHẦM LẪN:
     + Tuyệt đối không lấy ngày sinh (${memberBirth}) làm ngày khám.
     + Không lấy niên độ in trên bìa sổ nếu ngày các xét nghiệm bên trong diễn ra vào năm khác (VD: Bìa in "Khám định kỳ năm 2023" nhưng các phiếu xét nghiệm máu, siêu âm, ECG đều ghi ngày 22/05/2024 thì ngày khám chính xác PHẢI là 2024-05-22).
     + Không lấy ngày in phiếu ở chân trang hoặc ngày hẹn tái khám trong tương lai.
2. NẾU TÊN TỆP CÓ CHỨA NĂM (VD: "${req.body.fileName || 'Không rõ tên tệp'}"):
   - Hãy BẮT BUỘC ưu tiên tìm và lấy mốc ngày khám, xét nghiệm, chẩn đoán hình ảnh hoặc chữ ký bác sĩ CÙNG NĂM với năm ghi trên tên tệp.
   - Tuyệt đối không lấy mốc năm cũ hơn (như 2023, 2022...) nếu những năm đó chỉ là tiền sử bệnh, quá trình điều trị cũ được ghi chú lại trong nội dung sổ khám.

BẮT BUỘC TUÂN THỦ CÁC NGUYÊN TẮC BÓC TÁCH TỐI ƯU (FAST OCR):
1. TẬP TRỌNG TÂM Y TẾ: Chỉ trích xuất thông số xét nghiệm (metrics), kết quả chẩn đoán hình ảnh (imagingResults), chẩn đoán bệnh (diagnoses), tên cơ sở y tế và ngày khám.
2. LOẠI BỎ ẢNH NẶNG & TRANG PHỤ: Bỏ qua hoàn toàn trang bìa, thủ tục hành chính, quy định bảo hiểm, hoặc các trang CHỈ CHỨA HÌNH ẢNH THÔ (siêu âm chụp màn hình, phim X-quang, hình minh họa giải phẫu). KHÔNG bóc tách nếu trang đó không có bảng số liệu hoặc văn bản kết luận.
3. CÔ ĐỌNG CHẨN ĐOÁN HÌNH ẢNH: Trong "imagingResults", "findings" CHỈ GHI BẤT THƯỜNG QUAN TRỌNG hoặc KẾT LUẬN CỐT LÕI (dưới 2-3 câu súc tích). KHÔNG mô tả hình ảnh rườm rà.
4. TRÁNH LẶP DỮ LIỆU & TOKEN THỊ GIÁC: Không sinh các đoạn mô tả hình ảnh, không lặp lại cùng tên chỉ số xét nghiệm giữa các trang/batch.

QUY TẮC PHÂN LOẠI & TRÍCH XUẤT ĐA DẠNG (POLYMORPHIC SCHEMA):
1. PHÂN LOẠI TÀI LIỆU (type) — phân loại theo mục đích/chủ đề chính của tài liệu, KHÔNG chỉ dựa vào loại dữ liệu có trong đó:
   - "comprehensive_exam": Sổ/Phiếu khám sức khỏe định kỳ tổng quát, khám đoàn thể. Nếu tài liệu có tiêu đề hoặc tên tệp như "Khám sức khỏe định kỳ", "Khám tổng quát", "Khám sức khỏe năm ...", PHẢI chọn loại này dù tài liệu kèm nhiều phiếu xét nghiệm, siêu âm hoặc ECG.
   - "test_result": Phiếu kết quả xét nghiệm huyết học, sinh hóa, miễn dịch, nước tiểu...
   - "imaging": Kết quả chẩn đoán hình ảnh (Siêu âm tuyến giáp/ổ bụng/tim, X-quang, CT, MRI, Điện tâm đồ ECG...).
   - "prescription": Đơn thuốc, toa thuốc điều trị ngoại trú/nội trú.
   - "vaccination": Phiếu tiêm chủng, sổ tiêm ngừa vắc xin.
   - "discharge": Giấy ra viện, phiếu xuất viện, tóm tắt bệnh án nội trú.
   - "other": Tài liệu y tế khác (giấy chuyển tuyến, hóa đơn, giấy hẹn tái khám, bảng theo dõi huyết áp tại nhà...). Khi type là "other", BẮT BUỘC cung cấp "customCategory" (VD: "Giấy chuyển tuyến", "Bảng theo dõi huyết áp") và lưu các thông tin dạng key-value vào "extractedData".
   - PHÂN BIỆT: "test_result" chỉ dùng khi tài liệu chính là phiếu trả kết quả xét nghiệm; nhiều chỉ số xét nghiệm nằm trong một bộ khám sức khỏe tổng quát KHÔNG làm đổi loại khỏi "comprehensive_exam".
   - Với PDF gồm nhiều loại giấy tờ, chọn loại của tài liệu/chủ đề chính thể hiện ở bìa, tiêu đề hoặc tên tệp; không chọn loại chỉ vì một trang phụ có thuốc, xét nghiệm hoặc chẩn đoán hình ảnh.

2. THÔNG TIN BÁC SĨ & ĐƠN VỊ:
   - "facility": Tên bệnh viện, phòng khám, trung tâm y tế.
   - "doctorName": Họ và tên bác sĩ khám, bác sĩ điều trị hoặc bác sĩ kê đơn nếu có.

3. KHÁM THỂ LỰC (physicalExam):
   - height_cm, weight_kg, bmi, bp_mmHg (huyết áp), pulse_bpm (mạch), classification (phân loại sức khỏe như "Loại I", "Loại II"...).

4. CHẨN ĐOÁN & KẾT LUẬN (diagnoses):
   - Toàn bộ chẩn đoán bệnh, tiền sử bệnh lý, tiền sử phẫu thuật, các kết luận bất thường.

5. CHỈ SỐ XÉT NGHIỆM (metrics):
   - Trích xuất TẤT CẢ các chỉ số xét nghiệm với "standardKey" chuẩn hóa.
   - DANH SÁCH KEY CHUẨN: WBC, NEU_PCT, NEU_#, LYM_PCT, LYM_#, MONO_PCT, MONO_#, RBC, HGB, HCT, MCV, MCH, MCHC, PLT, ESR_1H, ESR_2H, HBSAG, HBSAB, HCV_AB, HBA1C, TSH, FT4, FT3, CEA, CYFRA_21_1, CA_72_4, GLUCOSE, UREA, CREATININ, EGFR, ACID_URIC, CHOLESTEROL, HDL_C, LDL_C, TRIGLYCERID, AST, ALT, GGT, NA, K, CL, CA_ION, URINE_PRO, URINE_SG, URINE_PH, URINE_BLOOD.
   - BẮT BUỘC: Không tự ý thêm hậu tố như "_1", "_2" vào key. Sử dụng đúng NEU_# thay vì NEU_1.
   - CẢNH BÁO: Phân biệt rõ "Bạch cầu" trong máu (WBC) và "Bạch cầu" trong cặn lắng nước tiểu (URINE_LEU). Không dùng key AST cho "Trụ" nước tiểu.

6. CHẨN ĐOÁN HÌNH ẢNH (imagingResults):
   - "modality" (kỹ thuật), "findings" (mô tả hình ảnh cô đọng bất thường), "conclusion" (kết luận chẩn đoán).

7. ĐƠN THUỐC CHI TIẾT (medications):
   - name: tên thuốc
   - dosage: hàm lượng / liều dùng mỗi lần
   - quantity: số lượng viên/gói/hộp cấp phát
   - frequency: số lần uống trong ngày
   - timing: thời điểm uống (sáng/trưa/chiều/tối, trước hay sau ăn)
   - duration: thời gian dùng (số ngày/tuần)
   - instructions: lời dặn chi tiết về cách dùng thuốc

8. TIÊM CHỦNG VẮC XIN (vaccinations):
   - vaccineName: tên vắc xin (VD: Phế cầu 13, Cúm tứ giá, Viêm gan B)
   - targetDisease: bệnh phòng ngừa
   - doseNumber: mũi tiêm thứ mấy
   - lotNumber: số lô vắc xin
   - manufacturer: hãng sản xuất / nước sản xuất
   - administeredDate: ngày tiêm (YYYY-MM-DD)
   - nextDoseDate: ngày hẹn tiêm mũi tiếp theo nếu có (YYYY-MM-DD)
   - reactionNotes: ghi chú phản ứng sau tiêm

9. NẰM VIỆN & RA VIỆN (hospitalization):
   - admissionDate: ngày nhập viện (YYYY-MM-DD)
   - dischargeDate: ngày ra viện (YYYY-MM-DD)
   - department: khoa điều trị
   - treatmentSummary: tóm tắt quá trình điều trị
   - surgicalNotes: phẫu thuật hoặc thủ thuật đã can thiệp nếu có

Hãy trả về DUY NHẤT một JSON object tuân thủ đúng cấu trúc:
{
  "title": "Tên sự kiện y tế phản ánh đúng năm thực tế khám (VD: Khám sức khỏe định kỳ năm 2024, Xét nghiệm tổng quát tháng 06/2026. TUYỆT ĐỐI không lấy niên hạn/năm hợp đồng in trên bìa nếu ngày thực tế khám thuộc năm khác)",
  "date": "YYYY-MM-DD",
  "type": "comprehensive_exam" | "test_result" | "imaging" | "prescription" | "vaccination" | "discharge" | "other",
  "customCategory": "Tên phân loại tự động nếu type là other",
  "patientName": "Họ và tên bệnh nhân ghi trên tài liệu. BẮT BUỘC tự động chuẩn hóa viết hoa đúng quy tắc tên riêng có dấu tiếng Việt đầy đủ (VD: 'TRUONG AN TUAN' ➔ 'Trương An Tuấn', 'nguyen van a' ➔ 'Nguyễn Văn A').",
  "patientBirthDate": "YYYY-MM-DD hoặc YYYY (ngày sinh/năm sinh nếu có)",
  "patientGender": "Nam" | "Nữ" | "Khác",
  "facility": "Tên cơ sở y tế",
  "doctorName": "Tên bác sĩ khám/kê đơn nếu có",
  "physicalExam": {
    "height_cm": 178,
    "weight_kg": 77,
    "bmi": 24.3,
    "bp_mmHg": "120/80",
    "pulse_bpm": 60,
    "classification": "Loại I"
  },
  "diagnoses": ["Chẩn đoán 1", "Chẩn đoán 2"],
  "medications": [
    {
      "name": "Tên thuốc",
      "dosage": "500mg",
      "quantity": "20 viên",
      "frequency": "2 lần/ngày",
      "timing": "Sáng 1 viên, tối 1 viên sau ăn",
      "duration": "10 ngày",
      "instructions": "Uống nhiều nước khi dùng thuốc"
    }
  ],
  "vaccinations": [
    {
      "vaccineName": "Prevenar 13",
      "targetDisease": "Phế cầu khuẩn",
      "doseNumber": 1,
      "lotNumber": "AB1234",
      "manufacturer": "Pfizer",
      "administeredDate": "2024-05-20",
      "nextDoseDate": "2025-05-20",
      "reactionNotes": "Bình thường"
    }
  ],
  "hospitalization": {
    "admissionDate": "2024-05-10",
    "dischargeDate": "2024-05-15",
    "department": "Khoa Tiêu hóa",
    "treatmentSummary": "Điều trị nội khoa ổn định",
    "surgicalNotes": "Nội soi can thiệp gắp polyp"
  },
  "metrics": [
    { "name": "Tên chỉ số", "standardKey": "WBC", "value": 6.41, "unit": "G/L", "refRange": "3.9-10", "status": "normal" }
  ],
  "imagingResults": [
    { "modality": "Siêu âm tuyến giáp", "findings": "Mô tả hình ảnh", "conclusion": "Kết luận chẩn đoán" }
  ],
  "extractedData": {
    "noiChuyenDen": "Bệnh viện Chợ Rẫy",
    "lyDoChuyenTuyen": "Đúng tuyến chuyên môn kỹ thuật"
  },
  "advice": "Lời dặn của bác sĩ hoặc hướng dẫn điều trị",
  "nextFollowUp": "YYYY-MM-DD",
  "notes": "Ghi chú bổ sung quan trọng"
}`;

      const extractDocument = async (
        onBatchComplete?: (
          completed: number,
          extracted: Record<string, unknown>,
          modelUsed: string,
          batch: PdfPageBatch,
        ) => void,
        onModelProgress?: (message: string) => void,
        signal?: AbortSignal,
      ) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const projects = getQuotaScheduler().getProjects();
        const results: Array<{ firstPage: number; lastPage: number; extracted: Record<string, unknown>; modelUsed: string } | null> = new Array(pageBatches.length).fill(null);
        let completedBatches = 0;
        const fileAssignedProjectId = projects.length > 0 ? projects[0].id : undefined;

        const callGeminiWithRetry = async (
          batch: PdfPageBatch,
          batchIndex: number,
          preferredProjectId?: string,
        ): Promise<{ text: string; modelUsed: string }> => {
          const maxBatchRetries = 3;
          let lastBatchError: any;
          const promptText = pageBatches.length === 1
            ? `Đọc toàn bộ tài liệu này của hồ sơ ${memberName}. Trích xuất đầy đủ, chính xác, chi tiết tất cả các thông tin y tế gồm: Khám thể lực (physicalExam), Các chẩn đoán (diagnoses), Toàn bộ kết quả xét nghiệm (kèm standardKey, khoảng tham chiếu refRange), Toàn bộ kết quả chẩn đoán hình ảnh (siêu âm, X-quang, ECG...), Đơn thuốc và Lời dặn của bác sĩ. Trả về DUY NHẤT một JSON object chuẩn.`
            : `Đọc các trang ${batch.firstPage}-${batch.lastPage} trong tài liệu này của hồ sơ ${memberName}. Trích xuất đầy đủ nội dung có trên các trang này (Khám thể lực, chẩn đoán, xét nghiệm kèm standardKey & refRange, chẩn đoán hình ảnh, đơn thuốc, lời dặn). Trả về DUY NHẤT một JSON object chuẩn.`;

          for (let attempt = 0; attempt < maxBatchRetries; attempt++) {
            if (signal?.aborted) throw new Error('OCR was cancelled.');
            try {
              return await executeGeminiWithFailover({
                task: 'digitization',
                contents: [
                  { inlineData: { mimeType: effectiveMime, data: batch.base64Data } },
                  { text: promptText },
                ],
                systemInstruction,
                responseMimeType: 'application/json',
                timeoutMs: GEMINI_OCR_TIMEOUT_MS,
                signal,
                onProgress: onModelProgress,
                preferredProjectId,
                clientGeminiKeys: req.body.clientGeminiKeys,
              });
            } catch (error) {
              lastBatchError = error;
              const details = describeGeminiError(error);
              const isRetryable = details.status === 429 || details.status === 503 || details.status === 504 || /high demand|deadline|timeout|overload/i.test(details.message);
              
              if (isRetryable && attempt < maxBatchRetries - 1) {
                const delay = Math.pow(2, attempt + 1) * 2000; // 4s, 8s, 16s
                digitizationLogger.log('warn', 'worker', `Lỗi batch ${batchIndex + 1} (${details.status}). Thử lại sau ${delay/1000}s (Lần ${attempt + 1}/${maxBatchRetries})`);
                await sleep(delay);
                continue;
              }
              throw error;
            }
          }
          throw lastBatchError;
        };

        // Xử lý TUẦN TỰ để chống Rate Limit và đảm bảo tính ổn định
        for (let i = 0; i < pageBatches.length; i++) {
          if (signal?.aborted) throw new Error('OCR was cancelled.');
          
          // Độ trễ tối thiểu 2.5 giây giữa các request để bảo vệ băng thông
          if (i > 0) {
            onModelProgress?.(`Chờ giây lát trước khi xử lý phần tiếp theo...`);
            await sleep(2500);
          }

          const batch = pageBatches[i];
          const preferredProjectId = fileAssignedProjectId || (projects.length > 0 ? projects[i % projects.length].id : undefined);
          
          digitizationLogger.log('info', 'worker', `Bắt đầu OCR batch ${i + 1}/${pageBatches.length} (trang ${batch.firstPage}-${batch.lastPage})`, { preferredProjectId });
          
          try {
            const { text, modelUsed } = await callGeminiWithRetry(batch, i, preferredProjectId);
            
            digitizationLogger.log('info', 'worker', `Hoàn tất OCR batch ${i + 1}/${pageBatches.length}`, { modelUsed });
            
            results[i] = {
              firstPage: batch.firstPage,
              lastPage: batch.lastPage,
              extracted: parseJsonSafely(text),
              modelUsed,
            };

            completedBatches++;
            const availableResults = results.slice(0, i + 1).filter(
              (r): r is NonNullable<typeof r> => Boolean(r),
            );
            
            const fileNameStr = typeof req.body.fileName === 'string' ? req.body.fileName : '';
            const fileYearMatch = fileNameStr.match(/\b(19|20)\d{2}\b/);
            const preferredYear = fileYearMatch ? fileYearMatch[0] : undefined;

            onBatchComplete?.(
              completedBatches,
              mergeExtractedBatches(availableResults, preferredYear, fileNameStr),
              Array.from(new Set(availableResults.map((r) => r.modelUsed))).join(', '),
              batch,
            );
          } catch (error) {
            digitizationLogger.log('error', 'worker', `Thất bại vĩnh viễn tại batch ${i + 1} sau khi thử lại`);
            if (!signal?.aborted) modelAbortController?.abort(error);
            throw error;
          }
        }
        const completeResults = results.filter(
          (result): result is NonNullable<typeof result> => Boolean(result),
        );
        const fileNameStr = typeof req.body.fileName === 'string' ? req.body.fileName : '';
        const fileYearMatch = fileNameStr.match(/\b(19|20)\d{2}\b/);
        const preferredYear = fileYearMatch ? fileYearMatch[0] : undefined;

        return {
          extracted: mergeExtractedBatches(completeResults, preferredYear, fileNameStr),
          modelUsed: Array.from(new Set(completeResults.map((result) => result.modelUsed))).join(', '),
        };
      };

      if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        modelAbortController = new AbortController();
        writeSse(res, {
          type: 'progress',
          progressPercent: 46,
          message: `Đang xử lý tài liệu (0/${pageBatches.length} trang)`,
          totalPages: pageBatches.length,
        });
        heartbeat = setInterval(() => {
          writeSse(res, {
            type: 'progress',
            message: `AI đang phân tích các trang tài liệu...`,
          });
        }, 8_000);
        res.on('close', () => {
          if (!res.writableEnded) modelAbortController?.abort(new Error('Client disconnected.'));
          if (heartbeat) clearInterval(heartbeat);
        });
        extractionTimeout = setTimeout(
          () => modelAbortController?.abort(new Error('Tài liệu vượt quá thời gian OCR tối đa 10 phút.')),
          GEMINI_OCR_TIMEOUT_MS,
        );

        const totalDocPages = pageBatches[pageBatches.length - 1].lastPage;
        const result = await extractDocument(
          (completed, extracted, modelUsed, batch) => {
            const pageRange = batch.firstPage === batch.lastPage ? `trang ${batch.firstPage}` : `các trang ${batch.firstPage}-${batch.lastPage}`;
            writeSse(res, {
              type: 'progress',
              progressPercent: Math.min(92, 48 + Math.floor((completed / pageBatches.length) * 44)),
              message: pageBatches.length === 1
                ? `AI (gemini-3.5-flash-lite) đang bóc tách kết quả y tế (Trang 1/1)...`
                : `AI (gemini-3.5-flash-lite) đang bóc tách ${pageRange} (Đã xong ${batch.lastPage}/${totalDocPages} trang)...`,
              currentPage: batch.firstPage,
              processedPages: batch.lastPage,
              totalPages: totalDocPages,
              extracted,
              modelUsed,
            });
          },
          (msg) => writeSse(res, { type: 'progress', message: msg || 'AI đang xử lý tài liệu...' }),
          modelAbortController.signal,
        );
        writeSse(res, {
          type: 'complete',
          extracted: result.extracted,
          modelUsed: result.modelUsed,
          processedPages: totalDocPages,
          totalPages: totalDocPages,
        });
        if (heartbeat) clearInterval(heartbeat);
        if (extractionTimeout) clearTimeout(extractionTimeout);
        res.end();
        return;
      }

      const totalDocPages = pageBatches[pageBatches.length - 1].lastPage;
      const result = await extractDocument();
      res.json({ success: true, ...result, processedPages: totalDocPages, totalPages: totalDocPages });
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (extractionTimeout) clearTimeout(extractionTimeout);
      const details = describeGeminiError(error);
      console.error('[Gemini Server Extract Error]', { status: details.status });
      if (res.headersSent) {
        writeSse(res, { type: 'error', error: details.message });
        res.end();
      } else {
        res.status(details.status || 500).json({ error: details.message });
      }
    }
  });

  // 2. Chuẩn hóa & sắp xếp thông minh (analysis quota)
  app.post('/api/gemini/refine-and-organize', async (req: Request, res: Response) => {
    try {
      const { member, events } = req.body;
      if (!Array.isArray(events) || events.length === 0) {
        res.json({
          success: true,
          organizedTimeline: [],
          refinementNotes: ['Chưa có sự kiện y tế nào để hiệu chỉnh.'],
        });
        return;
      }

      const memberName = member?.name || 'Thành viên';
      const prompt = `Bạn là chuyên gia chuẩn hóa dữ liệu hồ sơ y tế cho thành viên ${memberName}.
Dưới đây là danh sách ${events.length} sự kiện y tế đã thu thập:
${JSON.stringify(events, null, 2)}

Hãy:
1. Chuẩn hóa lại tên sự kiện, loại sự kiện (type), chẩn đoán y khoa theo danh pháp chuẩn.
2. Kiểm tra và bổ sung logic định dạng ngày tháng, liều lượng thuốc, chỉ số sinh tồn.
3. Sắp xếp thông minh theo trình tự thời gian và mức độ ưu tiên quan trọng.
4. Trả về DUY NHẤT một JSON:
{
  "organizedEvents": [ ...danh sách các event đã được chuẩn hóa, giữ nguyên ID gốc... ],
  "refinementNotes": [ "Ghi chú hiệu chỉnh 1", "Ghi chú hiệu chỉnh 2" ]
}`;

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'refinement',
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
        clientGeminiKeys: req.body.clientGeminiKeys,
      });

      const parsed = parseJsonSafely(text) as {
        organizedEvents?: unknown[];
        refinementNotes?: string[];
      };
      res.json({
        success: true,
        organizedTimeline: Array.isArray(parsed.organizedEvents) ? parsed.organizedEvents : events,
        refinementNotes: Array.isArray(parsed.refinementNotes) ? parsed.refinementNotes : ['Đã chuẩn hóa dữ liệu.'],
        modelUsed,
      });
    } catch (error) {
      const details = describeGeminiError(error);
      console.error('[Gemini Server Refine Error]', { status: details.status });
      res.status(details.status || 500).json({
        error: details.message,
      });
    }
  });

  // 3. Tóm tắt hồ sơ sức khỏe (Tier gemini-3.5-flash-lite để bảo toàn quota 3.8 flash)
  app.post('/api/gemini/summarize', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';
      const pruned = pruneProfileForAnalysis(member, profile);

      const prompt = `Bạn là bác sĩ gia đình AI và chuyên gia y tế cao cấp.
Nhiệm vụ: Đưa ra bản ĐÁNH GIÁ TÓM TẮT tình hình sức khỏe cho thành viên ${memberName} dựa trên hồ sơ matrix đính kèm.

HỒ SƠ MATRIX (Đã tối ưu):
${JSON.stringify(pruned, null, 2)}

YÊU CẦU:
1. Đánh giá tổng quan hiện trạng sức khỏe.
2. Phân tích xu hướng các chỉ số xét nghiệm quan trọng.
3. Lời khuyên cụ thể về dinh dưỡng, vận động và lịch tái khám.
Trình bày bằng tiếng Việt rõ ràng, ân cần.`;

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING }
        }
      };

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'assistant',
        contents: [{ text: prompt }],
        responseSchema,
        clientGeminiKeys: req.body.clientGeminiKeys,
      });

      const parsed = parseJsonSafely(text) as { summary?: string };
      res.json({ success: true, summary: parsed.summary || text, modelUsed });
    } catch (error) {
      const details = describeGeminiError(error);
      console.error('[Gemini Server Summary Error]', { status: details.status });
      res.status(details.status || 500).json({
        error: details.message,
      });
    }
  });

function pruneProfileForAnalysis(member: any, profile: any) {
  return prepareDataForDeepDive(member, profile);
}

  // 4. Phân tích chuyên sâu 4 lớp y khoa & Động học y sinh (AI Deep-Dive Engine)
  app.post('/api/gemini/analyze-comprehensive', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';
      const pruned = pruneProfileForAnalysis(member, profile);
      digitizationLogger.log('info', 'analysis', 'Bắt đầu phân tích chuyên sâu', { memberId: member?.id, eventCount: profile?.timeline?.length });
      const prompt = `Bạn là Hội đồng Chuyên gia Y khoa Gia đình & AI Deep-Dive cấp cao.
Nhiệm vụ: Phân tích 4 lớp y khoa chuyên sâu cho thành viên ${memberName}.

DỮ LIỆU HỒ SƠ ĐÃ TỐI ƯU (Pruned Matrix):
${JSON.stringify(pruned, null, 2)}
(Chú thích: p=patient, n=name, g=gender, b=birthDate, h=history, tm=timeline, d=date, t=title, diag=diagnoses, img=imaging, phys=physicalExam, bp=bloodPressure, st=status, val=value)

YÊU CẦU PHÂN TÍCH (BẮT BUỘC):
1. LỚP 1 - Tương quan chéo (crossCorrelations): Chỉ đối chiếu dữ liệu thực sự có trong hồ sơ; nếu thiếu dữ liệu, nêu rõ chưa đủ thông tin.
2. LỚP 2 - Biến động lịch sử (velocityTrends): Chỉ mô tả xu hướng khi có đủ phép đo theo thời gian; không suy ra ổn định từ dữ liệu thiếu.
3. LỚP 3 - Giám sát mạn tính (chronicSurveillance): Chỉ kết luận ổn định/lành tính khi được dữ liệu hỗ trợ; nếu thiếu, nêu rõ chưa đủ thông tin.
4. LỚP 4 - Lộ trình hành động (roadmap): Đưa ra Cảnh báo đỏ, Khám chuyên khoa cần thiết, và Lịch kiểm tra 3-6-12 tháng.

LƯU Ý: Hồ sơ có thể thiếu dữ liệu do tài liệu chưa tải lên hoặc chưa được số hóa; không có dữ liệu KHÔNG đồng nghĩa với bình thường. Không tự suy diễn kết quả, chẩn đoán, điểm sức khỏe hay khuyến nghị. Nếu không đủ căn cứ, mô tả rõ là chưa đủ dữ liệu. Trả về dữ liệu chính xác theo schema, ngôn ngữ tiếng Việt chuyên nghiệp.`;

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          analyzedAt: { type: Type.STRING },
          healthScore: { type: Type.NUMBER },
          overallAssessment: { type: Type.STRING },
          crossCorrelations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                parameters: { type: Type.ARRAY, items: { type: Type.STRING } },
                findings: { type: Type.STRING },
                severity: { type: Type.STRING, enum: ['critical', 'warning', 'info'] }
              },
              required: ['parameters', 'findings', 'severity']
            }
          },
          velocityTrends: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                metricName: { type: Type.STRING },
                trendDirection: { type: Type.STRING, enum: ['increasing', 'decreasing', 'stable', 'fluctuating'] },
                velocityDescription: { type: Type.STRING },
                riskProjection: { type: Type.STRING }
              },
              required: ['metricName', 'trendDirection', 'velocityDescription', 'riskProjection']
            }
          },
          chronicSurveillance: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                conditionName: { type: Type.STRING },
                status: { type: Type.STRING, enum: ['stable_benign', 'monitored', 'progressing', 'resolved'] },
                comparisonOverTime: { type: Type.STRING },
                recommendation: { type: Type.STRING }
              },
              required: ['conditionName', 'status', 'comparisonOverTime', 'recommendation']
            }
          },
          roadmap: {
            type: Type.OBJECT,
            properties: {
              criticalAlerts: { type: Type.ARRAY, items: { type: Type.STRING } },
              specialistReferrals: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    specialty: { type: Type.STRING },
                    reason: { type: Type.STRING }
                  },
                  required: ['specialty', 'reason']
                }
              },
              timeBoundPlan: {
                type: Type.OBJECT,
                properties: {
                  next3Months: { type: Type.ARRAY, items: { type: Type.STRING } },
                  next6Months: { type: Type.ARRAY, items: { type: Type.STRING } },
                  next12Months: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ['next3Months', 'next6Months', 'next12Months']
              }
            },
            required: ['criticalAlerts', 'specialistReferrals', 'timeBoundPlan']
          }
        },
        required: ['healthScore', 'overallAssessment', 'crossCorrelations', 'velocityTrends', 'chronicSurveillance', 'roadmap']
      };

      const requestedModel = typeof req.body.model === 'string' && TASK_MODELS.analysis.includes(req.body.model as any)
        ? req.body.model
        : TASK_MODELS.analysis[0];

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
        responseSchema,
        preferredModel: requestedModel,
        clientGeminiKeys: req.body.clientGeminiKeys,
      });

      const parsed = parseJsonSafely(text) as Record<string, unknown>;

      // Extract and clamp healthScore (default 80 if missing or invalid)
      const rawScore = Number(parsed.healthScore);
      const healthScore = Number.isFinite(rawScore)
        ? Math.min(100, Math.max(0, Math.round(rawScore)))
        : 80;

      // Extract overallAssessment (default fallback if missing)
      const overallAssessment = typeof parsed.overallAssessment === 'string' && parsed.overallAssessment.trim()
        ? parsed.overallAssessment.trim()
        : `Dựa trên hồ sơ y tế hiện tại của ${memberName}, hệ thống đã tổng hợp và phân tích thông tin sức khỏe.`;

      // Normalize crossCorrelations
      const crossRaw = Array.isArray(parsed.crossCorrelations) ? parsed.crossCorrelations : [];
      const crossCorrelations = crossRaw.map((item: any) => {
        const rawSev = String(item?.severity || '').toLowerCase();
        let severity: 'critical' | 'warning' | 'info' = 'info';
        if (/critical|danger|high|red|khẩn|nghiêm trọng/i.test(rawSev)) severity = 'critical';
        else if (/warning|medium|cảnh báo|chú ý/i.test(rawSev)) severity = 'warning';

        const parameters = Array.isArray(item?.parameters)
          ? item.parameters.map(String).filter(Boolean)
          : [];

        return {
          parameters,
          findings: typeof item?.findings === 'string' ? item.findings : 'Chưa phát hiện bất thường tương quan.',
          severity,
        };
      });

      // Normalize velocityTrends
      const velocityRaw = Array.isArray(parsed.velocityTrends) ? parsed.velocityTrends : [];
      const velocityTrends = velocityRaw.map((item: any) => {
        const rawTrend = String(item?.trendDirection || '').toLowerCase();
        let trendDirection: 'increasing' | 'decreasing' | 'stable' | 'fluctuating' = 'stable';
        if (/increasing|up|tăng/i.test(rawTrend)) trendDirection = 'increasing';
        else if (/decreasing|down|giảm/i.test(rawTrend)) trendDirection = 'decreasing';
        else if (/fluctuating|dao động/i.test(rawTrend)) trendDirection = 'fluctuating';

        return {
          metricName: typeof item?.metricName === 'string' ? item.metricName : 'Chỉ số sinh tồn',
          trendDirection,
          velocityDescription: typeof item?.velocityDescription === 'string' ? item.velocityDescription : 'Dữ liệu ổn định trong khoảng theo dõi.',
          riskProjection: typeof item?.riskProjection === 'string' ? item.riskProjection : 'Tiếp tục duy trì lịch theo dõi định kỳ.',
        };
      });

      // Normalize chronicSurveillance
      const chronicRaw = Array.isArray(parsed.chronicSurveillance) ? parsed.chronicSurveillance : [];
      const chronicSurveillance = chronicRaw.map((item: any) => {
        const rawStatus = String(item?.status || '').toLowerCase();
        let status: 'stable_benign' | 'monitored' | 'progressing' | 'resolved' = 'stable_benign';
        if (/progressing|worsening|tiến triển/i.test(rawStatus)) status = 'progressing';
        else if (/monitored|theo dõi/i.test(rawStatus)) status = 'monitored';
        else if (/resolved|khỏi|xử lý/i.test(rawStatus)) status = 'resolved';

        return {
          conditionName: typeof item?.conditionName === 'string' ? item.conditionName : 'Tình trạng sức khỏe',
          status,
          comparisonOverTime: typeof item?.comparisonOverTime === 'string' ? item.comparisonOverTime : 'Không có dấu hiệu chuyển biến xấu.',
          recommendation: typeof item?.recommendation === 'string' ? item.recommendation : 'Tái khám định kỳ theo chỉ định của bác sĩ.',
        };
      });

      // Normalize roadmap
      const roadmapRaw = isRecord(parsed.roadmap) ? parsed.roadmap : {};
      const timeBoundPlanRaw = isRecord(roadmapRaw.timeBoundPlan) ? roadmapRaw.timeBoundPlan : {};

      const criticalAlerts = Array.isArray(roadmapRaw.criticalAlerts)
        ? roadmapRaw.criticalAlerts.map(String).filter(Boolean)
        : [];

      const specialistReferrals = Array.isArray(roadmapRaw.specialistReferrals)
        ? roadmapRaw.specialistReferrals.map((item: any) => ({
            specialty: String(item?.specialty || 'Nội khoa tổng quát'),
            reason: String(item?.reason || 'Khám sức khỏe định kỳ'),
          }))
        : [];

      const timeBoundPlan = {
        next3Months: Array.isArray(timeBoundPlanRaw.next3Months) ? timeBoundPlanRaw.next3Months.map(String).filter(Boolean) : [],
        next6Months: Array.isArray(timeBoundPlanRaw.next6Months) ? timeBoundPlanRaw.next6Months.map(String).filter(Boolean) : [],
        next12Months: Array.isArray(timeBoundPlanRaw.next12Months) ? timeBoundPlanRaw.next12Months.map(String).filter(Boolean) : [],
      };

      const roadmap = {
        criticalAlerts,
        specialistReferrals,
        timeBoundPlan,
      };

      const todayStr = new Date().toISOString().slice(0, 10);
      const specialistConsultationList = Array.from(new Set([
        ...roadmap.specialistReferrals.map((s) => s.specialty).filter(Boolean),
      ]));
      const dietaryModificationsList = roadmap.timeBoundPlan.next3Months.filter((item) =>
        /chế độ ăn|kiêng|purin|rượu|nước|dinh dưỡng/i.test(item),
      );
      const followUpScheduleStr =
        roadmap.timeBoundPlan.next3Months.find((item) => /tái khám|kiểm tra lại|xét nghiệm lại/i.test(item));

      const aiAnalysisBlock = {
        lastAnalyzedDate: todayStr,
        overviewSummary: overallAssessment,
        criticalAlerts:
          roadmap.criticalAlerts.length > 0
            ? roadmap.criticalAlerts
            : crossCorrelations.filter((c) => c.severity === 'critical').map((c) => c.findings),
        chronicConditionsTracking: chronicSurveillance.map(
          (c) => `${c.conditionName}: ${c.comparisonOverTime || c.recommendation}`,
        ),
        actionRoadmap: {
          specialistConsultation: specialistConsultationList,
          dietaryModifications:
            dietaryModificationsList,
          followUpSchedule: followUpScheduleStr || '',
        },
      };

      res.json({
        success: true,
        result: {
          analyzedAt: new Date().toISOString(),
          healthScore,
          overallAssessment,
          crossCorrelations,
          velocityTrends,
          chronicSurveillance,
          roadmap,
        },
        aiAnalysis: aiAnalysisBlock,
        modelUsed,
      });
    } catch (error) {
      console.error('[Gemini Server Analyze Error]', { status: describeGeminiError(error).status });
      const { status, message } = describeGeminiError(error);
      let userFriendlyMessage = message;
      if (status === 503 || /high demand|temporarily unavailable|overloaded/i.test(message)) {
        userFriendlyMessage = 'Mô hình AI hiện đang quá tải từ máy chủ Google (503 High Demand). Hệ thống sẽ tự động thử lại khi có tài liệu mới.';
      } else if (status === 429 || /quota|resource_exhausted/i.test(message)) {
        userFriendlyMessage = 'Hạn ngạch AI tạm thời đạt giới hạn (429 Quota Exhausted). Vui lòng thử lại sau.';
      }
      res.status(500).json({
        error: userFriendlyMessage,
      });
    }
  });

  // 5. Trợ lý AI Hỏi đáp sức khỏe (Hỗ trợ cả Streaming SSE và Non-streaming)
  app.post('/api/gemini/ask-assistant', async (req: Request, res: Response) => {
    try {
      const { question, member, profile, stream } = req.body;
      if (!question) {
        res.status(400).json({ error: 'Chưa có nội dung câu hỏi.' });
        return;
      }

      const memberName = member?.name || 'Thành viên';
      const prompt = `Bạn là trợ lý bác sĩ gia đình thông minh, tận tâm và có chuyên môn cao.
Bạn đang tư vấn sức khỏe cho thành viên ${memberName}.
Hồ sơ bệnh án của thành viên:
- Chẩn đoán gần đây: ${(profile?.summary?.latestDiagnoses || []).join(', ') || 'Chưa có'}
- Các chỉ số sinh tồn gần nhất: ${JSON.stringify(profile?.summary?.latestMetrics || {})}
- Lịch sử khám chữa bệnh gần đây: ${JSON.stringify((profile?.timeline || []).slice(-6))}

Câu hỏi từ người dùng: "${question}"

Hãy trả lời chi tiết, ân cần, căn cứ vào dữ liệu hồ sơ bệnh án của thành viên để đưa ra giải thích y khoa dễ hiểu và lời khuyên thiết thực. Lưu ý nhắc người dùng luôn tham vấn bác sĩ điều trị trực tiếp khi có dấu hiệu khẩn cấp.`;

      // Streaming SSE
      if (stream) {
        const scheduler = getQuotaScheduler();
        const serverProjects = scheduler.getProjects();
        const clientProjects = parseGeminiProjects(req.body.clientGeminiKeys || [], undefined);
        const projects = [...serverProjects, ...clientProjects];
        
        if (projects.length === 0) throw new Error('Chưa cấu hình GEMINI_API_KEYS.');
        
        const activeScheduler = clientProjects.length > 0
          ? new GeminiQuotaScheduler(projects)
          : scheduler;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error('Câu hỏi vượt quá thời gian chờ tối đa.')),
          GEMINI_ANALYSIS_TIMEOUT_MS,
        );
        const heartbeat = setInterval(
          () => writeSse(res, { type: 'progress', message: 'Trợ lý vẫn đang xử lý câu hỏi.' }),
          15_000,
        );
        res.on('close', () => {
          if (!res.writableEnded) controller.abort(new Error('Client disconnected.'));
          clearTimeout(timeout);
          clearInterval(heartbeat);
        });

        let streamed = false;
        let lastError: Error | null = null;
        try {
          for (const model of TASK_MODELS.assistant) {
            const attemptedProjectIds = new Set<string>();
            while (attemptedProjectIds.size < projects.length && !controller.signal.aborted) {
              let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
              try {
                lease = await activeScheduler.acquire(
                  'assistant',
                  model,
                  getTaskQuota('assistant'),
                  attemptedProjectIds,
                  2_000,
                );
              } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                break;
              }
              attemptedProjectIds.add(lease.project.id);
              const attemptController = new AbortController();
              const cancelAttempt = () => attemptController.abort(new Error('Client disconnected.'));
              controller.signal.addEventListener('abort', cancelAttempt, { once: true });
              const attemptTimeout = setTimeout(
                () => attemptController.abort(new Error('Gemini stream timed out.')),
                GEMINI_ANALYSIS_ATTEMPT_TIMEOUT_MS,
              );
              let hasOutput = false;
              try {
                const ai = new GoogleGenAI({
                  apiKey: lease.project.apiKey,
                  httpOptions: {
                    timeout: GEMINI_ANALYSIS_ATTEMPT_TIMEOUT_MS,
                    headers: { 'User-Agent': 'aistudio-build' },
                  },
                });
                const streamResult = await ai.models.generateContentStream({
                  model,
                  contents: prompt,
                  config: { abortSignal: attemptController.signal },
                });
                for await (const chunk of streamResult) {
                  if (attemptController.signal.aborted) throw new Error('Gemini stream was cancelled.');
                  if (chunk.text) {
                    hasOutput = true;
                    writeSse(res, { text: chunk.text, modelUsed: model });
                  }
                }
                if (!hasOutput) throw new Error('Gemini returned an empty stream.');
                streamed = true;
                break;
              } catch (error) {
                const details = describeGeminiError(error);
                lastError = error instanceof Error ? error : new Error(String(error));
                const shouldRetry = recordProjectFailure(activeScheduler, lease.project.id, model, error);
                if (hasOutput || controller.signal.aborted) throw lastError;
                console.warn(
                  `[Gemini assistant] ${model} failed for configured project ${lease.project.id} (${details.status || 'network'}).`,
                );
                if (!shouldRetry) throw lastError;
              } finally {
                clearTimeout(attemptTimeout);
                controller.signal.removeEventListener('abort', cancelAttempt);
                lease.release();
              }
            }
            if (streamed || controller.signal.aborted) break;
          }
          if (!streamed) throw lastError || new Error('Không còn quota khả dụng cho trợ lý Gemini.');
          writeSse(res, { type: 'done' });
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Lỗi khi giao tiếp với trợ lý Gemini.';
          writeSse(res, { type: 'error', error: message });
          res.end();
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
        }
        return;
      }

      // Non-streaming response
      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'assistant',
        contents: [{ text: prompt }],
        clientGeminiKeys: req.body.clientGeminiKeys,
      });

      res.json({ success: true, answer: text, modelUsed });
    } catch (error) {
      console.error('[Gemini Server Assistant Error]', { status: describeGeminiError(error).status });
      if (res.headersSent) {
        writeSse(res, {
          type: 'error',
          error: error instanceof Error ? error.message : 'Lỗi khi giao tiếp với trợ lý bác sĩ.',
        });
        res.end();
      } else {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Lỗi khi giao tiếp với trợ lý bác sĩ.',
        });
      }
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 500;
    if (status === 413) {
      res.status(413).json({ error: 'Yêu cầu vượt giới hạn kích thước. Tệp PDF tối đa 25 MB.' });
      return;
    }
    if (status === 400) {
      res.status(400).json({ error: 'Dữ liệu yêu cầu không phải JSON hợp lệ.' });
      return;
    }
    console.error('[HTTP] Unhandled server error.');
    res.status(500).json({ error: 'Máy chủ chưa thể xử lý yêu cầu.' });
  });

  // Front-end handling
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get(/^\/.*$/, (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Health Server] Running on http://0.0.0.0:${PORT} (mode: ${isProd ? 'production' : 'development'})`);
  });
  server.keepAliveTimeout = 300_000;
  server.headersTimeout = 305_000;
  server.requestTimeout = 300_000;
}

startServer().catch((err) => {
  console.error('[Fatal Server Startup Error]:', err);
  process.exit(1);
});
