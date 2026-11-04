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
const GEMINI_RATE_LIMIT_PER_MINUTE = 20;
const rateLimitWindows = new Map<string, { startedAt: number; count: number }>();
const GEMINI_ANALYSIS_ATTEMPT_TIMEOUT_MS = 18_000;
const GEMINI_DIGITIZATION_ATTEMPT_TIMEOUT_MS = 45_000;
const GEMINI_ANALYSIS_TIMEOUT_MS = 110_000;
const GEMINI_OCR_TIMEOUT_MS = 300_000;
const OCR_BATCH_PAGES = 3;
const OCR_BATCH_CONCURRENCY = 3;
let quotaScheduler: GeminiQuotaScheduler | null = null;

// Quotas are tracked independently for each configured project and model.
const TASK_MODELS = {
  digitization: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  analysis: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash'],
};

function getConfiguredProjects(): GeminiProject[] {
  return parseGeminiProjects(
    process.env.GEMINI_PROJECTS,
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

async function executeGeminiWithFailover(options: ExecuteOptions): Promise<{ text: string; modelUsed: string }> {
  const scheduler = getQuotaScheduler();
  const projects = scheduler.getProjects();
  if (projects.length === 0) {
    throw new Error('Chưa cấu hình GEMINI_PROJECTS hoặc GEMINI_API_KEYS trên máy chủ.');
  }

  const models = TASK_MODELS[options.task];
  const deadline = Date.now() + (options.timeoutMs || GEMINI_ANALYSIS_TIMEOUT_MS);
  const quota = getTaskQuota(options.task);
  let lastError: Error | null = null;

  for (const model of models) {
    const attemptedProjectIds = new Set<string>();
    while (attemptedProjectIds.size < projects.length && Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error('Gemini request was cancelled.');
      let lease: Awaited<ReturnType<GeminiQuotaScheduler['acquire']>>;
      try {
        lease = await scheduler.acquire(
          options.task,
          model,
          quota,
          attemptedProjectIds,
          Math.min(20_000, deadline - Date.now()),
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        break;
      }

      const { project } = lease;
      attemptedProjectIds.add(project.id);
      const attemptController = new AbortController();
      const cancelAttempt = () => attemptController.abort(new Error('Client disconnected.'));
      options.signal?.addEventListener('abort', cancelAttempt, { once: true });
      const attemptTimeout = setTimeout(
        () => attemptController.abort(new Error('Gemini attempt timed out.')),
        Math.min(getAttemptTimeout(options.task), deadline - Date.now()),
      );
      options.onProgress?.(`Đang xử lý bằng ${model} trên một trong ${projects.length} project độc lập.`);
      try {
        const ai = new GoogleGenAI({
          apiKey: project.apiKey,
          httpOptions: {
            timeout: Math.min(getAttemptTimeout(options.task), deadline - Date.now()),
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
        return { text, modelUsed: model };
      } catch (error) {
        const details = describeGeminiError(error);
        lastError = error instanceof Error ? error : new Error(String(error));
        const shouldRetry = recordProjectFailure(scheduler, project.id, model, error);
        console.warn(
          `[Gemini ${options.task}] ${model} failed for configured project ${project.id} (${details.status || 'network'}): ${details.message}`,
        );
        if (!shouldRetry) throw lastError;
      } finally {
        clearTimeout(attemptTimeout);
        options.signal?.removeEventListener('abort', cancelAttempt);
        lease.release();
      }
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
      hasProjectConfig: Boolean(process.env.GEMINI_PROJECTS),
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

      const systemInstruction = `Bạn là trợ lý y tế chuyên số hóa, OCR nhận dạng tài liệu y khoa Việt Nam (đơn thuốc, kết quả xét nghiệm, phiếu khám bệnh, giấy ra viện, sổ tiêm chủng).
Nhiệm vụ: Trích xuất và chuẩn hóa thông tin từ tài liệu đính kèm. Đồng thời phát hiện Họ và tên người bệnh, Ngày sinh/Năm sinh và Giới tính trên tài liệu để hệ thống đối chiếu ghép với thành viên gia đình (${memberName} ${memberBirth}).
QUY TẮC KHỬ TRÙNG LẶP DỮ LIỆU:
- Khử trùng lặp tuyệt đối các chẩn đoán, tên thuốc và chỉ số đo. Mỗi chẩn đoán, mỗi loại thuốc hoặc chỉ số chỉ xuất hiện một lần duy nhất với liều lượng và thông tin chi tiết nhất.
Hãy trả về DUY NHẤT một JSON object tuân thủ đúng cấu trúc:
{
  "title": "Tên ngắn gọn của sự kiện y tế (VD: Khám tổng quát, Đơn thuốc tai mũi họng)",
  "date": "YYYY-MM-DD (ngày khám trên tài liệu)",
  "type": "medical_report" | "prescription" | "test_result" | "vaccination" | "discharge" | "other",
  "patientName": "Họ và tên bệnh nhân ghi trên tài liệu (nếu có, VD: NGUYỄN VĂN A)",
  "patientBirthDate": "YYYY-MM-DD hoặc YYYY (ngày sinh hoặc năm sinh ghi trên tài liệu nếu có)",
  "patientGender": "Nam" | "Nữ" | "Khác" (giới tính ghi trên tài liệu nếu có),
  "facility": "Tên bệnh viện hoặc phòng khám",
  "diagnoses": ["Chẩn đoán 1", "Chẩn đoán 2"],
  "medications": [
    { "name": "Tên thuốc", "dosage": "Liều dùng", "frequency": "Số lần/ngày", "duration": "Thời gian uống" }
  ],
  "metrics": [
    { "name": "Chỉ số (Huyết áp, Đường huyết, SpO2, Cân nặng, v.v.)", "value": 120, "unit": "mmHg" }
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
                completedBatches++;
                const availableResults = results.filter(
                  (result): result is NonNullable<typeof result> => Boolean(result),
                );
                onBatchComplete?.(
                  completedBatches,
                  mergeExtractedBatches(availableResults),
                  Array.from(new Set(availableResults.map((result) => result.modelUsed))).join(', '),
                  batch,
                );
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
            ? `Đã chia PDF ${pageBatches.length} phần, tối đa ${OCR_BATCH_PAGES} trang/phần. Bắt đầu xử lý có giới hạn song song.`
            : 'Đã nhận tài liệu. Đang xếp lượt theo quota Gemini còn khả dụng.',
        });
        heartbeat = setInterval(() => {
          writeSse(res, {
            type: 'progress',
            message: 'Các phần tài liệu vẫn đang được xử lý; tiến độ sẽ cập nhật khi mỗi phần hoàn tất.',
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
              message: `Đã đọc xong ${completed}/${pageBatches.length} phần; hoàn tất trang ${batch.firstPage}-${batch.lastPage}.`,
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

  // 4. Phân tích chuyên sâu đa chiều & điểm sức khỏe
  app.post('/api/gemini/analyze-comprehensive', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';

      const prompt = `Bạn là hội đồng chuyên gia y khoa gia đình.
Hãy phân tích sâu toàn diện hồ sơ y tế của thành viên ${memberName}:
- Thông tin thành viên: ${JSON.stringify(member)}
- Toàn bộ hồ sơ tóm tắt: ${JSON.stringify(profile?.summary || {})}
- Diễn tiến các sự kiện y tế: ${JSON.stringify(profile?.timeline || [])}

Đây chỉ là thông tin tham khảo, không chẩn đoán hoặc thay thế bác sĩ. Chỉ đưa ra nhận định có căn cứ trong hồ sơ; nếu thiếu dữ liệu thì nói rõ chưa đủ dữ liệu, không mặc định tình trạng an toàn, không suy đoán tương tác thuốc. Điểm sức khỏe (0-100) chỉ được đưa ra nếu dữ liệu đủ; điểm này không phải thang đo lâm sàng đã kiểm chứng.
Trả về DUY NHẤT một JSON theo cấu trúc:
{
  "healthScore": 85,
  "overallAssessment": "Đánh giá chi tiết tình hình sức khỏe hiện tại...",
  "keyRisks": ["Rủi ro 1", "Rủi ro 2"],
  "recommendations": ["Lời khuyên 1", "Lời khuyên 2"],
  "vitalTrendAnalysis": "Phân tích biến thiên huyết áp, đường huyết, cân nặng..."
}`;

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
      });

      const parsed = parseJsonSafely(text) as {
        healthScore?: number;
        overallAssessment?: string;
        keyRisks?: string[];
        recommendations?: string[];
        vitalTrendAnalysis?: string;
      };
      if (
        typeof parsed.healthScore !== 'number' ||
        !Number.isFinite(parsed.healthScore) ||
        parsed.healthScore < 0 ||
        parsed.healthScore > 100 ||
        typeof parsed.overallAssessment !== 'string' ||
        !parsed.overallAssessment.trim() ||
        !Array.isArray(parsed.keyRisks) ||
        !parsed.keyRisks.every((item) => typeof item === 'string') ||
        !Array.isArray(parsed.recommendations) ||
        !parsed.recommendations.every((item) => typeof item === 'string') ||
        typeof parsed.vitalTrendAnalysis !== 'string' ||
        !parsed.vitalTrendAnalysis.trim()
      ) {
        throw new Error('Phản hồi phân tích thiếu trường hợp lệ hoặc không đủ căn cứ. Không tạo kết luận thay thế.');
      }

      res.json({
        success: true,
        result: {
          healthScore: parsed.healthScore,
          overallAssessment: parsed.overallAssessment,
          keyRisks: parsed.keyRisks,
          recommendations: parsed.recommendations,
          vitalTrendAnalysis: parsed.vitalTrendAnalysis,
        },
        modelUsed,
      });
    } catch (error) {
      console.error('[Gemini Server Analyze Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi phân tích hồ sơ y khoa.',
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
