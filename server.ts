import express, { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import firebaseConfig from './firebase-applet-config.json';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
const GEMINI_RATE_LIMIT_PER_MINUTE = 100;
const rateLimitWindows = new Map<string, { startedAt: number; count: number }>();
const GEMINI_ANALYSIS_ATTEMPT_TIMEOUT_MS = 18_000;
const GEMINI_DIGITIZATION_ATTEMPT_TIMEOUT_MS = 45_000;
const GEMINI_ANALYSIS_TIMEOUT_MS = 110_000;
const GEMINI_OCR_TIMEOUT_MS = 600_000;
const OCR_BATCH_PAGES = 1;
const OCR_BATCH_CONCURRENCY = 18;
let quotaScheduler: GeminiQuotaScheduler | null = null;

// Quotas are tracked independently for each configured project and model.
const TASK_MODELS = {
  digitization: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  analysis: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash'],
};

function getConfiguredProjects(): GeminiProject[] {
  return parseGeminiProjects(
    parseGeminiApiKeys(process.env.GEMINI_API_KEYS),
    parseGeminiApiKeys(process.env.GEMINI_API_KEY)[0],
  );
}

function getQuotaScheduler(): GeminiQuotaScheduler {
  if (!quotaScheduler) throw new Error('Gemini quota scheduler has not been initialized.');
  return quotaScheduler;
}

function getTaskQuota(task: GeminiTask): GeminiQuota {
  return task === 'digitization'
    ? { rpm: 15, rpd: 500, maxConcurrent: 3 }
    : { rpm: 5, rpd: 20, maxConcurrent: 2 };
}

function describeGeminiError(error: unknown): { status?: number; message: string } {
  const candidate = error && typeof error === 'object' ? error as { status?: unknown; message?: unknown; error?: { status?: unknown; message?: unknown } } : {};
  const statusValue = candidate.status ?? candidate.error?.status;
  const message = typeof candidate.message === 'string'
    ? candidate.message
    : typeof candidate.error?.message === 'string'
    ? candidate.error.message
    : String(error);
  return { status: typeof statusValue === 'number' ? statusValue : undefined, message };
}

function parseRetryAfterMs(error: unknown): number {
  const { message } = describeGeminiError(error);
  const seconds = message.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)\s*s/i);
  return seconds ? Math.min(60_000, Math.max(1_000, Number(seconds[1]) * 1_000)) : 60_000;
}

function isDailyQuotaError(error: unknown): boolean {
  const { message } = describeGeminiError(error);
  return /per.?day|daily|requests per day|quota.*day/i.test(message);
}

function recordProjectFailure(
  scheduler: GeminiQuotaScheduler,
  projectId: string,
  model: string,
  error: unknown,
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
    scheduler.markProjectUnavailable(projectId);
    return true;
  }
  if (status === 404 || /model.{0,40}(not found|unsupported|not available)/i.test(message)) {
    scheduler.markModelUnavailable(projectId, model);
    return true;
  }
  return status !== 400;
}

async function verifyFirebaseIdToken(idToken: string): Promise<string | null> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status === 400 || response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Firebase token verification returned ${response.status}.`);
  const result = await response.json() as {
    users?: Array<{ localId?: string; disabled?: boolean }>;
  };
  const user = result.users?.[0];
  return user?.localId && !user.disabled ? user.localId : null;
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
  const cleaned = cleanJsonOutput(text);
  try {
    return cleanExtractedJson(JSON.parse(cleaned));
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return cleanExtractedJson(JSON.parse(match[0]));
    }
    throw new Error('Không thể phân tích dữ liệu trả về từ mô hình AI.');
  }
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
}

async function callGeminiModel(
  apiKey: string,
  model: string,
  options: ExecuteOptions,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  const attemptController = new AbortController();
  const cancelAttempt = () => attemptController.abort(new Error('Client disconnected.'));
  signal?.addEventListener('abort', cancelAttempt, { once: true });
  const attemptTimeout = setTimeout(
    () => attemptController.abort(new Error('Gemini attempt timed out.')),
    Math.min(getAttemptTimeout(options.task), Math.max(1_000, deadline - Date.now())),
  );
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: Math.min(getAttemptTimeout(options.task), Math.max(1_000, deadline - Date.now())),
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
    const config: Record<string, unknown> = { abortSignal: attemptController.signal };
    if (options.systemInstruction) config.systemInstruction = options.systemInstruction;
    if (options.responseMimeType) config.responseMimeType = options.responseMimeType;
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
  } finally {
    clearTimeout(attemptTimeout);
    signal?.removeEventListener('abort', cancelAttempt);
  }
}

async function executeGeminiWithFailover(options: ExecuteOptions): Promise<{ text: string; modelUsed: string }> {
  const scheduler = getQuotaScheduler();
  const projects = scheduler.getProjects();
  if (projects.length === 0) {
    throw new Error('Chưa cấu hình GEMINI_PROJECTS hoặc GEMINI_API_KEYS trên máy chủ.');
  }

  const models = TASK_MODELS[options.task];
  const primaryModel = models[0]; // 'gemini-3.5-flash-lite'
  const failoverModels = models.slice(1); // ['gemini-3.1-flash-lite']
  const deadline = Date.now() + (options.timeoutMs || GEMINI_ANALYSIS_TIMEOUT_MS);
  const quota = getTaskQuota(options.task);
  let lastError: Error | null = null;

  const attemptedProjectIds = new Set<string>();

  // Xoay vòng qua 6 keys độc lập chạy song song
  while (attemptedProjectIds.size < projects.length && Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error('Gemini request was cancelled.');

    // 1. Luôn ưu tiên acquire key cho model chính: gemini-3.5-flash-lite
    let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>> | null = null;
    let targetModel = primaryModel;

    try {
      lease = await scheduler.acquire(
        options.task,
        primaryModel,
        quota,
        attemptedProjectIds,
        2_500, // Thử nhanh xem key nào đang rảnh model 3.5 flash lite
      );
    } catch {
      // Nếu tất cả các keys còn lại đều bận/hết quota 3.5 flash lite, mở đường sang failover model (3.1 flash lite)
      for (const failover of failoverModels) {
        try {
          lease = await scheduler.acquire(
            options.task,
            failover,
            quota,
            attemptedProjectIds,
            2_000,
          );
          targetModel = failover;
          break;
        } catch {
          // tiếp tục tìm key
        }
      }
    }

    // Nếu vẫn chưa có slot, chờ tối đa với deadline cho primaryModel
    if (!lease) {
      try {
        lease = await scheduler.acquire(
          options.task,
          primaryModel,
          quota,
          attemptedProjectIds,
          Math.min(5_000, deadline - Date.now()),
        );
        targetModel = primaryModel;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        break;
      }
    }

    const { project } = lease;
    attemptedProjectIds.add(project.id);

    try {
      options.onProgress?.(`Đang xử lý bằng ${targetModel} (Key: ${project.id})`);
      const text = await callGeminiModel(project.apiKey, targetModel, options, deadline, options.signal);
      return { text, modelUsed: targetModel };
    } catch (error) {
      const details = describeGeminiError(error);
      lastError = error instanceof Error ? error : new Error(String(error));
      const shouldRetry = recordProjectFailure(scheduler, project.id, targetModel, error);
      console.warn(
        `[Gemini ${options.task}] ${targetModel} failed for Key ${project.id} (${details.status || 'network'}): ${details.message}`,
      );

      // FAILOVER NGAY TRÊN CHÍNH KEY ĐÓ: Nếu key này lỗi với 3.5 flash lite, lập tức failover sang 3.1 flash lite
      if (targetModel === primaryModel && failoverModels.length > 0 && Date.now() < deadline) {
        for (const failover of failoverModels) {
          try {
            options.onProgress?.(`Key ${project.id} gặp lỗi với ${primaryModel}. Đang failover tức thì sang ${failover}...`);
            const fallbackText = await callGeminiModel(project.apiKey, failover, options, deadline, options.signal);
            console.info(`[Gemini ${options.task}] Failover to ${failover} on Key ${project.id} THÀNH CÔNG!`);
            return { text: fallbackText, modelUsed: failover };
          } catch (failoverErr) {
            recordProjectFailure(scheduler, project.id, failover, failoverErr);
            console.warn(
              `[Gemini ${options.task}] Failover ${failover} cũng thất bại trên Key ${project.id}:`,
              describeGeminiError(failoverErr).message,
            );
          }
        }
      }

      if (!shouldRetry) throw lastError;
    } finally {
      lease.release();
    }
  }

  throw lastError || new Error('Đã hết quota hoặc thời gian chờ cho các model Gemini đã cấu hình.');
}

async function startServer() {
  quotaScheduler = new GeminiQuotaScheduler(getConfiguredProjects());
  const app = express();

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
      },
      architecture: 'server-side-secure',
    });
  });

  app.use('/api/gemini', async (req: Request, res: Response, next) => {
    const authorization = req.header('Authorization') || '';
    const match = authorization.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Đăng nhập để sử dụng dịch vụ Gemini.' });
      return;
    }

    try {
      const uid = await verifyFirebaseIdToken(match[1]);
      if (!uid) {
        res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
        return;
      }
      if (!isWithinRateLimit(uid)) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({ error: 'Bạn đã dùng hết lượt yêu cầu tạm thời. Hãy thử lại sau một phút.' });
        return;
      }
      res.locals.firebaseUid = uid;
      next();
    } catch (error) {
      console.error('[Gemini Auth] Token verification service unavailable.', error);
      res.status(503).json({ error: 'Chưa thể xác minh phiên đăng nhập. Vui lòng thử lại.' });
    }
  });

  app.use(express.json({ limit: '36mb' }));

  // 1. Trích xuất tài liệu (OCR PDF / ảnh chụp khám bệnh)
  app.post('/api/gemini/extract-health-event', async (req: Request, res: Response) => {
    let extractionTimeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let modelAbortController: AbortController | undefined;
    try {
      const { base64Data, mimeType, member } = req.body;
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

      const systemInstruction = `Bạn là trợ lý y tế chuyên số hóa, OCR nhận dạng tài liệu y khoa Việt Nam (đơn thuốc, kết quả xét nghiệm, phiếu khám bệnh, siêu âm, X-quang, giấy ra viện, sổ tiêm chủng).
Nhiệm vụ: Trích xuất và chuẩn hóa thông tin từ tài liệu đính kèm. Đồng thời phát hiện Họ và tên người bệnh, Ngày sinh/Năm sinh và Giới tính trên tài liệu để hệ thống đối chiếu ghép với thành viên gia đình (${memberName} ${memberBirth}).
QUY TẮC CHUẨN HÓA & KHỬ TRÙNG LẶP:
- Chuẩn hóa mảng "metrics" với "standardKey" (VD: WBC, RBC, HGB, HbA1c, GLUCOSE, CREATININ, EGFR, ACID_URIC, CHOLESTEROL, TRIGLYCERID, AST, ALT, BLOOD_PRESSURE_SYS, BLOOD_PRESSURE_DIA, SPO2, WEIGHT, HEIGHT) và "status" ("normal" | "optimal" | "warning_high" | "warning_low" | "critical_high" | "critical_low").
- Trích xuất mảng "imagingResults" cho các kết quả chẩn đoán hình ảnh, siêu âm, X-quang, MRI.
- Khử trùng lặp tuyệt đối các chẩn đoán, tên thuốc, chỉ số đo và hình ảnh.

Hãy trả về DUY NHẤT một JSON object tuân thủ đúng cấu trúc:
{
  "title": "Tên ngắn gọn của sự kiện y tế (VD: Khám tổng quát & Xét nghiệm, Đơn thuốc tai mũi họng)",
  "date": "YYYY-MM-DD (ngày khám trên tài liệu)",
  "type": "medical_report" | "prescription" | "test_result" | "vaccination" | "discharge" | "comprehensive_exam" | "other",
  "patientName": "Họ và tên bệnh nhân ghi trên tài liệu (nếu có)",
  "patientBirthDate": "YYYY-MM-DD hoặc YYYY (ngày sinh/năm sinh nếu có)",
  "patientGender": "Nam" | "Nữ" | "Khác",
  "facility": "Tên bệnh viện hoặc phòng khám",
  "diagnoses": ["Chẩn đoán 1", "Chẩn đoán 2"],
  "medications": [
    { "name": "Tên thuốc", "dosage": "Liều dùng", "frequency": "Số lần/ngày", "duration": "Thời gian uống" }
  ],
  "metrics": [
    { "name": "Tên chỉ số", "standardKey": "WBC | GLUCOSE | ACID_URIC | CREATININ ...", "value": 120, "unit": "mmol/L", "status": "normal | critical_high" }
  ],
  "imagingResults": [
    { "modality": "Siêu âm ổ bụng | Siêu âm tuyến giáp ...", "findings": "Mô tả hình ảnh", "conclusion": "Kết luận chẩn đoán" }
  ],
  "advice": "Lời dặn của bác sĩ hoặc hướng dẫn điều trị",
  "nextFollowUp": "YYYY-MM-DD nếu có hẹn tái khám",
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
        const results: Array<{
          firstPage: number;
          lastPage: number;
          extracted: Record<string, unknown>;
          modelUsed: string;
        } | undefined> = new Array(pageBatches.length);
        let nextBatchIndex = 0;
        let nextBatchToEmitIndex = 0;
        let completedBatches = 0;
        const workers = Array.from(
          { length: Math.min(OCR_BATCH_CONCURRENCY, pageBatches.length) },
          async () => {
            while (nextBatchIndex < pageBatches.length) {
              if (signal?.aborted) throw new Error('OCR was cancelled.');
              const batchIndex = nextBatchIndex++;
              const batch = pageBatches[batchIndex];
              try {
                const { text, modelUsed } = await executeGeminiWithFailover({
                  task: 'digitization',
                  contents: [
                    { inlineData: { mimeType: effectiveMime, data: batch.base64Data } },
                    {
                      text: `Đọc các trang ${batch.firstPage}-${batch.lastPage} trong phần tài liệu này của hồ sơ ${memberName}. Trích xuất đúng nội dung có trên các trang này, không suy đoán, không tự thêm dữ liệu từ trang khác. Nếu phần này không có trường nào thì trả JSON với các mảng rỗng. Trả về JSON chuẩn.`,
                    },
                  ],
                  systemInstruction,
                  responseMimeType: 'application/json',
                  timeoutMs: 90_000,
                  signal,
                  onProgress: onModelProgress,
                });
                results[batchIndex] = {
                  firstPage: batch.firstPage,
                  lastPage: batch.lastPage,
                  extracted: parseJsonSafely(text),
                  modelUsed,
                };
                
                // Emít tiến độ tuần tự theo thứ tự trang tăng dần để giao diện hiển thị mượt mà
                while (nextBatchToEmitIndex < pageBatches.length && results[nextBatchToEmitIndex] !== undefined) {
                  const currentEmittedIndex = nextBatchToEmitIndex++;
                  completedBatches++;
                  const completedBatch = pageBatches[currentEmittedIndex];
                  const availableResults = results.slice(0, currentEmittedIndex + 1).filter(
                    (r): r is NonNullable<typeof r> => Boolean(r),
                  );
                  onBatchComplete?.(
                    completedBatches,
                    mergeExtractedBatches(availableResults),
                    Array.from(new Set(availableResults.map((r) => r.modelUsed))).join(', '),
                    completedBatch,
                  );
                }
              } catch (error) {
                if (!signal?.aborted) modelAbortController?.abort(error);
                throw error;
              }
            }
          },
        );
        await Promise.all(workers);
        const completeResults = results.filter(
          (result): result is NonNullable<typeof result> => Boolean(result),
        );
        return {
          extracted: mergeExtractedBatches(completeResults),
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
          message: effectiveMime === 'application/pdf'
            ? `Đã chia PDF ${pageBatches.length} trang, khởi chạy 6 key xoay tua song song (3.5 Flash Lite / 3.1 Backup).`
            : 'Đã nhận tài liệu. Đang xếp lượt theo quota Gemini còn khả dụng.',
          totalPages: pageBatches.length,
        });
        heartbeat = setInterval(() => {
          writeSse(res, {
            type: 'progress',
            message: 'Các trang tài liệu vẫn đang được xử lý song song; tiến độ được cập nhật mượt mà theo thứ tự trang.',
          });
        }, 15_000);
        res.on('close', () => {
          if (!res.writableEnded) modelAbortController?.abort(new Error('Client disconnected.'));
          if (heartbeat) clearInterval(heartbeat);
        });
        extractionTimeout = setTimeout(
          () => modelAbortController?.abort(new Error('Tài liệu vượt quá thời gian OCR tối đa 5 phút.')),
          GEMINI_OCR_TIMEOUT_MS,
        );

        const result = await extractDocument(
          (completed, extracted, modelUsed, batch) => {
            writeSse(res, {
              type: 'progress',
              progressPercent: Math.min(92, 48 + Math.floor((completed / pageBatches.length) * 42)),
              message: pageBatches.length > 1
                ? `Đang bóc tách AI... Hoàn tất trang ${batch.firstPage}/${pageBatches.length} (${completed}/${pageBatches.length} trang)`
                : `Đã số hóa thành công dữ liệu tài liệu y tế.`,
              currentPage: batch.firstPage,
              totalPages: pageBatches.length,
              extracted,
              modelUsed,
            });
          },
          (message) => writeSse(res, { type: 'progress', message }),
          modelAbortController.signal,
        );
        writeSse(res, {
          type: 'complete',
          extracted: result.extracted,
          modelUsed: result.modelUsed,
        });
        if (heartbeat) clearInterval(heartbeat);
        if (extractionTimeout) clearTimeout(extractionTimeout);
        res.end();
        return;
      }

      const result = await extractDocument();
      res.json({ success: true, ...result });
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (extractionTimeout) clearTimeout(extractionTimeout);
      console.error('[Gemini Server Extract Error]:', error);
      const message = error instanceof Error ? error.message : 'Lỗi khi số hóa tài liệu y tế qua server Gemini API.';
      if (res.headersSent) {
        writeSse(res, { type: 'error', error: message });
        res.end();
      } else {
        res.status(500).json({ error: message });
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
        task: 'analysis',
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
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
      console.error('[Gemini Server Refine Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi chuẩn hóa dữ liệu.',
      });
    }
  });

  // 3. Tóm tắt hồ sơ sức khỏe (Tier 3.8 flash)
  app.post('/api/gemini/summarize', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';
      const eventsCount = profile?.timeline?.length || 0;

      const prompt = `Bạn là bác sĩ gia đình và chuyên gia y tế cao cấp.
Hãy đưa ra bản ĐÁNH GIÁ TOÀN DIỆN tình hình sức khỏe cho thành viên ${memberName}.
Thông tin hồ sơ:
- Tổng số sự kiện khám/điều trị đã ghi nhận: ${eventsCount}
- Các chẩn đoán gần đây: ${(profile?.summary?.latestDiagnoses || []).join(', ') || 'Chưa ghi nhận'}
- Các chỉ số sức khỏe gần nhất: ${JSON.stringify(profile?.summary?.latestMetrics || {})}
- Lịch sử diễn tiến bệnh án chi tiết:
${JSON.stringify((profile?.timeline || []).slice(-10), null, 2)}

Yêu cầu phân tích chi tiết:
1. Đánh giá tổng quan hiện trạng sức khỏe, tiến triển các bệnh lý mãn tính/cấp tính.
2. Phân tích xu hướng các chỉ số sinh tồn và xét nghiệm quan trọng (huyết áp, đường huyết, v.v.).
3. Đánh giá phác đồ thuốc hiện tại và lưu ý an toàn/tương tác thuốc.
4. Lời khuyên cụ thể, khoa học về chế độ dinh dưỡng, vận động và lịch tái khám định kỳ.
Trình bày bằng tiếng Việt rõ ràng, ân cần, chia theo các mục tiêu đề chuyên nghiệp.`;

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        contents: [{ text: prompt }],
      });

      res.json({ success: true, summary: text, modelUsed });
    } catch (error) {
      console.error('[Gemini Server Summary Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi tổng kết hồ sơ y tế.',
      });
    }
  });

  // 4. Phân tích chuyên sâu 4 lớp y khoa & Động học y sinh (AI Deep-Dive Engine)
  app.post('/api/gemini/analyze-comprehensive', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';

      const prompt = `Bạn là Hội đồng Chuyên gia Y khoa Gia đình & Động học Y sinh Cao cấp.
Hãy thực hiện Thuật toán Phân tích Y khoa 4 Lớp chuyên sâu cho thành viên ${memberName}:

DỮ LIỆU ĐẦU VÀO:
- Họ tên, năm sinh, giới tính: ${memberName} (${member?.gender || 'N/A'}, sinh ${member?.birthDate || 'N/A'})
- Tiền sử bệnh lý nền & Phẫu thuật: ${JSON.stringify(profile?.medicalHistory || { surgeries: [], chronicConditions: [] }, null, 2)}
- Chuỗi ma trận lịch sử khám & xét nghiệm (Timeline Matrix):
${JSON.stringify((profile?.timeline || []).slice(-15), null, 2)}

BẮT BUỘC THỰC HIỆN 4 LỚP PHÂN TÍCH Y KHOA:

LỚP 1: Phân tích Tương quan Chỉ số (Cross-Parameter Correlation)
- Bắt buộc đối chiếu chéo các nhóm chỉ số có quan hệ nhân quả y học (VD: Acid Uric cao + Đạm niệu trong nước tiểu => nguy cơ tổn thương lọc thận; Glucose/HbA1c + Triglycerid/LDL-C + Huyết áp => Hội chứng chuyển hóa & xơ vữa; Men gan AST/ALT/GGT + BMI => Tổn thương tế bào gan do nhiễm mỡ).

LỚP 2: Đánh giá Vận tốc Biến động Lịch sử (Velocity & Trend Tracking)
- So sánh sự thay đổi các chỉ số cốt lõi qua các mốc thời gian (2024 -> 2025 -> 2026...).
- Tính toán biên độ dao động và xu hướng tăng/giảm (%) để cảnh báo nguy cơ trước khi chỉ số vượt ngưỡng bệnh lý lâm sàng.

LỚP 3: Giám sát Tiến triển Bệnh lý Mạn tính (Chronic Disease Surveillance)
- Theo dõi sát sao các bệnh lý đã ghi nhận trong tiền sử (như cấu trúc thùy tuyến giáp sau phẫu thuật, phân độ TI-RADS 1/2/3, kích thước polyp túi mật, mảng xơ vữa...).
- Ghi nhận sự ổn định lành tính qua các năm để người bệnh an tâm, đồng thời duy trì lịch nhắc kiểm tra định kỳ.

LỚP 4: Lập Phác đồ Hành động Cá nhân hóa (Actionable Health Roadmap)
- Tầng 1: Cảnh báo đỏ cấp thiết (criticalAlerts).
- Tầng 2: Khuyến nghị chuyên khoa (chỉ định rõ khám Nội tiết, Nội thận - Xương khớp, Nội tim mạch...).
- Tầng 3: Lộ trình mốc thời gian (3 tháng, 6 tháng, 12 tháng về dinh dưỡng, lối sống và lịch tái khám).

Trả về DUY NHẤT một JSON chuẩn:
{
  "analyzedAt": "${new Date().toISOString()}",
  "healthScore": 85,
  "overallAssessment": "Đánh giá tổng quan sức khỏe...",
  "crossCorrelations": [
    {
      "parameters": ["Acid Uric", "Đạm niệu"],
      "findings": "Acid Uric tăng kết hợp đạm niệu dương tính cảnh báo nguy cơ ảnh hưởng chức năng lọc của thận.",
      "severity": "critical"
    }
  ],
  "velocityTrends": [
    {
      "metricName": "Acid Uric",
      "trendDirection": "increasing",
      "velocityDescription": "Tăng 18% từ năm 2024 (380) đến 2026 (450 µmol/L)",
      "riskProjection": "Dự báo nguy cơ tiến triển gút và tổn thương cầu thận trước khi vượt ngưỡng."
    }
  ],
  "chronicSurveillance": [
    {
      "conditionName": "Phình giáp hạt TI-RADS 1 / Polyp túi mật",
      "status": "stable_benign",
      "comparisonOverTime": "Kích thước 3mm duy trì ổn định qua 3 năm (2024-2026), hình ảnh lành tính.",
      "recommendation": "Tiếp tục siêu âm định kỳ mỗi 12 tháng, không cần lo lắng."
    }
  ],
  "roadmap": {
    "criticalAlerts": ["Cảnh báo đỏ 1"],
    "specialistReferrals": [
      { "specialty": "Nội thận - Xương khớp", "reason": "Tầm soát ảnh hưởng Acid Uric lên thận" }
    ],
    "timeBoundPlan": {
      "next3Months": ["Điều chỉnh chế độ ăn giảm đạm purin..."],
      "next6Months": ["Xét nghiệm lại Acid Uric & Creatinin..."],
      "next12Months": ["Siêu âm kiểm tra tuyến giáp & túi mật định kỳ..."]
    }
  }
}`;

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
      });

      const parsed = parseJsonSafely(text) as Record<string, unknown>;
      const healthScore = typeof parsed.healthScore === 'number' && Number.isFinite(parsed.healthScore)
        ? Math.min(100, Math.max(0, parsed.healthScore))
        : 85;
      const overallAssessment = typeof parsed.overallAssessment === 'string' && parsed.overallAssessment.trim()
        ? parsed.overallAssessment.trim()
        : 'Đã tổng hợp ma trận hồ sơ sức khỏe và hoàn tất phân tích y khoa 4 lớp.';

      const crossCorrelations = Array.isArray(parsed.crossCorrelations)
        ? (parsed.crossCorrelations as any[]).map((item) => ({
            parameters: Array.isArray(item.parameters) ? item.parameters.map(String) : [],
            findings: String(item.findings || ''),
            severity: (item.severity === 'critical' || item.severity === 'warning' ? item.severity : 'info') as 'critical' | 'warning' | 'info',
          }))
        : [];

      const velocityTrends = Array.isArray(parsed.velocityTrends)
        ? (parsed.velocityTrends as any[]).map((item) => ({
            metricName: String(item.metricName || ''),
            trendDirection: (['increasing', 'decreasing', 'stable', 'fluctuating'].includes(item.trendDirection) ? item.trendDirection : 'stable') as any,
            velocityDescription: String(item.velocityDescription || ''),
            riskProjection: String(item.riskProjection || ''),
          }))
        : [];

      const chronicSurveillance = Array.isArray(parsed.chronicSurveillance)
        ? (parsed.chronicSurveillance as any[]).map((item) => ({
            conditionName: String(item.conditionName || ''),
            status: (['stable_benign', 'monitored', 'progressing', 'resolved'].includes(item.status) ? item.status : 'monitored') as any,
            comparisonOverTime: String(item.comparisonOverTime || ''),
            recommendation: String(item.recommendation || ''),
          }))
        : [];

      const roadmapRaw = (parsed.roadmap && typeof parsed.roadmap === 'object' ? parsed.roadmap : {}) as any;
      const roadmap = {
        criticalAlerts: Array.isArray(roadmapRaw.criticalAlerts) ? roadmapRaw.criticalAlerts.map(String) : [],
        specialistReferrals: Array.isArray(roadmapRaw.specialistReferrals)
          ? roadmapRaw.specialistReferrals.map((item: any) => ({
              specialty: String(item.specialty || 'Nội khoa tổng quát'),
              reason: String(item.reason || ''),
            }))
          : [],
        timeBoundPlan: {
          next3Months: Array.isArray(roadmapRaw.timeBoundPlan?.next3Months) ? roadmapRaw.timeBoundPlan.next3Months.map(String) : [],
          next6Months: Array.isArray(roadmapRaw.timeBoundPlan?.next6Months) ? roadmapRaw.timeBoundPlan.next6Months.map(String) : [],
          next12Months: Array.isArray(roadmapRaw.timeBoundPlan?.next12Months) ? roadmapRaw.timeBoundPlan.next12Months.map(String) : [],
        },
      };

      const todayStr = new Date().toISOString().slice(0, 10);
      const specialistConsultationList = Array.from(new Set([
        ...roadmap.specialistReferrals.map((s) => s.specialty).filter(Boolean),
      ]));
      const dietaryModificationsList = roadmap.timeBoundPlan.next3Months.filter((item) =>
        /chế độ ăn|kiêng|purin|rượu|nước|dinh dưỡng/i.test(item),
      );
      const followUpScheduleStr =
        roadmap.timeBoundPlan.next3Months.find((item) => /tái khám|kiểm tra lại|xét nghiệm lại/i.test(item)) ||
        'Tái khám kiểm tra lại chỉ số bất thường sau 3 tháng.';

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
          specialistConsultation:
            specialistConsultationList.length > 0 ? specialistConsultationList : ['Nội khoa tổng quát'],
          dietaryModifications:
            dietaryModificationsList.length > 0
              ? dietaryModificationsList
              : [
                  'Kiêng tuyệt đối thực phẩm giàu purin (thịt đỏ, hải sản, nội tạng).',
                  'Tuyệt đối không sử dụng rượu bia.',
                  'Uống nhiều nước (trên 2.5 - 3 lít/ngày).',
                ],
          followUpSchedule: followUpScheduleStr,
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
      console.error('[Gemini Server Analyze Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi phân tích chuyên sâu 4 lớp y khoa.',
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
        const projects = scheduler.getProjects();
        if (projects.length === 0) throw new Error('Chưa cấu hình GEMINI_PROJECTS hoặc GEMINI_API_KEYS.');
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
          for (const model of TASK_MODELS.analysis) {
            const attemptedProjectIds = new Set<string>();
            while (attemptedProjectIds.size < projects.length && !controller.signal.aborted) {
              let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
              try {
                lease = await scheduler.acquire(
                  'analysis',
                  model,
                  getTaskQuota('analysis'),
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
                const shouldRetry = recordProjectFailure(scheduler, lease.project.id, model, error);
                if (hasOutput || controller.signal.aborted) throw lastError;
                console.warn(
                  `[Gemini assistant] ${model} failed for configured project ${lease.project.id} (${details.status || 'network'}): ${details.message}`,
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
        task: 'analysis',
        contents: [{ text: prompt }],
      });

      res.json({ success: true, answer: text, modelUsed });
    } catch (error) {
      console.error('[Gemini Server Assistant Error]:', error);
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
    console.error('[HTTP] Unhandled server error.', error);
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
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Health Server] Running on http://0.0.0.0:${PORT} (mode: ${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('[Fatal Server Startup Error]:', err);
  process.exit(1);
});
