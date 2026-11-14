import { Capacitor } from '@capacitor/core';
import type {
  AiAnalysisBlock,
  AiDeepAnalysisResult,
  FamilyMember,
  HealthEvent,
  HealthMetric,
  HealthProfile,
  ImagingResult,
  JsonValue,
  Medication,
  VaccinationRecord,
  HospitalizationRecord,
} from '../types';
import { digitizationLogger } from './digitizationLogger';
import {
  classifyHealthEventType,
  cleanHospitalizationRecord,
  isHealthEventType,
} from './healthEventType';
import { sleep } from './healthRecordService';
import { getFirebaseIdToken } from './googleDriveService';
import { createApiRequestId } from './apiRequestId';
import { getSharedGeminiKeysForRequest } from './geminiSharedResources';
import { buildApiUrl } from './apiConfig';
import { readApiJson } from './apiResponse';
import { cleanErrorMessage } from './geminiErrorMessages';
import { TASK_MODELS } from './geminiModels';
import {
  buildComprehensiveAnalysisPrompt,
  buildRefinePrompt,
  buildSummarizePrompt,
  COMPREHENSIVE_ANALYSIS_RESPONSE_SCHEMA,
  createHealthAssistantPrompt,
  HEALTH_ASSISTANT_SYSTEM_INSTRUCTION,
  normalizeComprehensiveAnalysisPayload,
  SUMMARIZE_RESPONSE_SCHEMA,
} from './healthAiPrompts';
import {
  executeGeminiStreamWithPool,
  executeGeminiWithPool,
  researchHealthQuestionWithPool,
} from './geminiUnifiedExecutor';
import { getOrCreateSharedGeminiRequestContext } from './geminiRequestContext';
import { normalizeHealthAssistantHistory } from './healthAssistantContext';
import { parseRobustJson } from './healthRecordService';
import { runUnifiedHealthDocumentOcr } from './healthDocumentOcrRunner';
import {
  isApprovedMedicalCitationUrl,
  type HealthAssistantCitation,
  type HealthAssistantHistoryMessage,
} from './healthAssistantContext';

export { cleanErrorMessage };

export interface ExtractionProgressUpdate {
  stage:
    | 'preparing'
    | 'reading_document'
    | 'waiting_for_model'
    | 'retrying_model'
    | 'extracting_content'
    | 'matching_patient'
    | 'completed';
  progressPercent: number;
  message: string;
  modelUsed?: string;
  partialEvent?: Partial<HealthEvent>;
  rawChunk?: string;
  totalPages?: number;
  processedPages?: number;
}

function isUnreachableBackendError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message))
  );
}

function isBackendUnavailableError(error: unknown): boolean {
  return (
    isUnreachableBackendError(error) ||
    (error instanceof Error && /chưa cấu hình máy chủ AI/i.test(error.message))
  );
}

function isNativeApkRuntime(): boolean {
  return (
    Capacitor.isNativePlatform() ||
    import.meta.env.VITE_APP_MODE === 'apk' ||
    import.meta.env.VITE_APP_MODE === 'play'
  );
}

async function runDirectGeminiFallback<T>(
  endpoint: string,
  body: Record<string, unknown>,
  clientGeminiKeys: string[],
  requestId: string,
): Promise<T> {
  if (clientGeminiKeys.length === 0) {
    throw new Error('Chưa có API key trong Tài nguyên AI để chạy trực tiếp trên thiết bị.');
  }
  const requestContext = getOrCreateSharedGeminiRequestContext(clientGeminiKeys);
  digitizationLogger.log('warn', 'api_direct_fallback', 'Backend không truy cập được; chuyển sang Gemini SDK trên APK.', {
    requestId,
    endpoint,
    keyCount: clientGeminiKeys.length,
  });

  let result: unknown;
  if (endpoint === 'refine-and-organize') {
    const member = body.member as FamilyMember;
    const events = Array.isArray(body.events) ? body.events as HealthEvent[] : [];
    const { text, modelUsed } = await executeGeminiWithPool({
      task: 'refinement',
      contents: [{ text: buildRefinePrompt(member?.name || 'Thành viên', events) }],
      responseMimeType: 'application/json',
      requestContext,
      requestId,
    });
    const parsed = parseRobustJson(text);
    result = {
      success: true,
      organizedTimeline: Array.isArray(parsed.organizedEvents) ? parsed.organizedEvents : events,
      refinementNotes: Array.isArray(parsed.refinementNotes)
        ? parsed.refinementNotes
        : ['Đã chuẩn hóa dữ liệu.'],
      modelUsed,
    };
  } else if (endpoint === 'summarize') {
    const member = body.member as FamilyMember;
    const profile = body.profile as HealthProfile;
    const { text, modelUsed } = await executeGeminiWithPool({
      task: 'assistant',
      contents: [{ text: buildSummarizePrompt(member.name, member, profile) }],
      responseMimeType: 'application/json',
      responseSchema: SUMMARIZE_RESPONSE_SCHEMA,
      requestContext,
      requestId,
    });
    const parsed = parseRobustJson(text);
    result = { success: true, summary: parsed.summary || text, modelUsed };
  } else if (endpoint === 'analyze-comprehensive') {
    const member = body.member as FamilyMember;
    const profile = body.profile as HealthProfile;
    const model = TASK_MODELS.analysis.find((candidate) => candidate === body.model)
      || TASK_MODELS.analysis[0];
    const { text, modelUsed } = await executeGeminiWithPool({
      task: 'analysis',
      contents: [{ text: buildComprehensiveAnalysisPrompt(member.name, member, profile) }],
      responseMimeType: 'application/json',
      responseSchema: COMPREHENSIVE_ANALYSIS_RESPONSE_SCHEMA,
      preferredModel: model,
      requestContext,
      requestId,
    });
    result = {
      success: true,
      ...normalizeComprehensiveAnalysisPayload(parseRobustJson(text), member.name),
      modelUsed,
    };
  } else if (endpoint === 'ask-assistant') {
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const member = body.member as FamilyMember;
    const profile = body.profile as HealthProfile;
    const history = normalizeHealthAssistantHistory(body.history);
    const memberName = member?.name || 'Thành viên';
    const research = await researchHealthQuestionWithPool(question, memberName, {
      requestContext,
      requestId,
    });
    const prompt = createHealthAssistantPrompt(question, memberName, profile, history, research);
    const { text, modelUsed } = await executeGeminiWithPool({
      task: 'assistant',
      contents: [{ text: prompt }],
      systemInstruction: HEALTH_ASSISTANT_SYSTEM_INSTRUCTION,
      requestContext,
      requestId,
    });
    result = {
      success: true,
      answer: text,
      citations: research.citations,
      modelUsed,
    };
  } else {
    throw new Error(`Chưa hỗ trợ fallback Gemini trực tiếp cho tác vụ ${endpoint}.`);
  }
  return result as T;
}

async function callGemini<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const getDuration = digitizationLogger.startTimer();
  const requestId = createApiRequestId();
  let clientGeminiKeys: string[];
  digitizationLogger.log('info', 'api_request_start', 'Bắt đầu request tới Gemini gateway.', {
    requestId,
    endpoint,
  });
  try {
    clientGeminiKeys = await getSharedGeminiKeysForRequest();
  } catch (error) {
    digitizationLogger.log('error', 'api_request_setup_error', 'Không thể chuẩn bị request Gemini.', {
      requestId,
      endpoint,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      durationMs: getDuration(),
    });
    throw error;
  }
  let url: string;
  try {
    url = buildApiUrl(`/api/gemini/${endpoint}`);
  } catch (error) {
    if (isNativeApkRuntime()) {
      return await runDirectGeminiFallback<T>(endpoint, body, clientGeminiKeys, requestId);
    }
    digitizationLogger.log('error', 'api_request_setup_error', 'Không thể xác định URL Gemini gateway.', {
      requestId,
      endpoint,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      durationMs: getDuration(),
    });
    throw error;
  }

  const maxRetries = 2;
  let lastError: unknown;
  let lastHttpStatus: number | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const attemptStartedAt = Date.now();
    lastHttpStatus = undefined;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      };

      try {
        const token = await getFirebaseIdToken().catch(() => null);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch (e) {
        console.warn('[Gemini Service] Could not attach auth token:', e);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, clientGeminiKeys }),
      });

      if (!response.ok) {
        const status = response.status;
        lastHttpStatus = status;
        if ((status === 502 || status === 503 || status === 504) && attempt < maxRetries - 1) {
          const backoff = (attempt + 1) * 1500;
          digitizationLogger.log('warn', 'api_attempt_retry', 'Gemini gateway trả lỗi tạm thời; sẽ thử lại.', {
            requestId,
            endpoint,
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            status,
            backoffMs: backoff,
          });
          await response.text();
          await sleep(backoff);
          continue;
        }
      }

      const data = await readApiJson<T>(response, `Server Gemini (${endpoint})`);
      const durationMs = getDuration();
      digitizationLogger.log(
        'info',
        'api_request_complete',
        'Gemini gateway hoàn tất request.',
        { requestId, endpoint, status: response.status, durationMs },
        durationMs,
      );
      return data;
    } catch (error) {
      lastError = error;
      digitizationLogger.log(
        'warn',
        'api_attempt_error',
        'Lần gọi Gemini gateway thất bại.',
        {
          requestId,
          endpoint,
          attempt: attempt + 1,
          status: lastHttpStatus,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          durationMs: Date.now() - attemptStartedAt,
        },
        Date.now() - attemptStartedAt,
      );
      if (isNativeApkRuntime() && isUnreachableBackendError(error)) {
        return await runDirectGeminiFallback<T>(endpoint, body, clientGeminiKeys, requestId);
      }
      if (isUnreachableBackendError(error) && attempt < maxRetries - 1) {
        const backoff = (attempt + 1) * 1500;
        digitizationLogger.log(
          'warn',
          'api_attempt_retry',
          'Không kết nối được Gemini gateway; sẽ thử lại.',
          { requestId, endpoint, attempt: attempt + 1, nextAttempt: attempt + 2, backoffMs: backoff },
        );
        await sleep(backoff);
        continue;
      }
      break;
    }
  }

  const durationMs = getDuration();
  const errorMessage = cleanErrorMessage(lastError instanceof Error ? lastError.message : String(lastError));
  digitizationLogger.log(
    'error',
    'api_request_failed',
    `Gemini gateway request thất bại: ${errorMessage}`,
    {
      requestId,
      endpoint,
      status: lastHttpStatus,
      errorName: lastError instanceof Error ? lastError.name : 'UnknownError',
      durationMs,
    },
    durationMs,
  );
  throw lastError instanceof Error ? lastError : new Error(errorMessage);
}

// ============================================================================
// NHÓM NHIỆM VỤ 1: SỐ HÓA, OCR, NHẬN DẠNG TÀI LIỆU, HIỆU CHỈNH & SẮP XẾP DỮ LIỆU
// Web and native clients send Gemini work through the same backend orchestrator.
// ============================================================================

export function extractPartialJson(text: string, fileName?: string): Partial<HealthEvent> {
  const result: Partial<HealthEvent> = {};
  if (!text || typeof text !== 'string') return result;

  try {
    const cleaned = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        return normalizeExtractedEvent(parsed, fileName);
      }
    }
  } catch {
    // Fallback regex parsing for incomplete streams
  }

  const nameMatch = text.match(/"patientName"\s*:\s*"([^"]+)"/i);
  if (nameMatch) result.patientName = nameMatch[1].trim();

  const birthMatch = text.match(/"patientBirthDate"\s*:\s*"([^"]+)"/i);
  if (birthMatch) result.patientBirthDate = birthMatch[1].trim();

  const genderMatch = text.match(/"patientGender"\s*:\s*"([^"]+)"/i);
  if (genderMatch) result.patientGender = genderMatch[1].trim();

  const titleMatch = text.match(/"title"\s*:\s*"([^"]+)"/i);
  if (titleMatch) result.title = titleMatch[1].trim();

  const facilityMatch = text.match(/"facility"\s*:\s*"([^"]+)"/i);
  if (facilityMatch) result.facility = facilityMatch[1].trim();

  const typeMatch = text.match(/"type"\s*:\s*"([^"]+)"/i);
  if (typeMatch && isHealthEventType(typeMatch[1].trim())) {
    result.type = typeMatch[1].trim() as HealthEvent['type'];
  }

  const dateMatch = text.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/i);
  if (dateMatch) result.date = dateMatch[1];

  const diagMatch = text.match(/"diagnoses"\s*:\s*\[([\s\S]*?)\]/i);
  if (diagMatch) {
    const items = diagMatch[1].match(/"([^"]+)"/g);
    if (items) {
      result.diagnoses = items.map((s) => s.replace(/"/g, '').trim()).filter(Boolean);
    }
  }

  const medsMatch = text.match(/"medications"\s*:\s*\[([\s\S]*?)\]/i);
  if (medsMatch) {
    const medBlocks = medsMatch[1].match(/\{[\s\S]*?\}/g);
    if (medBlocks) {
      const parsedMeds: Medication[] = [];
      for (const block of medBlocks) {
        const medName = block.match(/"name"\s*:\s*"([^"]+)"/i);
        if (medName) {
          const dosage = block.match(/"dosage"\s*:\s*"([^"]+)"/i);
          const freq = block.match(/"frequency"\s*:\s*"([^"]+)"/i);
          const dur = block.match(/"duration"\s*:\s*"([^"]+)"/i);
          parsedMeds.push({
            name: medName[1].trim(),
            dosage: dosage ? dosage[1].trim() : undefined,
            frequency: freq ? freq[1].trim() : undefined,
            duration: dur ? dur[1].trim() : undefined,
          });
        }
      }
      if (parsedMeds.length > 0) {
        result.medications = parsedMeds;
      }
    }
  }

  const metricsMatch = text.match(/"metrics"\s*:\s*\[([\s\S]*?)\]/i);
  if (metricsMatch) {
    const metricBlocks = metricsMatch[1].match(/\{[\s\S]*?\}/g);
    if (metricBlocks) {
      const parsedMetrics: HealthMetric[] = [];
      for (const block of metricBlocks) {
        const mName = block.match(/"name"\s*:\s*"([^"]+)"/i);
        const mVal = block.match(/"value"\s*:\s*([0-9.]+)/i);
        const mUnit = block.match(/"unit"\s*:\s*"([^"]+)"/i);
        if (mName && mVal) {
          const num = parseFloat(mVal[1]);
          if (!isNaN(num)) {
            parsedMetrics.push({
              name: mName[1].trim(),
              value: num,
              unit: mUnit ? mUnit[1].trim() : '',
            });
          }
        }
      }
      if (parsedMetrics.length > 0) {
        result.metrics = parsedMetrics;
      }
    }
  }

  const adviceMatch = text.match(/"advice"\s*:\s*"([^"]+)"/i);
  if (adviceMatch) result.advice = adviceMatch[1].trim();

  return {
    ...result,
    type: classifyHealthEventType(result, fileName) || result.type,
  };
}

async function extractServerHealthEvent(
  file: File,
  member: FamilyMember,
  mimeType: string,
  base64Data: string,
  onProgress: ((update: ExtractionProgressUpdate) => void) | undefined,
  getDuration: () => number,
  options?: { isAutoDetect?: boolean; signal?: AbortSignal },
): Promise<{
  extracted: Partial<HealthEvent>;
  modelUsed?: string;
  totalPages?: number;
  processedPages?: number;
  contentIndexPages: string[];
  contentIndexComplete: boolean;
}> {
  const requestId = createApiRequestId();
  const requestStartedAt = Date.now();
  digitizationLogger.log('info', 'api_request_start', 'Bắt đầu request OCR tới Gemini gateway.', {
    requestId,
    endpoint: 'extract-health-event',
    fileType: mimeType,
    fileSize: file.size,
  });
  const clientGeminiKeys = await getSharedGeminiKeysForRequest();
  let url: string;
  try {
    url = buildApiUrl('/api/gemini/extract-health-event');
  } catch (error) {
    if (isNativeApkRuntime()) {
      return runDirectHealthDocumentOcr(
        file, member, mimeType, base64Data, clientGeminiKeys, requestId, onProgress, options,
      );
    }
    throw error;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
  };

  try {
    const token = await getFirebaseIdToken().catch(() => null);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } catch (e) {
    console.warn('[Gemini Service] Could not attach auth token for extraction:', e);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      signal: options?.signal,
      body: JSON.stringify({
        base64Data,
        mimeType,
        member,
        fileName: file.name,
        stream: true,
        clientGeminiKeys,
        isAutoDetect: options?.isAutoDetect ?? false,
      }),
    });
  } catch (error) {
    if (isNativeApkRuntime() && isUnreachableBackendError(error)) {
      return runDirectHealthDocumentOcr(
        file, member, mimeType, base64Data, clientGeminiKeys, requestId, onProgress, options,
      );
    }
    digitizationLogger.log('error', 'api_request_failed', 'Không kết nối được Gemini gateway cho OCR.', {
      requestId,
      endpoint: 'extract-health-event',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      durationMs: Date.now() - requestStartedAt,
    }, Date.now() - requestStartedAt);
    throw error;
  }

  if (!response.ok) {
    digitizationLogger.log('error', 'api_response_error', 'Gemini gateway trả lỗi cho OCR.', {
      requestId,
      endpoint: 'extract-health-event',
      status: response.status,
      durationMs: Date.now() - requestStartedAt,
    }, Date.now() - requestStartedAt);
    await readApiJson<never>(response, 'Server Gemini (extract-health-event)');
  }

  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    await readApiJson<unknown>(response, 'Server Gemini (extract-health-event)');
    throw new Error('Server Gemini không trả về luồng dữ liệu OCR như mong đợi.');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Không thể khởi tạo luồng dữ liệu từ server AI.');

  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: {
    extracted: Partial<HealthEvent>;
    modelUsed?: string;
    totalPages?: number;
    processedPages?: number;
    contentIndexPages: string[];
    contentIndexComplete: boolean;
  } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(line.slice(6));
        if (json.type === 'progress') {
          onProgress?.({
            stage: 'extracting_content',
            progressPercent: json.progressPercent || 50,
            message: json.message || 'AI đang xử lý...',
            modelUsed: json.modelUsed,
            totalPages: json.totalPages,
            processedPages: json.processedPages,
            partialEvent: json.extracted ? normalizeExtractedEvent(json.extracted, file.name) : undefined,
          });
        } else if (json.type === 'complete') {
          const extractedPayload = isRecord(json.extracted) ? json.extracted : {};
          finalResult = {
            extracted: normalizeExtractedEvent(extractedPayload, file.name),
            modelUsed: json.modelUsed,
            totalPages: json.totalPages,
            processedPages: json.processedPages,
            contentIndexPages: Array.isArray(extractedPayload.contentIndexPages) &&
              extractedPayload.contentIndexPages.every((page: unknown) => typeof page === 'string')
              ? extractedPayload.contentIndexPages as string[]
              : [],
            contentIndexComplete: extractedPayload.contentIndexComplete === true,
          };
        } else if (json.type === 'error') {
          throw new Error(json.error || 'Lỗi xử lý từ server AI.');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Lỗi xử lý từ server AI')) throw e;
        console.warn('[Gemini Service] Failed to parse SSE line:', line, e);
      }
    }
  }

  if (!finalResult) throw new Error('AI không trả về kết quả cuối cùng.');

  const durationMs = getDuration();
  digitizationLogger.log('info', 'ocr_complete', `OCR qua server hoàn tất trong ${durationMs}ms bằng ${finalResult.modelUsed}.`, {
    requestId,
    endpoint: 'extract-health-event',
    durationMs,
    modelUsed: finalResult.modelUsed,
    totalPages: finalResult.totalPages,
    processedPages: finalResult.processedPages,
  }, durationMs);
  digitizationLogger.log('info', 'api_request_complete', 'Gemini gateway hoàn tất OCR.', {
    requestId,
    endpoint: 'extract-health-event',
    status: response.status,
    durationMs: Date.now() - requestStartedAt,
    model: finalResult.modelUsed,
  }, Date.now() - requestStartedAt);

  onProgress?.({
    stage: 'completed',
    progressPercent: 100,
    message: 'Hoàn tất số hóa tài liệu y tế!',
    modelUsed: finalResult.modelUsed,
    partialEvent: finalResult.extracted,
    totalPages: finalResult.totalPages,
    processedPages: finalResult.processedPages,
  });

  return finalResult;
}

async function runDirectHealthDocumentOcr(
  file: File,
  member: FamilyMember,
  mimeType: string,
  base64Data: string,
  clientGeminiKeys: string[],
  requestId: string,
  onProgress?: (update: ExtractionProgressUpdate) => void,
  options?: { isAutoDetect?: boolean; signal?: AbortSignal },
): Promise<{
  extracted: Partial<HealthEvent>;
  modelUsed?: string;
  totalPages?: number;
  processedPages?: number;
  contentIndexPages: string[];
  contentIndexComplete: boolean;
}> {
  digitizationLogger.log('warn', 'api_direct_fallback', 'Chạy OCR bằng Gemini SDK trực tiếp trên APK.', {
    requestId,
    endpoint: 'extract-health-event',
    keyCount: clientGeminiKeys.length,
  });
  const requestContext = getOrCreateSharedGeminiRequestContext(clientGeminiKeys);
  const result = await runUnifiedHealthDocumentOcr({
    base64Data,
    mimeType,
    fileName: file.name,
    memberName: member.name,
    memberBirthDate: typeof member.birthDate === 'string' ? member.birthDate : undefined,
    isAutoDetect: options?.isAutoDetect,
    clientGeminiKeys,
    requestContext,
    requestId,
    signal: options?.signal,
    onPlanReady: ({ totalPages }) => onProgress?.({
      stage: 'reading_document',
      progressPercent: 45,
      message: `Đã nhận diện tài liệu ${totalPages} trang; Gemini đang xử lý trực tiếp trên thiết bị.`,
      totalPages,
    }),
    onBatchComplete: ({ completed, totalBatches, extracted, modelUsed, batch, totalPages }) => onProgress?.({
      stage: 'extracting_content',
      progressPercent: Math.min(95, 50 + Math.round((completed / totalBatches) * 45)),
      message: `Đã xử lý ${completed}/${totalBatches} phần tài liệu.`,
      modelUsed,
      partialEvent: normalizeExtractedEvent(extracted, file.name),
      totalPages,
      processedPages: Math.min(totalPages, batch.lastPage),
    }),
    onProgress: (message) => onProgress?.({
      stage: 'waiting_for_model',
      progressPercent: 50,
      message,
    }),
  });
  const extracted = normalizeExtractedEvent(result.extracted, file.name);
  const contentIndexPages = Array.isArray(result.extracted.contentIndexPages)
    ? result.extracted.contentIndexPages.filter((page): page is string => typeof page === 'string')
    : [];
  onProgress?.({
    stage: 'completed',
    progressPercent: 100,
    message: 'Hoàn tất số hóa tài liệu y tế!',
    modelUsed: result.modelUsed,
    partialEvent: extracted,
    totalPages: result.totalPages,
    processedPages: result.processedPages,
  });
  digitizationLogger.log('info', 'ocr_complete', 'OCR trực tiếp trên APK hoàn tất.', {
    requestId,
    endpoint: 'extract-health-event',
    modelUsed: result.modelUsed,
    totalPages: result.totalPages,
    processedPages: result.processedPages,
  });
  return {
    extracted,
    modelUsed: result.modelUsed,
    totalPages: result.totalPages,
    processedPages: result.processedPages,
    contentIndexPages,
    contentIndexComplete: result.extracted.contentIndexComplete === true,
  };
}

export async function extractHealthEventWithProgress(
  file: File,
  member: FamilyMember,
  onProgress?: (update: ExtractionProgressUpdate) => void,
  options?: { isAutoDetect?: boolean; signal?: AbortSignal },
): Promise<{
  extracted: Partial<HealthEvent>;
  modelUsed?: string;
  totalPages?: number;
  processedPages?: number;
  contentIndexPages: string[];
  contentIndexComplete: boolean;
}> {
  const getDuration = digitizationLogger.startTimer();
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  digitizationLogger.log(
    'info',
    'ocr_start',
    `Bắt đầu OCR qua dịch vụ Gemini cho "${file.name}" (${(file.size / 1024).toFixed(1)} KB, ${mimeType})`,
    { fileName: file.name, fileSize: file.size, mimeType, memberId: member.id, memberName: member.name, isAutoDetect: options?.isAutoDetect },
  );
  onProgress?.({ stage: 'preparing', progressPercent: 25, message: 'Đang chuẩn bị dữ liệu và mã hóa tệp...' });

  try {
    const base64Data = await fileToBase64(file);
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('OCR was cancelled.');
    }
    onProgress?.({
      stage: 'reading_document',
      progressPercent: 45,
      message: 'Gemini đang đọc tài liệu...',
      modelUsed: TASK_MODELS.digitization[0],
    });
    return await extractServerHealthEvent(file, member, mimeType, base64Data, onProgress, getDuration, options);
  } catch (error) {
    const durationMs = getDuration();
    const errorMessage = cleanErrorMessage(error instanceof Error ? error.message : String(error));
    digitizationLogger.log(
      'error',
      'ocr_error',
      `Lỗi OCR tài liệu "${file.name}": ${errorMessage}`,
      { fileName: file.name, error: errorMessage },
      durationMs,
    );
    if (error instanceof Error && error.message === errorMessage) throw error;
    throw new Error(errorMessage, { cause: error });
  }
}

export async function extractHealthEvent(
  file: File,
  member: FamilyMember,
): Promise<Partial<HealthEvent>> {
  const result = await extractHealthEventWithProgress(file, member);
  return result.extracted;
}

export async function refineAndOrganizeMemberData(
  member: FamilyMember,
  events: HealthEvent[],
): Promise<{
  organizedTimeline: HealthEvent[];
  refinementNotes: string[];
}> {
  if (events.length === 0) {
    return { organizedTimeline: [], refinementNotes: ['Chưa có sự kiện y tế nào để hiệu chỉnh.'] };
  }

  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log(
    'info',
    'refine_start',
    `Bắt đầu chuẩn hóa danh pháp y tế tự động cho ${member.name} (${events.length} sự kiện)`,
    { memberId: member.id, eventCount: events.length },
  );

  try {
    const data = await callGemini<{
      success: boolean;
      organizedTimeline: HealthEvent[];
      refinementNotes: string[];
    }>('refine-and-organize', {
      member,
      events,
    });

    const durationMs = getDuration();
    const rawTimeline = Array.isArray(data.organizedTimeline) ? data.organizedTimeline : events;
    const finalTimeline = rawTimeline.map((event) => {
      if (!event || typeof event !== 'object') return event;
      const normalizedType =
        classifyHealthEventType(
          event as Partial<HealthEvent> & Record<string, unknown>,
          event.sourceFileName,
        ) || event.type;
      return { ...event, type: normalizedType };
    });
    const notes = Array.isArray(data.refinementNotes) ? data.refinementNotes : ['Đã chuẩn hóa dữ liệu.'];
    digitizationLogger.log(
      'info',
      'refine_complete',
      `Chuẩn hóa danh pháp y tế hoàn tất trong ${durationMs}ms (${finalTimeline.length} sự kiện đã xử lý)`,
      { durationMs, organizedCount: finalTimeline.length, notesCount: notes.length },
      durationMs,
    );

    return {
      organizedTimeline: finalTimeline,
      refinementNotes: notes,
    };
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'refine_error',
      `Lỗi khi chuẩn hóa danh pháp y tế: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs,
    );
    throw error;
  }
}

export async function summarizeHealthProfile(
  member: FamilyMember,
  profile: HealthProfile,
): Promise<string> {
  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log(
    'info',
    'summary_start',
    `Bắt đầu tổng kết hồ sơ sức khỏe cho ${member.name} (${profile.timeline.length} sự kiện)`,
    { memberId: member.id, eventCount: profile.timeline.length },
  );
  try {
    const data = await callGemini<{ success: boolean; summary: string }>('summarize', {
      member,
      profile,
    });
    if (typeof data.summary !== 'string' || !data.summary.trim()) {
      throw new Error('AI chưa trả về bản tóm tắt hợp lệ. Vui lòng thử lại sau.');
    }
    const durationMs = getDuration();
    digitizationLogger.log(
      'info',
      'summary_complete',
      `Tổng kết hồ sơ sức khỏe hoàn tất trong ${durationMs}ms (${data.summary.length} ký tự)`,
      { durationMs, length: data.summary.length },
      durationMs,
    );
    return data.summary.trim();
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'summary_error',
      `Lỗi tổng kết hồ sơ cho ${member.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs,
    );
    throw error;
  }
}

export async function askHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile,
  history: HealthAssistantHistoryMessage[] = [],
): Promise<{ answer: string; citations: HealthAssistantCitation[] }> {
  const data = await callGemini<{
    success: boolean;
    answer: string;
    citations?: unknown;
  }>('ask-assistant', {
    question,
    member,
    profile,
    history,
    stream: false,
  });
  if (typeof data.answer !== 'string' || !data.answer.trim()) {
    throw new Error('Trợ lý AI chưa trả về câu trả lời hợp lệ. Vui lòng thử lại.');
  }
  return {
    answer: data.answer,
    citations: normalizeHealthAssistantCitations(data.citations),
  };
}

function normalizeHealthAssistantCitations(value: unknown): HealthAssistantCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HealthAssistantCitation[] => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') return [];
    return isApprovedMedicalCitationUrl(item.url)
      ? [{ title: item.title.slice(0, 200), url: item.url }]
      : [];
  }).slice(0, 6);
}

async function callGeminiStream(
  endpoint: string,
  body: Record<string, unknown>,
  onChunk: (chunk: string) => void,
  onSources?: (citations: HealthAssistantCitation[]) => void,
  requestId = createApiRequestId(),
): Promise<{ answer: string; citations: HealthAssistantCitation[] }> {
  const requestStartedAt = Date.now();
  digitizationLogger.log('info', 'api_request_start', 'Bắt đầu request Gemini dạng stream.', {
    requestId,
    endpoint,
  });
  const clientGeminiKeys = await getSharedGeminiKeysForRequest();
  const url = buildApiUrl(`/api/gemini/${endpoint}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Request-Id': requestId,
  };

  try {
    const token = await getFirebaseIdToken().catch(() => null);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } catch (e) {
    console.warn('[Gemini Service] Could not attach auth token for stream:', e);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true, clientGeminiKeys }),
    });
  } catch (error) {
    digitizationLogger.log('error', 'api_request_failed', 'Không kết nối được Gemini gateway cho stream.', {
      requestId,
      endpoint,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      durationMs: Date.now() - requestStartedAt,
    }, Date.now() - requestStartedAt);
    throw error;
  }

  if (!response.ok) {
    digitizationLogger.log('error', 'api_response_error', 'Gemini gateway trả lỗi cho stream.', {
      requestId,
      endpoint,
      status: response.status,
      durationMs: Date.now() - requestStartedAt,
    }, Date.now() - requestStartedAt);
    await readApiJson<never>(response, `Server Gemini (${endpoint})`);
  }

  if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    await readApiJson<unknown>(response, `Server Gemini (${endpoint})`);
    throw new Error(`Server Gemini (${endpoint}) không trả về luồng dữ liệu như mong đợi.`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Không thể khởi tạo luồng dữ liệu từ server AI.');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let citations: HealthAssistantCitation[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          onChunk(data);
          fullText += data;
          continue;
        }

        if (!isRecord(event)) continue;
        if (event.type === 'error') {
          throw new Error(typeof event.error === 'string' ? event.error : 'Lỗi xử lý từ server AI.');
        }
        if (typeof event.text === 'string') {
          onChunk(event.text);
          fullText += event.text;
        }
        if (event.type === 'sources') {
          citations = normalizeHealthAssistantCitations(event.citations);
          if (citations.length > 0) {
            onSources?.(citations);
          }
        }
      } else {
        onChunk(line);
        fullText += line;
      }
    }
  }

  digitizationLogger.log('info', 'api_request_complete', 'Gemini stream đã kết thúc.', {
    requestId,
    endpoint,
    status: response.status,
    durationMs: Date.now() - requestStartedAt,
    citationCount: citations.length,
  }, Date.now() - requestStartedAt);
  return { answer: fullText, citations };
}

export async function streamHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile,
  onChunk: (chunk: string) => void,
  history: HealthAssistantHistoryMessage[] = [],
  onSources?: (citations: HealthAssistantCitation[]) => void,
): Promise<{ answer: string; citations: HealthAssistantCitation[] }> {
  const requestId = createApiRequestId();
  try {
    return await callGeminiStream(
      'ask-assistant',
      { question, member, profile, history },
      onChunk,
      onSources,
      requestId,
    );
  } catch (error) {
    if (!isNativeApkRuntime() || !isBackendUnavailableError(error)) throw error;

    const clientGeminiKeys = await getSharedGeminiKeysForRequest();
    const requestContext = getOrCreateSharedGeminiRequestContext(clientGeminiKeys);
    digitizationLogger.log('warn', 'api_direct_fallback', 'Backend không truy cập được; chuyển chat stream sang Gemini SDK trên APK.', {
      requestId,
      endpoint: 'ask-assistant',
      keyCount: clientGeminiKeys.length,
    });
    const normalizedHistory = normalizeHealthAssistantHistory(history);
    const research = await researchHealthQuestionWithPool(question, member.name, {
      requestContext,
      requestId,
    });
    onSources?.(research.citations);
    const prompt = createHealthAssistantPrompt(
      question,
      member.name,
      profile,
      normalizedHistory,
      research,
    );
    const { text } = await executeGeminiStreamWithPool({
      task: 'assistant',
      contents: [{ text: prompt }],
      systemInstruction: HEALTH_ASSISTANT_SYSTEM_INSTRUCTION,
      clientGeminiKeys,
      requestContext,
      requestId,
    }, (chunk) => onChunk(chunk));
    return { answer: text, citations: research.citations };
  }
}

export async function analyzeComprehensiveHealth(
  member: FamilyMember,
  profile: HealthProfile,
  model: string = 'gemini-4-hydrogen',
): Promise<{ result: AiDeepAnalysisResult; aiAnalysis: AiAnalysisBlock; modelUsed?: string }> {
  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log(
    'info',
    'deep_analysis_start',
    `Bắt đầu phân tích y khoa chuyên sâu 4 lớp (${model}) cho ${member.name} (${profile.timeline.length} sự kiện)`,
    { memberId: member.id, model, eventCount: profile.timeline.length },
  );

  try {
    const data = await callGemini<{
      success: boolean;
      result: AiDeepAnalysisResult;
      aiAnalysis?: AiAnalysisBlock;
      modelUsed?: string;
    }>('analyze-comprehensive', {
      member,
      profile,
      model,
    });

    const rawResult = isRecord(data?.result) ? (data.result as Record<string, any>) : {};
    const rawRoadmap = isRecord(rawResult.roadmap) ? (rawResult.roadmap as Record<string, any>) : {};
    const rawTimePlan = isRecord(rawRoadmap.timeBoundPlan) ? (rawRoadmap.timeBoundPlan as Record<string, any>) : {};

    const result: AiDeepAnalysisResult = {
      analyzedAt: typeof rawResult.analyzedAt === 'string' ? rawResult.analyzedAt : new Date().toISOString(),
      healthScore: typeof rawResult.healthScore === 'number' && Number.isFinite(rawResult.healthScore) ? rawResult.healthScore : 80,
      overallAssessment: typeof rawResult.overallAssessment === 'string' && rawResult.overallAssessment.trim()
        ? rawResult.overallAssessment
        : `Dựa trên hồ sơ y tế của ${member.name}, hệ thống đã ghi nhận và phân tích dữ liệu sức khỏe.`,
      crossCorrelations: Array.isArray(rawResult.crossCorrelations) ? rawResult.crossCorrelations : [],
      velocityTrends: Array.isArray(rawResult.velocityTrends) ? rawResult.velocityTrends : [],
      chronicSurveillance: Array.isArray(rawResult.chronicSurveillance) ? rawResult.chronicSurveillance : [],
      roadmap: {
        criticalAlerts: Array.isArray(rawRoadmap.criticalAlerts) ? rawRoadmap.criticalAlerts : [],
        specialistReferrals: Array.isArray(rawRoadmap.specialistReferrals) ? rawRoadmap.specialistReferrals : [],
        timeBoundPlan: {
          next3Months: Array.isArray(rawTimePlan.next3Months) ? rawTimePlan.next3Months : [],
          next6Months: Array.isArray(rawTimePlan.next6Months) ? rawTimePlan.next6Months : [],
          next12Months: Array.isArray(rawTimePlan.next12Months) ? rawTimePlan.next12Months : [],
        },
      },
    };

    const aiAnalysisFallback: AiAnalysisBlock = {
      lastAnalyzedDate: new Date().toISOString().slice(0, 10),
      overviewSummary: result.overallAssessment,
      criticalAlerts: result.roadmap.criticalAlerts,
      chronicConditionsTracking: result.chronicSurveillance.map(
        (c) => `${c.conditionName}: ${c.comparisonOverTime || c.recommendation}`,
      ),
      actionRoadmap: {
        specialistConsultation: result.roadmap.specialistReferrals.map((s) => s.specialty),
        dietaryModifications: result.roadmap.timeBoundPlan.next3Months.filter((i) =>
          /chế độ ăn|kiêng|purin|rượu|nước|dinh dưỡng/i.test(i),
        ),
        followUpSchedule: result.roadmap.timeBoundPlan.next3Months.find((i) =>
          /tái khám|kiểm tra lại|xét nghiệm/i.test(i),
        ) || 'Tái khám kiểm tra lại sau 3 tháng.',
      },
    };

    const durationMs = getDuration();
    const finalModel = data.modelUsed || model;
    digitizationLogger.log(
      'info',
      'deep_analysis_complete',
      `Phân tích y khoa 4 lớp hoàn tất trong ${durationMs}ms bằng ${finalModel}. Cảnh báo: ${result.roadmap.criticalAlerts.length}, Chuyên khoa: ${result.roadmap.specialistReferrals.length}, Xu hướng: ${result.velocityTrends.length}`,
      {
        durationMs,
        modelUsed: finalModel,
        criticalAlertsCount: result.roadmap.criticalAlerts.length,
        specialistCount: result.roadmap.specialistReferrals.length,
        velocityTrendsCount: result.velocityTrends.length,
      },
      durationMs,
    );

    return {
      result,
      aiAnalysis: data.aiAnalysis || aiAnalysisFallback,
      modelUsed: finalModel,
    };
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'deep_analysis_error',
      `Lỗi phân tích chuyên sâu cho ${member.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs,
    );
    throw error;
  }
}

async function fileToBase64(file: File): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('Không thể đọc dữ liệu tệp.'));
          return;
        }
        const base64 = reader.result.split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Lỗi khi đọc tệp dữ liệu.'));
      reader.readAsDataURL(file);
    });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeExtractedEvent(value: Record<string, unknown>, fileName?: string): Partial<HealthEvent> {
  const medications: Medication[] = Array.isArray(value.medications)
    ? value.medications.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        return [
          {
            name: item.name.trim(),
            dosage: optionalString(item.dosage),
            quantity: optionalString(item.quantity),
            frequency: optionalString(item.frequency),
            timing: optionalString(item.timing),
            duration: optionalString(item.duration),
            instructions: optionalString(item.instructions),
          },
        ];
      })
    : [];

  const metrics: HealthMetric[] = Array.isArray(value.metrics)
    ? value.metrics.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        const numericValue = typeof item.value === 'number' ? item.value : Number(item.value);
        if (!Number.isFinite(numericValue)) return [];
        return [
          {
            name: item.name.trim(),
            standardKey: optionalString(item.standardKey),
            value: numericValue,
            unit: optionalString(item.unit) || '',
            refRange: optionalString(item.refRange),
            status: optionalString(item.status),
          },
        ];
      })
    : [];

  const imagingResults: ImagingResult[] = Array.isArray(value.imagingResults)
    ? value.imagingResults.flatMap((item) => {
        if (!isRecord(item)) return [];
        const modality = optionalString(item.modality) || '';
        const findings = optionalString(item.findings) || '';
        const conclusion = optionalString(item.conclusion) || '';
        if (!modality && !findings && !conclusion) return [];
        return [{ modality, findings, conclusion }];
      })
    : [];

  const vaccinations: VaccinationRecord[] = Array.isArray(value.vaccinations)
    ? value.vaccinations.flatMap((item) => {
        if (!isRecord(item) || typeof item.vaccineName !== 'string' || !item.vaccineName.trim()) return [];
        return [{
          vaccineName: item.vaccineName.trim(),
          targetDisease: optionalString(item.targetDisease),
          doseNumber: typeof item.doseNumber === 'string' || typeof item.doseNumber === 'number'
            ? item.doseNumber
            : undefined,
          lotNumber: optionalString(item.lotNumber),
          manufacturer: optionalString(item.manufacturer),
          injectionSite: optionalString(item.injectionSite),
          administeredDate: optionalString(item.administeredDate) || '',
          nextDoseDate: optionalString(item.nextDoseDate) || null,
          reactionNotes: optionalString(item.reactionNotes),
        }];
      })
    : [];
  const hospitalization: HospitalizationRecord | undefined = cleanHospitalizationRecord(value.hospitalization);
  const rawPhysicalExam = isRecord(value.physicalExam)
    ? {
        height_cm: typeof value.physicalExam.height_cm === 'number' ? value.physicalExam.height_cm : undefined,
        weight_kg: typeof value.physicalExam.weight_kg === 'number' ? value.physicalExam.weight_kg : undefined,
        bmi: typeof value.physicalExam.bmi === 'number' ? value.physicalExam.bmi : undefined,
        bp_mmHg: optionalString(value.physicalExam.bp_mmHg),
        pulse_bpm: typeof value.physicalExam.pulse_bpm === 'number' ? value.physicalExam.pulse_bpm : undefined,
        classification: optionalString(value.physicalExam.classification),
      }
    : undefined;
  const physicalExam =
    rawPhysicalExam && Object.values(rawPhysicalExam).some((item) => item !== undefined)
      ? rawPhysicalExam
      : undefined;

  return {
    title: optionalString(value.title),
    date: isIsoDate(value.date) ? value.date : undefined,
    type: classifyHealthEventType(value as Partial<HealthEvent> & Record<string, unknown>, fileName),
    facility: optionalString(value.facility),
    doctorName: optionalString(value.doctorName),
    customCategory: optionalString(value.customCategory),
    physicalExam,
    diagnoses: Array.isArray(value.diagnoses)
      ? value.diagnoses
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : [],
    medications,
    metrics,
    imagingResults,
    vaccinations,
    hospitalization,
    advice: optionalString(value.advice),
    nextFollowUp: isIsoDate(value.nextFollowUp) ? value.nextFollowUp : undefined,
    notes: optionalString(value.notes),
    patientName: optionalString(value.patientName),
    patientBirthDate: optionalString(value.patientBirthDate),
    patientGender: optionalString(value.patientGender),
    extractedData:
      isRecord(value.extractedData) && isJsonRecord(value.extractedData)
        ? (value.extractedData as Record<string, JsonValue>)
        : undefined,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJsonRecord(value: Record<string, unknown>): boolean {
  const isJson = (item: unknown): item is JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(isJson);
    if (isRecord(item)) return Object.values(item).every(isJson);
    return false;
  };
  return Object.values(value).every(isJson);
}
