import { GoogleGenAI } from '@google/genai';
import { digitizationLogger } from './digitizationLogger';
import {
  GeminiQuotaScheduler,
  type GeminiQuota,
  type GeminiTask,
} from './geminiQuotaScheduler';
import {
  getOrCreateSharedGeminiRequestContext,
  type GeminiRequestContext,
} from './geminiRequestContext';
import {
  buildHealthResearchCitations,
  HEALTH_RESEARCH_SYSTEM_INSTRUCTION,
  type HealthAssistantResearch,
} from './healthAiPrompts';
import { createMedicalSearchQuery } from './healthAssistantContext';
import { TASK_MODELS } from './geminiModels';

export { TASK_MODELS } from './geminiModels';

export const GEMINI_TIMEOUTS = {
  analysisAttemptMs: 180_000,
  digitizationAttemptMs: 300_000,
  analysisTotalMs: 300_000,
  ocrTotalMs: 600_000,
  projectCooldownMs: 3_000,
} as const;

export function getAttemptTimeout(task: GeminiTask): number {
  return task === 'digitization'
    ? GEMINI_TIMEOUTS.digitizationAttemptMs
    : GEMINI_TIMEOUTS.analysisAttemptMs;
}

function getMinimumAttemptDuration(task: GeminiTask, attemptTimeoutMs?: number): number {
  return Math.min(30_000, attemptTimeoutMs || getAttemptTimeout(task));
}

export function getModelQuota(model: string): GeminiQuota {
  if (model === 'gemini-4-hydrogen') {
    return { rpm: 5 };
  }
  return { rpm: 15 };
}

export function getTaskQuota(task: GeminiTask): GeminiQuota {
  return getModelQuota(TASK_MODELS[task][0]);
}

export function describeGeminiError(error: unknown): {
  status?: number;
  message: string;
  isInvalidKey: boolean;
  isDailyQuota: boolean;
  isRateLimit: boolean;
  isTransient: boolean;
} {
  if (!error) {
    return {
      message: 'Lỗi không xác định khi kết nối với máy chủ AI.',
      isInvalidKey: false,
      isDailyQuota: false,
      isRateLimit: false,
      isTransient: false,
    };
  }

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
  if (!Number.isFinite(statusCode) || statusCode <= 0) {
    statusCode = 0;
  }

  const isAllKeysDailyQuotaMessage =
    /All configured Gemini API keys have exhausted daily quota/i.test(candidateMessage);
  if (isAllKeysDailyQuotaMessage) {
    return {
      status: 429,
      message: 'Tất cả API key trong Tài nguyên AI đều đã hết quota RPD cho mô hình này. Vui lòng kiểm tra quota Gemini hoặc bổ sung key khác.',
      isInvalidKey: false,
      isDailyQuota: true,
      isRateLimit: true,
      isTransient: false,
    };
  }

  const isInternalSchedulerMessage =
    /Timed out waiting for an available.*quota slot|No RPM capacity remains|No available projects remain/i.test(
      candidateMessage,
    );
  if (/Timed out waiting for an available.*quota slot/i.test(candidateMessage)) {
    return {
      status: 503,
      message: 'Bộ điều phối AI đang bận và chưa cấp được lượt gọi Gemini. Đây chưa phải xác nhận Google đã hết quota; vui lòng thử lại sau.',
      isInvalidKey: false,
      isDailyQuota: false,
      isRateLimit: false,
      isTransient: true,
    };
  }

  const isDeadline =
    !isInternalSchedulerMessage && (
      statusCode === 504 ||
      statusValue === 'DEADLINE_EXCEEDED' ||
      /DEADLINE_EXCEEDED|504|Deadline expired|deadline/i.test(candidateMessage)
    );
  const isOverloaded =
    !isInternalSchedulerMessage && (
      statusCode === 503 ||
      statusValue === 'UNAVAILABLE' ||
      /503|UNAVAILABLE|high demand|overloaded|temporarily unavailable/i.test(candidateMessage)
    );
  const isRateLimit =
    !isInternalSchedulerMessage && (
      statusCode === 429 ||
      statusValue === 'RESOURCE_EXHAUSTED' ||
      /429|RESOURCE_EXHAUSTED|(?<!\w)quota(?!\s*slot)|rate limit/i.test(candidateMessage)
    );
  const isInvalidKey =
    statusCode === 401 ||
    statusCode === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED|unauthorized|invalid api key|api key not valid/i.test(candidateMessage);
  const isDailyQuota =
    isRateLimit &&
    /(?:\brpd\b|per[\s_-]*day|daily|requests?[\s_-]*per[\s_-]*day|quota[^.\n]{0,80}(?:day|daily)|generate.*requests.*per.*day)/i.test(
      candidateMessage,
    );
  const isTransient =
    !isInternalSchedulerMessage && (
      isDeadline ||
      isOverloaded ||
      statusCode === 500 ||
      statusCode === 502 ||
      /502|500|timeout|timed out|failed to fetch|networkerror|load failed|network request failed|empty response|empty stream/i.test(
        candidateMessage,
      )
    );

  if (isDeadline) {
    return {
      status: 504,
      message: 'Yêu cầu AI xử lý bị quá thời gian chờ từ máy chủ Google (504 Deadline Exceeded). Vui lòng thử lại.',
      isInvalidKey: false,
      isDailyQuota: false,
      isRateLimit: false,
      isTransient: true,
    };
  }

  if (isOverloaded) {
    return {
      status: 503,
      message: 'Máy chủ AI Google hiện đang bận hoặc quá tải (503 Service Unavailable). Vui lòng thử lại sau ít giây.',
      isInvalidKey: false,
      isDailyQuota: false,
      isRateLimit: false,
      isTransient: true,
    };
  }

  if (isRateLimit) {
    return {
      status: 429,
      message: 'Gemini đang giới hạn tần suất gọi (429). Vui lòng thử lại sau ít phút.',
      isInvalidKey: false,
      isDailyQuota,
      isRateLimit: true,
      isTransient: false,
    };
  }

  if (isInvalidKey) {
    return {
      status: statusCode || 403,
      message: 'API Key không hợp lệ hoặc đã bị vô hiệu hóa.',
      isInvalidKey: true,
      isDailyQuota: false,
      isRateLimit: false,
      isTransient: false,
    };
  }

  return {
    status: statusCode || undefined,
    message: candidateMessage.trim() || 'Lỗi xử lý dịch vụ Gemini API.',
    isInvalidKey: false,
    isDailyQuota: false,
    isRateLimit: false,
    isTransient,
  };
}

export function parseRetryAfterMs(error: unknown): number {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const seconds = raw.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*s/i);
  return seconds ? Math.min(60_000, Math.max(1_000, Number(seconds[1]) * 1_000)) : 5_000;
}

export function isDailyQuotaError(error: unknown): boolean {
  return describeGeminiError(error).isDailyQuota;
}

export function recordProjectFailure(
  scheduler: GeminiQuotaScheduler,
  projectId: string,
  model: string,
  error: unknown,
  disableInvalidProject = true,
  disableUnavailableModel = true,
): boolean {
  const details = describeGeminiError(error);
  if (details.isRateLimit || details.status === 429) {
    if (!details.isDailyQuota) {
      scheduler.markRateLimited(projectId, model, parseRetryAfterMs(error));
    }
    return true;
  }
  if (details.isInvalidKey) {
    if (disableInvalidProject) scheduler.markProjectUnavailable(projectId);
    return true;
  }
  if (details.status === 404 || /model.{0,40}(not found|unsupported|not available)/i.test(details.message)) {
    if (disableUnavailableModel) scheduler.markModelUnavailable(projectId, model);
    return true;
  }
  return details.status !== 400;
}

export function createGeminiSdkClient(apiKey: string, timeoutMs?: number): GoogleGenAI {
  const isNodeServer = typeof window === 'undefined';
  if (isNodeServer && timeoutMs) {
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: timeoutMs,
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
  }
  return new GoogleGenAI({ apiKey });
}

export interface UnifiedExecuteOptions {
  task: GeminiTask;
  contents: unknown;
  systemInstruction?: string;
  responseMimeType?: string;
  temperature?: number;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  preferredProjectId?: string;
  preferredModel?: string;
  responseSchema?: unknown;
  generationConfig?: Record<string, unknown>;
  clientGeminiKeys?: string[];
  requestContext?: GeminiRequestContext;
  onGroundingChunks?: (chunks: unknown) => void;
  maxPoolPasses?: number;
  shouldStopRetrying?: (error: unknown) => boolean;
  skipFailurePenalties?: boolean;
}

async function callGeminiSingleAttempt(
  apiKey: string,
  model: string,
  options: UnifiedExecuteOptions,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('Gemini request was cancelled.');

  const remainingTime = deadline - Date.now();
  const requestedAttemptTimeout = options.attemptTimeoutMs || getAttemptTimeout(options.task);
  if (remainingTime < getMinimumAttemptDuration(options.task, options.attemptTimeoutMs)) {
    throw new Error(
      `Thời gian xử lý còn lại (${Math.round(remainingTime / 1000)}s) không đủ để gửi request tới Gemini API.`,
    );
  }

  const calculatedTimeoutMs = Math.min(requestedAttemptTimeout, remainingTime);

  const attemptController = new AbortController();
  const cancelAttempt = () => attemptController.abort(new Error('Client disconnected.'));
  signal?.addEventListener('abort', cancelAttempt, { once: true });
  const attemptTimeout = setTimeout(
    () => attemptController.abort(new Error('Gemini attempt timed out.')),
    calculatedTimeoutMs,
  );

  try {
    const ai = createGeminiSdkClient(apiKey, calculatedTimeoutMs);
    const config: Record<string, unknown> = {
      ...options.generationConfig,
      abortSignal: attemptController.signal,
    };
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
    if (options.onGroundingChunks) {
      options.onGroundingChunks(response.candidates?.[0]?.groundingMetadata?.groundingChunks);
    }
    const text = response.text || '';
    if (!text.trim()) throw new Error('Gemini returned an empty response.');
    return text;
  } finally {
    clearTimeout(attemptTimeout);
    signal?.removeEventListener('abort', cancelAttempt);
  }
}

/**
 * Single unified Gemini orchestrator shared identically by Server (/server.ts)
 * and Standalone APK Client (geminiService.ts).
 * Uses GeminiQuotaScheduler for RPM queueing and provider-confirmed RPD failover,
 * multi-key rotation, cooldowns, invalid-key exclusion, and pool-pass retries.
 */
export async function executeGeminiWithPool(
  options: UnifiedExecuteOptions,
): Promise<{ text: string; modelUsed: string; projectId: string }> {
  const { projects, scheduler } = options.requestContext
    || getOrCreateSharedGeminiRequestContext(options.clientGeminiKeys);

  const targetModel = options.preferredModel
    || (TASK_MODELS[options.task] ? TASK_MODELS[options.task][0] : 'gemini-3.5-flash-lite');
  const quota = options.task === 'digitization' ? getTaskQuota('digitization') : getModelQuota(targetModel);
  const totalBudgetMs = options.timeoutMs
    || (options.task === 'digitization' ? GEMINI_TIMEOUTS.ocrTotalMs : GEMINI_TIMEOUTS.analysisTotalMs);
  const deadline = Date.now() + totalBudgetMs;
  const minimumAttemptMs = getMinimumAttemptDuration(options.task, options.attemptTimeoutMs);
  const maxPoolPasses = options.maxPoolPasses ?? (options.task === 'digitization' ? 3 : 2);
  const dailyQuotaExhaustedProjectIds = new Set<string>();
  let lastError: Error | null = null;

  for (let pass = 0; pass < maxPoolPasses; pass++) {
    if (options.signal?.aborted) throw new Error('Gemini request was cancelled.');
    if (Date.now() >= deadline - minimumAttemptMs) break;

    const attemptedProjectIds = new Set<string>();
    let sawRetryableFailureInPass = false;
    let sawAbortForFallback = false;

    while (
      new Set([...attemptedProjectIds, ...dailyQuotaExhaustedProjectIds]).size < projects.length &&
      Date.now() < deadline - minimumAttemptMs
    ) {
      if (options.signal?.aborted) throw new Error('Gemini request was cancelled.');

      const remainingAcquireMs = Math.max(1, deadline - Date.now() - minimumAttemptMs);
      const acquireTimeoutMs = remainingAcquireMs;
      const excludedProjectIds = new Set([...attemptedProjectIds, ...dailyQuotaExhaustedProjectIds]);

      let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
      try {
        lease = await scheduler.acquire(
          options.task,
          targetModel,
          quota,
          excludedProjectIds,
          acquireTimeoutMs,
          options.preferredProjectId && !attemptedProjectIds.has(options.preferredProjectId)
            ? options.preferredProjectId
            : undefined,
          options.signal,
        );
      } catch (err) {
        if (!lastError) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        break;
      }

      const { project } = lease;
      attemptedProjectIds.add(project.id);

      try {
        options.onProgress?.(`Đang xử lý bằng ${targetModel} (${project.id})`);
        const text = await callGeminiSingleAttempt(
          project.apiKey,
          targetModel,
          options,
          deadline,
          options.signal,
        );
        return { text, modelUsed: targetModel, projectId: project.id };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const details = describeGeminiError(error);
        lastError =
          error instanceof Error
            ? error
            : Object.assign(new Error(details.message), {
                status: details.status,
                cause: error,
              });

        const stopForFallback = options.shouldStopRetrying?.(error) === true;
        if (details.isDailyQuota) {
          dailyQuotaExhaustedProjectIds.add(project.id);
        }
        if (stopForFallback && !details.isDailyQuota) {
          sawAbortForFallback = true;
        } else if (!options.skipFailurePenalties) {
          const shouldRetry = recordProjectFailure(
            scheduler,
            project.id,
            targetModel,
            error,
            true,
            options.task !== 'digitization',
          );
          if (details.isTransient) {
            scheduler.markProjectCooldown(project.id, GEMINI_TIMEOUTS.projectCooldownMs);
            sawRetryableFailureInPass = true;
          } else if (details.isRateLimit && !details.isDailyQuota) {
            sawRetryableFailureInPass = true;
          }

          if (!shouldRetry) throw lastError;
        }

        digitizationLogger.log(
          'warn',
          options.task === 'digitization' ? 'worker' : 'task-executor',
          `Task ${options.task} thất bại với ${project.id} trên ${targetModel} (${details.status || 'network'}).`,
          { task: options.task, projectId: project.id, model: targetModel, status: details.status, pass: pass + 1 },
        );

        options.onProgress?.(`${project.id} gặp sự cố; tự động chuyển sang key khả dụng kế tiếp...`);
      } finally {
        lease.release();
      }
    }

    if (
      sawAbortForFallback ||
      !sawRetryableFailureInPass ||
      pass >= maxPoolPasses - 1 ||
      Date.now() >= deadline - minimumAttemptMs
    ) {
      break;
    }

    const backoffMs = Math.min(
      Math.pow(2, pass + 1) * 1_500,
      Math.max(1_000, deadline - Date.now() - minimumAttemptMs),
    );
    options.onProgress?.(`Tất cả API key đều đang bận; thử lại lượt ${pass + 2}/${maxPoolPasses} sau ${Math.ceil(backoffMs / 1000)}s...`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  if (projects.length > 0 && dailyQuotaExhaustedProjectIds.size === projects.length) {
    throw new Error(`All configured Gemini API keys have exhausted daily quota for ${targetModel}.`);
  }
  throw lastError || new Error(`Đã hết quota hoặc thời gian chờ cho mô hình ${targetModel}.`);
}

export async function executeGeminiStreamWithPool(
  options: UnifiedExecuteOptions,
  onChunk: (chunk: string, modelUsed: string) => void,
): Promise<{ text: string; modelUsed: string; projectId: string }> {
  const { projects, scheduler } = options.requestContext
    || getOrCreateSharedGeminiRequestContext(options.clientGeminiKeys);

  const targetModel = options.preferredModel
    || (TASK_MODELS[options.task] ? TASK_MODELS[options.task][0] : 'gemini-3.5-flash-lite');
  const quota = getModelQuota(targetModel);
  const deadline = Date.now() + (options.timeoutMs || GEMINI_TIMEOUTS.analysisTotalMs);
  const attemptedProjectIds = new Set<string>();
  const dailyQuotaExhaustedProjectIds = new Set<string>();
  let lastError: Error | null = null;

  while (
    new Set([...attemptedProjectIds, ...dailyQuotaExhaustedProjectIds]).size < projects.length &&
    Date.now() < deadline - 30_000
  ) {
    if (options.signal?.aborted) throw new Error('Gemini stream was cancelled.');

    const remainingAcquireMs = Math.max(1, deadline - Date.now() - 30_000);
    const streamAcquireTimeoutMs = remainingAcquireMs;
    const excludedProjectIds = new Set([...attemptedProjectIds, ...dailyQuotaExhaustedProjectIds]);

    let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
    try {
      lease = await scheduler.acquire(
        options.task,
        targetModel,
        quota,
        excludedProjectIds,
        streamAcquireTimeoutMs,
        undefined,
        options.signal,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      break;
    }

    attemptedProjectIds.add(lease.project.id);
    const attemptController = new AbortController();
    const cancelAttempt = () => attemptController.abort(new Error('Client disconnected.'));
    options.signal?.addEventListener('abort', cancelAttempt, { once: true });
    const attemptTimeout = setTimeout(
      () => attemptController.abort(new Error('Gemini stream timed out.')),
      options.attemptTimeoutMs || GEMINI_TIMEOUTS.analysisAttemptMs,
    );

    let hasOutput = false;
    let fullText = '';

    try {
      const ai = createGeminiSdkClient(lease.project.apiKey, GEMINI_TIMEOUTS.analysisAttemptMs);
      const config: Record<string, unknown> = {
        ...options.generationConfig,
        abortSignal: attemptController.signal,
      };
      if (options.systemInstruction) config.systemInstruction = options.systemInstruction;

      const streamResult = await ai.models.generateContentStream({
        model: targetModel,
        contents: options.contents as any,
        config,
      });

      for await (const chunk of streamResult) {
        if (attemptController.signal.aborted) throw new Error('Gemini stream was cancelled.');
        const piece = chunk.text || '';
        if (piece) {
          hasOutput = true;
          fullText += piece;
          onChunk(piece, targetModel);
        }
      }

      if (!hasOutput) throw new Error('Gemini returned an empty stream.');
      return { text: fullText, modelUsed: targetModel, projectId: lease.project.id };
    } catch (error) {
      const details = describeGeminiError(error);
      lastError =
        error instanceof Error
          ? error
          : Object.assign(new Error(details.message), {
              status: details.status,
              cause: error,
            });
      const shouldRetry = recordProjectFailure(scheduler, lease.project.id, targetModel, error);
      if (details.isDailyQuota) dailyQuotaExhaustedProjectIds.add(lease.project.id);
      if (hasOutput || options.signal?.aborted) throw lastError;
      if (!shouldRetry) throw lastError;
    } finally {
      clearTimeout(attemptTimeout);
      options.signal?.removeEventListener('abort', cancelAttempt);
      lease.release();
    }
  }

  if (projects.length > 0 && dailyQuotaExhaustedProjectIds.size === projects.length) {
    throw new Error(`All configured Gemini API keys have exhausted daily quota for ${targetModel}.`);
  }
  throw lastError || new Error('Không còn quota khả dụng cho trợ lý Gemini.');
}

/**
 * Shared medical Google Search grounding step used by BOTH server and standalone APK client.
 * Strips PII from the query, retrieves medical sources via Google Search, filters strictly
 * to approved medical domains, and gracefully returns empty citations on non-abort search failure
 * so assistant answers from the patient profile are never blocked.
 */
export async function researchHealthQuestionWithPool(
  question: string,
  memberName: string,
  options: {
    clientGeminiKeys?: string[];
    requestContext?: GeminiRequestContext;
    signal?: AbortSignal;
  } = {},
): Promise<HealthAssistantResearch> {
  const searchQuery = createMedicalSearchQuery(question, memberName);
  if (!searchQuery) return { summary: null, citations: [] };

  let groundingChunks: unknown;
  try {
    const { text } = await executeGeminiWithPool({
      task: 'assistant',
      contents: [{ text: `Tìm thông tin y tế đáng tin cậy về chủ đề sau: ${searchQuery}` }],
      systemInstruction: HEALTH_RESEARCH_SYSTEM_INSTRUCTION,
      generationConfig: { tools: [{ googleSearch: {} }] },
      clientGeminiKeys: options.clientGeminiKeys,
      requestContext: options.requestContext,
      signal: options.signal,
      maxPoolPasses: 1,
      timeoutMs: 12_000,
      attemptTimeoutMs: 10_000,
      skipFailurePenalties: true,
      onGroundingChunks: (chunks) => {
        groundingChunks = chunks;
      },
    });
    return buildHealthResearchCitations(groundingChunks, text);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const details = describeGeminiError(error);
    digitizationLogger.log(
      'warn',
      'assistant-research',
      `Tìm kiếm nguồn y khoa trực tuyến tạm thời không khả dụng (${details.status || 'search'}); tiếp tục trả lời từ hồ sơ sức khỏe.`,
      { status: details.status },
    );
    return { summary: null, citations: [] };
  }
}

export async function testGeminiApiKeyDirect(
  apiKey: string,
  timeoutMs = 15_000,
): Promise<{ valid: boolean; workingModel: string; quotaExhausted?: boolean; error?: string }> {
  const cleanKey = apiKey.trim();
  const modelUsed = TASK_MODELS.assistant[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Kiểm tra API key bị quá thời gian chờ.')), timeoutMs);
  try {
    const ai = createGeminiSdkClient(cleanKey, timeoutMs);
    await ai.models.generateContent({
      model: modelUsed,
      contents: 'OK',
      config: { maxOutputTokens: 16, abortSignal: controller.signal },
    });
    return { valid: true, workingModel: modelUsed };
  } catch (err) {
    const details = describeGeminiError(err);
    if (details.isRateLimit || details.status === 429) {
      return { valid: true, workingModel: modelUsed, quotaExhausted: true };
    }
    return { valid: false, workingModel: modelUsed, error: details.message };
  } finally {
    clearTimeout(timer);
  }
}
