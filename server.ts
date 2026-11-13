import express, { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(__dirname, './firebase-applet-config.json'), 'utf8'));
import {
  getOrCreateSharedGeminiRequestContext,
  type GeminiRequestContext,
} from './src/utils/geminiRequestContext.ts';
import {
  describeGeminiError,
  executeGeminiStreamWithPool,
  executeGeminiWithPool,
  GEMINI_TIMEOUTS,
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
const GEMINI_RATE_LIMIT_PER_MINUTE = 20;
const rateLimitWindows = new Map<string, { startedAt: number; count: number }>();

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
  const clientList = Array.isArray(clientGeminiKeys)
    ? clientGeminiKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 10).map((k) => k.trim())
    : [];
  const envRaw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const envList = envRaw
    .split(/[,;\n]+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 10);
  return Array.from(new Set([...clientList, ...envList]));
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/api/gemini/status', (_req: Request, res: Response) => {
    const serverKeysCount = resolveServerGeminiKeys([]).length;
    res.json({
      status: 'ok',
      keySource: serverKeysCount > 0 ? 'server-env-and-workspace' : 'workspace-ai-resources',
      hasServerEnvKeys: serverKeysCount > 0,
      requiresWorkspaceKeys: serverKeysCount === 0,
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
        'gemini-4-hydrogen': { rpm: 5, rpd: 20, maxConcurrent: 2 },
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
        preferredModel: model,
        generationConfig: isRecord(config) ? config : undefined,
        timeoutMs: 60_000,
        clientGeminiKeys: resolveServerGeminiKeys(req.body.clientGeminiKeys),
      });
      res.json({ success: true, text, modelUsed });
    } catch (err) {
      console.error('[Gemini Server GenerateContent Error]', err);
      const details = describeGeminiError(err);
      res.status(500).json({ error: details.message || 'Lỗi khi gọi Gemini API.' });
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
        if (res.headersSent) {
          writeSse(res, { type: 'error', error: error.message });
          res.end();
        } else {
          res.status(400).json({ error: error.message });
        }
        return;
      }
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
        responseMimeType: 'application/json',
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
        responseMimeType: 'application/json',
        responseSchema: SUMMARIZE_RESPONSE_SCHEMA,
        clientGeminiKeys: resolveServerGeminiKeys(req.body.clientGeminiKeys),
      });

      const parsed = parseJsonSafely(text) as { summary?: string };
      res.json({ success: true, summary: parsed.summary || text, modelUsed });
    } catch (error) {
      const details = describeGeminiError(error);
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
        memberId: member?.id,
        eventCount: profile?.timeline?.length,
      });

      const requestedModel = typeof req.body.model === 'string' && TASK_MODELS.analysis.includes(req.body.model as any)
        ? req.body.model
        : TASK_MODELS.analysis[0];

      const { text, modelUsed } = await executeGeminiWithPool({
        task: 'analysis',
        contents: [{ text: buildComprehensiveAnalysisPrompt(memberName, member, profile) }],
        responseMimeType: 'application/json',
        responseSchema: COMPREHENSIVE_ANALYSIS_RESPONSE_SCHEMA,
        preferredModel: requestedModel,
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
      console.error('[Gemini Server Analyze Error]', { status: describeGeminiError(error).status });
      const { status, message } = describeGeminiError(error);
      let userFriendlyMessage = message;
      if (status === 503 || /high demand|temporarily unavailable|overloaded/i.test(message)) {
        userFriendlyMessage = 'Mô hình AI hiện đang quá tải từ máy chủ Google (503 High Demand). Hệ thống sẽ tự động thử lại sau.';
      } else if (status === 429 || /quota|resource_exhausted/i.test(message)) {
        userFriendlyMessage = 'Hạn ngạch AI tạm thời đạt giới hạn (429 Quota Exhausted). Vui lòng thử lại sau.';
      }
      res.status(500).json({ error: userFriendlyMessage });
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
            { requestContext, signal: controller.signal },
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
          const message = error instanceof Error ? error.message : 'Lỗi khi giao tiếp với trợ lý Gemini.';
          writeSse(res, { type: 'error', error: message });
          res.end();
        } finally {
          clearTimeout(timeout);
          clearInterval(heartbeat);
        }
        return;
      }

      const research = await researchHealthQuestionWithPool(currentQuestion, memberName, { requestContext });
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
      });

      res.json({ success: true, answer: text, citations: research.citations, modelUsed });
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
