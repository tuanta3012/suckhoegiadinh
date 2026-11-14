import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, './firebase-applet-config.json'), 'utf8'));
import {
  getOrCreateSharedGeminiRequestContext,
  normalizeGeminiKeysInput,
  type GeminiRequestContext,
} from './src/utils/geminiRequestContext.ts';
import { GeminiRequestAdmission } from './src/utils/geminiRequestAdmission.ts';
import {
  describeGeminiError,
  executeGeminiStreamWithPool,
  executeGeminiWithPool,
  GEMINI_TIMEOUTS,
  getModelQuota,
  getTaskQuota,
  researchHealthQuestionWithPool,
  TASK_MODELS,
  testGeminiApiKeyDirect,
} from './src/utils/geminiUnifiedExecutor.ts';
import {
  buildComprehensiveAnalysisPrompt,
  buildRefinePrompt,
  buildSummarizePrompt,
  COMPREHENSIVE_ANALYSIS_RESPONSE_SCHEMA,
  createHealthAssistantPrompt,
  HEALTH_ASSISTANT_SYSTEM_INSTRUCTION,
  normalizeComprehensiveAnalysisPayload,
  SUMMARIZE_RESPONSE_SCHEMA,
} from './src/utils/healthAiPrompts.ts';
import { runUnifiedHealthDocumentOcr } from './src/utils/healthDocumentOcrRunner.ts';
import {
  FALLBACK_MAX_BATCH_PAGES,
  PdfPageBatchError,
  WHOLE_PDF_MAX_PAGES,
} from './src/utils/pdfPageBatches.ts';
import { cleanExtractedJson } from './src/utils/healthDocumentExtraction.ts';
import { digitizationLogger } from './src/utils/digitizationLogger.ts';
import { parseRobustJson } from './src/utils/healthRecordService.ts';
import {
  normalizeHealthAssistantHistory,
} from './src/utils/healthAssistantContext.ts';

const isProd = process.env.NODE_ENV === 'production';

function getPort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.PORT) || 3000;
}

const PORT = getPort();
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4;
const geminiRequestAdmission = new GeminiRequestAdmission(6, 12);

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

function writeSse(res: Response, data: Record<string, unknown>): void {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
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

function resolveServerGeminiKeys(clientGeminiKeys: unknown): string[] {
  return normalizeGeminiKeysInput(clientGeminiKeys);
}

function getGeminiRequestSignal(res: Response): AbortSignal | undefined {
  return res.locals.geminiAbortSignal as AbortSignal | undefined;
}

function getGeminiRequestId(res: Response): string | undefined {
  return res.locals.requestId as string | undefined;
}

function logServerRouteError(
  endpoint: string,
  res: Response,
  error: unknown,
  status?: number,
  extra?: Record<string, unknown>,
): void {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  digitizationLogger.log(
    'error',
    'api_http_error',
    `Server route lỗi tại ${endpoint}: ${errorMessage}`,
    {
      requestId: getGeminiRequestId(res),
      endpoint,
      status,
      errorName,
      errorMessage,
      ...(extra || {}),
    },
    undefined,
    'server',
  );
}

async function startServer() {
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/api/gemini/status', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      keySource: 'workspace-ai-resources',
      hasServerEnvKeys: false,
      requiresWorkspaceKeys: true,
      supportedTasks: Object.keys(TASK_MODELS),
      taskModels: TASK_MODELS,
      quotasPerProject: {
        digitization: getTaskQuota('digitization'),
        analysis: getTaskQuota('analysis'),
        assistant: getTaskQuota('assistant'),
        refinement: getTaskQuota('refinement'),
      },
      modelQuotas: {
        'gemini-3.5-flash-lite': getModelQuota('gemini-3.5-flash-lite'),
        'gemini-4-hydrogen': getModelQuota('gemini-4-hydrogen'),
      },
      ocr: {
        strategy: 'whole-pdf-first-with-context-chunk-fallback',
        wholePdfMaxPages: WHOLE_PDF_MAX_PAGES,
        fallbackMaxBatchPages: FALLBACK_MAX_BATCH_PAGES,
        failedKeyCooldownMs: GEMINI_TIMEOUTS.projectCooldownMs,
        primaryModel: TASK_MODELS.digitization[0],
        zeroDowngradeEnforced: true,
      },
      architecture: 'unified-gemini-orchestrator',
    });
  });

  app.use('/api/gemini', async (req: Request, res: Response, next) => {
    req.setTimeout(300_000);
    res.setTimeout(300_000);
    if (req.path === '/status' || req.path === '/digitization-logs') {
      next();
      return;
    }

    const requestStartedAt = Date.now();
    const requestedId = req.header('X-Request-Id') || '';
    const requestId = /^[a-zA-Z0-9._:-]{1,100}$/.test(requestedId) ? requestedId : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.locals.requestId = requestId;
    digitizationLogger.log('info', 'api_http_received', 'Backend nhận yêu cầu Gemini.', {
      requestId,
      method: req.method,
      endpoint: req.path,
    }, undefined, 'server');

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

    const admissionAbort = new AbortController();
    const abortQueuedRequest = () => admissionAbort.abort(new Error('Client disconnected.'));
    req.once('aborted', abortQueuedRequest);
    res.once('close', abortQueuedRequest);
    let admissionTimedOut = false;
    const admissionTimer = setTimeout(() => {
      admissionTimedOut = true;
      admissionAbort.abort(new Error('Timed out waiting for a Gemini request slot.'));
    }, 120_000);
    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = await geminiRequestAdmission.acquire(uid, admissionAbort.signal);
    } catch (error) {
      clearTimeout(admissionTimer);
      req.removeListener('aborted', abortQueuedRequest);
      res.removeListener('close', abortQueuedRequest);
      const queueIsFull = error instanceof Error && error.message.includes('queue is full');
      if (res.destroyed || res.writableEnded || (admissionAbort.signal.aborted && !admissionTimedOut)) return;
      digitizationLogger.log(
        'warn',
        'api_http_rejected',
        'Yêu cầu Gemini bị từ chối tại admission queue.',
        {
          requestId,
          endpoint: req.path,
          status: 429,
          reason: queueIsFull ? 'queue_full' : 'queue_timeout',
          durationMs: Date.now() - requestStartedAt,
        },
        Date.now() - requestStartedAt,
        'server',
      );
      res.setHeader('Retry-After', '10');
      res.status(429).json({
        error: queueIsFull
          ? 'Máy chủ AI đang có nhiều tác vụ. Yêu cầu chưa được xếp hàng; vui lòng thử lại sau ít giây.'
          : 'Đang chờ quá lâu để xử lý yêu cầu AI. Vui lòng thử lại sau.',
      });
      return;
    }
    clearTimeout(admissionTimer);
    req.removeListener('aborted', abortQueuedRequest);
    res.removeListener('close', abortQueuedRequest);
    if (admissionAbort.signal.aborted) {
      releaseAdmission();
      return;
    }
    let admissionReleased = false;
    const releaseOnce = () => {
      if (admissionReleased) return;
      admissionReleased = true;
      releaseAdmission?.();
    };
    const abortActiveRequest = () => {
      if (!res.writableEnded) admissionAbort.abort(new Error('Client disconnected.'));
    };
    digitizationLogger.log('info', 'api_http_admitted', 'Yêu cầu Gemini được nhận vào xử lý.', {
      requestId,
      endpoint: req.path,
      queueWaitMs: Date.now() - requestStartedAt,
    }, Date.now() - requestStartedAt, 'server');
    res.once('finish', () => {
      digitizationLogger.log('info', 'api_http_complete', 'Backend hoàn tất yêu cầu Gemini.', {
        requestId,
        endpoint: req.path,
        status: res.statusCode,
        durationMs: Date.now() - requestStartedAt,
      }, Date.now() - requestStartedAt, 'server');
      releaseOnce();
    });
    res.once('close', () => {
      if (!res.writableEnded) {
        abortActiveRequest();
        digitizationLogger.log('warn', 'api_http_disconnected', 'Client ngắt kết nối khi tác vụ Gemini đang chạy.', {
          requestId,
          endpoint: req.path,
          durationMs: Date.now() - requestStartedAt,
        }, Date.now() - requestStartedAt, 'server');
      }
      releaseOnce();
    });
    res.locals.firebaseUid = uid;
    res.locals.geminiAbortSignal = admissionAbort.signal;
    next();
  });

  app.get('/api/gemini/digitization-logs', (_req: Request, res: Response) => {
    res.json({ success: true, logs: digitizationLogger.getLogs() });
  });

  app.use(express.json({ limit: '44mb' }));

  // 1. Kiểm tra API key qua unified helper
  app.post('/api/gemini/test-key', async (req: Request, res: Response) => {
    const { key } = req.body;
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!cleanKey) {
      res.status(400).json({ error: 'API key không được để trống.' });
      return;
    }
    const result = await testGeminiApiKeyDirect(cleanKey);
    if (result.valid) {
      res.json({
        valid: true,
        modelUsed: result.workingModel,
        workingModel: result.workingModel,
        ...(result.quotaExhausted ? { quotaExhausted: true } : {}),
      });
      return;
    }
    logServerRouteError('/api/gemini/test-key', res, new Error(result.error || 'Key không hợp lệ.'), 400);
    res.status(400).json({ error: result.error || 'Key không hợp lệ.' });
  });

  // 1.5. Proxy Endpoint cho generateContent
  app.post('/api/gemini/generate-content', async (req: Request, res: Response) => {
    try {
      const { model, contents, config } = req.body;
      if (typeof model !== 'string' || !model.trim() || contents === undefined) {
        res.status(400).json({ error: 'Thiếu model hoặc nội dung cần gửi tới Gemini.' });
        return;
      }
      const { text, modelUsed } = await executeGeminiWithPool({
        task: 'assistant',
        contents,
        requestId: getGeminiRequestId(res),
        preferredModel: model,
        generationConfig: isRecord(config) ? config : undefined,
        timeoutMs: 60_000,
        signal: getGeminiRequestSignal(res),
        clientGeminiKeys: resolveServerGeminiKeys(req.body.clientGeminiKeys),
      });
      res.json({ success: true, text, modelUsed });
    } catch (err) {
      console.error('[Gemini Server GenerateContent Error]', err);
      const details = describeGeminiError(err);
      logServerRouteError('/api/gemini/generate-content', res, err, details.status || 500);
      res.status(details.status || 500).json({ error: details.message || 'Lỗi khi gọi Gemini API.' });
    }
  });

  // 2. Trích xuất tài liệu (Whole-PDF first OCR + context-preserving chunk fallback)
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
        res.status(413).json({ error: 'Tệp vượt quá giới hạn 30 MB hoặc có dữ liệu mã hóa không hợp lệ.' });
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
      const fileNameStr = typeof req.body.fileName === 'string' ? req.body.fileName : 'Không rõ tên tệp';
      const requestContext = getOrCreateSharedGeminiRequestContext(resolveServerGeminiKeys(req.body.clientGeminiKeys));

      if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        modelAbortController = new AbortController();
        heartbeat = setInterval(() => {
          writeSse(res, {
            type: 'progress',
            message: 'AI đang phân tích toàn bộ tài liệu...',
          });
        }, 8_000);
        res.on('close', () => {
          if (!res.writableEnded) modelAbortController?.abort(new Error('Client disconnected.'));
          if (heartbeat) clearInterval(heartbeat);
        });
        extractionTimeout = setTimeout(
          () => modelAbortController?.abort(new Error('Tài liệu vượt quá thời gian OCR tối đa 10 phút.')),
          GEMINI_TIMEOUTS.ocrTotalMs,
        );

        const result = await runUnifiedHealthDocumentOcr({
          base64Data,
          mimeType: effectiveMime,
          fileName: fileNameStr,
          memberName: member?.name,
          memberBirthDate: member?.birthDate,
          isAutoDetect: Boolean(isAutoDetect),
          requestContext,
          requestId: getGeminiRequestId(res),
          signal: modelAbortController.signal,
          interBatchDelayMs: 2_000,
          onPlanReady: ({ mode, totalPages }) => {
            writeSse(res, {
              type: 'progress',
              progressPercent: 46,
              message: mode === 'whole_file'
                ? `Đang gửi nguyên tệp (${totalPages} trang) để giữ trọn ngữ cảnh...`
                : `Đang xử lý tài liệu lớn (${totalPages} trang)...`,
              totalPages,
            });
          },
          onBatchComplete: ({ completed, totalBatches, extracted, modelUsed, batch, totalPages }) => {
            const pageRange = batch.firstPage === batch.lastPage ? `trang ${batch.firstPage}` : `các trang ${batch.firstPage}-${batch.lastPage}`;
            writeSse(res, {
              type: 'progress',
              progressPercent: Math.min(92, 48 + Math.floor((completed / totalBatches) * 44)),
              message: totalBatches === 1
                ? `AI (${modelUsed}) đang tổng hợp kết quả y tế (${totalPages}/${totalPages} trang)...`
                : `AI (${modelUsed}) đang bóc tách ${pageRange} (Đã xong ${batch.lastPage}/${totalPages} trang)...`,
              currentPage: batch.firstPage,
              processedPages: batch.lastPage,
              totalPages,
              extracted,
              modelUsed,
            });
          },
          onProgress: (msg) => writeSse(res, { type: 'progress', message: msg || 'AI đang xử lý tài liệu...' }),
        });

        writeSse(res, {
          type: 'complete',
          extracted: result.extracted,
          modelUsed: result.modelUsed,
          processedPages: result.processedPages,
          totalPages: result.totalPages,
        });
        if (heartbeat) clearInterval(heartbeat);
        if (extractionTimeout) clearTimeout(extractionTimeout);
        res.end();
        return;
      }

      const result = await runUnifiedHealthDocumentOcr({
        base64Data,
        mimeType: effectiveMime,
        fileName: fileNameStr,
        memberName: member?.name,
        memberBirthDate: member?.birthDate,
        isAutoDetect: Boolean(isAutoDetect),
        requestContext,
        requestId: getGeminiRequestId(res),
        signal: getGeminiRequestSignal(res),
        interBatchDelayMs: 2_000,
      });
      res.json({
        success: true,
        extracted: result.extracted,
        modelUsed: result.modelUsed,
        processedPages: result.processedPages,
        totalPages: result.totalPages,
      });
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (extractionTimeout) clearTimeout(extractionTimeout);
      if (error instanceof PdfPageBatchError) {
        logServerRouteError('/api/gemini/extract-health-event', res, error, 400);
        if (res.headersSent) {
          writeSse(res, { type: 'error', error: error.message });
          res.end();
        } else {
          res.status(400).json({ error: error.message });
        }
        return;
      }
      const details = describeGeminiError(error);
      logServerRouteError('/api/gemini/extract-health-event', res, error, details.status || 500);
      console.error('[Gemini Server Extract Error]', { status: details.status });
      if (res.headersSent) {
        writeSse(res, { type: 'error', error: details.message });
        res.end();
      } else {
        res.status(details.status || 500).json({ error: details.message });
      }
    }
  });

  // 3. Chuẩn hóa & sắp xếp thông minh
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
      const { text, modelUsed } = await executeGeminiWithPool({
        task: 'refinement',
        contents: [{ text: buildRefinePrompt(memberName, events) }],
        requestId: getGeminiRequestId(res),
        responseMimeType: 'application/json',
        signal: getGeminiRequestSignal(res),
        clientGeminiKeys: resolveServerGeminiKeys(req.body.clientGeminiKeys),
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
      logServerRouteError('/api/gemini/refine-and-organize', res, error, details.status || 500);
      console.error('[Gemini Server Refine Error]', { status: details.status });
      res.status(details.status || 500).json({ error: details.message });
    }
  });

  // 4. Tóm tắt hồ sơ sức khỏe
  app.post('/api/gemini/summarize', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';

      const { text, modelUsed } = await executeGeminiWithPool({
        task: 'assistant',
        contents: [{ text: buildSummarizePrompt(memberName, member, profile) }],
        requestId: getGeminiRequestId(res),
        responseMimeType: 'application/json',
        responseSchema: SUMMARIZE_RESPONSE_SCHEMA,
        signal: getGeminiRequestSignal(res),
        clientGeminiKeys: resolveServerGeminiKeys(req.body.clientGeminiKeys),
      });

      const parsed = parseJsonSafely(text) as { summary?: string };
      res.json({ success: true, summary: parsed.summary || text, modelUsed });
    } catch (error) {
      const details = describeGeminiError(error);
      logServerRouteError('/api/gemini/summarize', res, error, details.status || 500);
      console.error('[Gemini Server Summary Error]', { status: details.status });
      res.status(details.status || 500).json({ error: details.message });
    }
  });

  // 5. Phân tích chuyên sâu 4 lớp y khoa
  app.post('/api/gemini/analyze-comprehensive', async (req: Request, res: Response) => {
    try {
      const { member, profile } = req.body;
      const memberName = member?.name || 'Thành viên';
      digitizationLogger.log('info', 'analysis', 'Bắt đầu phân tích chuyên sâu', {
        requestId: getGeminiRequestId(res),
        memberId: member?.id,
        eventCount: profile?.timeline?.length,
      }, undefined, 'server');

      const requestedModel = typeof req.body.model === 'string' && TASK_MODELS.analysis.includes(req.body.model as any)
        ? req.body.model
        : TASK_MODELS.analysis[0];

      const { text, modelUsed } = await executeGeminiWithPool({
        task: 'analysis',
        contents: [{ text: buildComprehensiveAnalysisPrompt(memberName, member, profile) }],
        requestId: getGeminiRequestId(res),
        responseMimeType: 'application/json',
        responseSchema: COMPREHENSIVE_ANALYSIS_RESPONSE_SCHEMA,
        preferredModel: requestedModel,
        signal: getGeminiRequestSignal(res),
        clientGeminiKeys: resolveServerGeminiKeys(req.body.clientGeminiKeys),
      });

      const parsed = parseJsonSafely(text);
      const normalized = normalizeComprehensiveAnalysisPayload(parsed, memberName);

      res.json({
        success: true,
        ...normalized,
        modelUsed,
      });
    } catch (error) {
      const details = describeGeminiError(error);
      logServerRouteError('/api/gemini/analyze-comprehensive', res, error, details.status || 500);
      console.error('[Gemini Server Analyze Error]', { status: details.status });
      res.status(details.status || 500).json({ error: details.message });
    }
  });

  // 6. Trợ lý AI Hỏi đáp sức khỏe (Streaming SSE & Non-streaming qua unified executor)
  app.post('/api/gemini/ask-assistant', async (req: Request, res: Response) => {
    try {
      const { question, member, profile, stream } = req.body;
      if (typeof question !== 'string' || !question.trim()) {
        res.status(400).json({ error: 'Chưa có nội dung câu hỏi.' });
        return;
      }
      const currentQuestion = question.trim();
      if (currentQuestion.length > 2_000) {
        res.status(400).json({ error: 'Câu hỏi quá dài. Vui lòng nhập tối đa 2.000 ký tự.' });
        return;
      }

      const memberName = typeof member?.name === 'string' ? member.name.slice(0, 120) : 'Thành viên';
      const history = normalizeHealthAssistantHistory(req.body.history);
      const requestContext = getOrCreateSharedGeminiRequestContext(resolveServerGeminiKeys(req.body.clientGeminiKeys));

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error('Câu hỏi vượt quá thời gian chờ tối đa.')),
          GEMINI_TIMEOUTS.analysisTotalMs,
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

        try {
          const research = await researchHealthQuestionWithPool(
            currentQuestion,
            memberName,
            { requestContext, requestId: getGeminiRequestId(res), signal: controller.signal },
          );
          const prompt = createHealthAssistantPrompt(
            currentQuestion,
            memberName,
            profile,
            history,
            research,
          );
          writeSse(res, { type: 'sources', citations: research.citations });

          await executeGeminiStreamWithPool(
            {
              task: 'assistant',
              contents: prompt,
              systemInstruction: HEALTH_ASSISTANT_SYSTEM_INSTRUCTION,
              requestContext,
              requestId: getGeminiRequestId(res),
              signal: controller.signal,
            },
            (chunk, modelUsed) => {
              writeSse(res, { text: chunk, modelUsed });
            },
          );

          writeSse(res, { type: 'done' });
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (error) {
          const details = describeGeminiError(error);
          logServerRouteError('/api/gemini/ask-assistant', res, error, details.status || 500, { stream: true });
          writeSse(res, { type: 'error', error: details.message });
          res.end();
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
        }
        return;
      }

      const requestSignal = getGeminiRequestSignal(res);
      const research = await researchHealthQuestionWithPool(
        currentQuestion,
        memberName,
        { requestContext, requestId: getGeminiRequestId(res), signal: requestSignal },
      );
      const prompt = createHealthAssistantPrompt(
        currentQuestion,
        memberName,
        profile,
        history,
        research,
      );
      const { text, modelUsed } = await executeGeminiWithPool({
        task: 'assistant',
        contents: [{ text: prompt }],
        systemInstruction: HEALTH_ASSISTANT_SYSTEM_INSTRUCTION,
        requestContext,
        requestId: getGeminiRequestId(res),
        signal: requestSignal,
      });

      res.json({ success: true, answer: text, citations: research.citations, modelUsed });
    } catch (error) {
      const details = describeGeminiError(error);
      logServerRouteError('/api/gemini/ask-assistant', res, error, details.status || 500, { stream: Boolean(req.body?.stream) });
      console.error('[Gemini Server Assistant Error]', { status: details.status });
      if (res.headersSent) {
        writeSse(res, {
          type: 'error',
          error: details.message || 'Lỗi khi giao tiếp với trợ lý bác sĩ.',
        });
        res.end();
      } else {
        res.status(details.status || 500).json({ error: details.message });
      }
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 500;
    if (status === 413) {
      res.status(413).json({ error: 'Yêu cầu vượt giới hạn kích thước. Tệp PDF tối đa 30 MB.' });
      return;
    }
    if (status === 400) {
      res.status(400).json({ error: 'Dữ liệu yêu cầu không phải JSON hợp lệ.' });
      return;
    }
    console.error('[HTTP] Unhandled server error.');
    res.status(500).json({ error: 'Máy chủ chưa thể xử lý yêu cầu.' });
  });

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
