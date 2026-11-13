import { digitizationLogger } from './digitizationLogger';
import { type GeminiRequestContext } from './geminiRequestContext';
import {
  describeGeminiError,
  executeGeminiWithPool,
  GEMINI_TIMEOUTS,
} from './geminiUnifiedExecutor';
import {
  buildBatchOcrPrompt,
  buildHealthExtractionSystemInstruction,
  buildWholeDocumentOcrPrompt,
} from './healthAiPrompts';
import {
  cleanExtractedJson,
  mergeExtractedBatches,
  type ExtractedPageBatch,
} from './healthDocumentExtraction';
import { parseRobustJson, sleep } from './healthRecordService';
import {
  planPdfOcrBatches,
  shouldFallbackToBatchedPdfOcr,
  splitPdfIntoBatches,
  type PdfPageBatch,
} from './pdfPageBatches';

export interface RunUnifiedOcrOptions {
  base64Data: string;
  mimeType: string;
  fileName: string;
  memberName?: string;
  memberBirthDate?: string;
  isAutoDetect?: boolean;
  clientGeminiKeys?: string[];
  requestContext?: GeminiRequestContext;
  signal?: AbortSignal;
  interBatchDelayMs?: number;
  onPlanReady?: (info: { mode: 'whole_file' | 'chunked'; totalPages: number; batchCount: number }) => void;
  onBatchComplete?: (info: {
    completed: number;
    totalBatches: number;
    extracted: Record<string, unknown>;
    modelUsed: string;
    batch: PdfPageBatch;
    totalPages: number;
  }) => void;
  onProgress?: (message: string) => void;
}

export async function runUnifiedHealthDocumentOcr(
  options: RunUnifiedOcrOptions,
): Promise<{
  extracted: Record<string, unknown>;
  modelUsed: string;
  totalPages: number;
  processedPages: number;
  mode: 'whole_file' | 'chunked';
}> {
  const effectiveMime = options.mimeType || 'application/pdf';
  const memberName = options.memberName?.trim() || 'Thành viên gia đình';
  const memberBirth = options.memberBirthDate ? `sinh ngày ${options.memberBirthDate}` : '';
  const fileNameStr = options.fileName || 'Không rõ tên tệp';
  const fileYearMatch = fileNameStr.match(/\b(19|20)\d{2}\b/);
  const preferredYear = fileYearMatch ? fileYearMatch[0] : undefined;

  const systemInstruction = buildHealthExtractionSystemInstruction(
    memberName,
    memberBirth,
    fileNameStr,
    options.isAutoDetect ?? false,
  );

  const plan = effectiveMime === 'application/pdf'
    ? await planPdfOcrBatches(options.base64Data)
    : {
        mode: 'whole_file' as const,
        totalPages: 1,
        batches: [{ firstPage: 1, lastPage: 1, base64Data: options.base64Data }],
      };

  let preferredProjectId: string | undefined;
  options.onPlanReady?.({
    mode: plan.mode,
    totalPages: plan.totalPages,
    batchCount: plan.batches.length,
  });

  const executeBatchList = async (
    batches: PdfPageBatch[],
    isWholeDocumentPass: boolean,
  ): Promise<{ extracted: Record<string, unknown>; modelUsed: string }> => {
    const batchResults: ExtractedPageBatch[] = [];
    const modelNames: string[] = [];
    const delayMs = options.interBatchDelayMs ?? 1_500;

    for (let i = 0; i < batches.length; i++) {
      if (options.signal?.aborted) throw new Error('OCR was cancelled.');
      if (i > 0 && delayMs > 0) {
        options.onProgress?.('Chờ giây lát trước khi xử lý phần tiếp theo...');
        await sleep(delayMs);
      }

      const batch = batches[i];
      const promptText = isWholeDocumentPass && batches.length === 1
        ? buildWholeDocumentOcrPrompt(memberName, plan.totalPages)
        : buildBatchOcrPrompt(memberName, batch.firstPage, batch.lastPage, plan.totalPages);

      digitizationLogger.log(
        'info',
        'worker',
        isWholeDocumentPass && batches.length === 1
          ? `Bắt đầu OCR toàn bộ tài liệu (${plan.totalPages} trang) cho "${fileNameStr}"`
          : `Bắt đầu OCR đoạn ${i + 1}/${batches.length} (trang ${batch.firstPage}-${batch.lastPage}/${plan.totalPages})`,
        { fileName: fileNameStr, totalPages: plan.totalPages, mode: isWholeDocumentPass ? 'whole_file' : 'chunked' },
      );

      const { text, modelUsed, projectId } = await executeGeminiWithPool({
        task: 'digitization',
        contents: [
          { inlineData: { mimeType: effectiveMime, data: batch.base64Data } },
          { text: promptText },
        ],
        systemInstruction,
        responseMimeType: 'application/json',
        timeoutMs: GEMINI_TIMEOUTS.ocrTotalMs,
        signal: options.signal,
        onProgress: options.onProgress,
        clientGeminiKeys: options.clientGeminiKeys,
        requestContext: options.requestContext,
        preferredProjectId,
        shouldStopRetrying:
          isWholeDocumentPass && effectiveMime === 'application/pdf' && plan.totalPages > 1
            ? (error) => shouldFallbackToBatchedPdfOcr(error, plan.totalPages)
            : undefined,
      });
      preferredProjectId = projectId;

      const parsedJson = cleanExtractedJson(parseRobustJson(text));
      const labeledModel = `${modelUsed} [${projectId}]`;
      modelNames.push(modelUsed);

      batchResults.push({
        firstPage: batch.firstPage,
        lastPage: batch.lastPage,
        extracted: parsedJson,
        modelUsed: labeledModel,
      });

      const partialMerged = mergeExtractedBatches(batchResults, preferredYear, fileNameStr);
      options.onBatchComplete?.({
        completed: i + 1,
        totalBatches: batches.length,
        extracted: partialMerged,
        modelUsed: Array.from(new Set(modelNames)).join(', '),
        batch,
        totalPages: plan.totalPages,
      });
    }

    return {
      extracted: mergeExtractedBatches(batchResults, preferredYear, fileNameStr),
      modelUsed: Array.from(new Set(modelNames)).join(', '),
    };
  };

  try {
    const result = await executeBatchList(plan.batches, plan.mode === 'whole_file');
    return {
      ...result,
      totalPages: plan.totalPages,
      processedPages: plan.totalPages,
      mode: plan.mode,
    };
  } catch (error) {
    const details = describeGeminiError(error);
    const canFallbackChunk =
      effectiveMime === 'application/pdf' &&
      plan.mode === 'whole_file' &&
      !options.signal?.aborted &&
      !details.isInvalidKey &&
      !details.isRateLimit &&
      shouldFallbackToBatchedPdfOcr(error, plan.totalPages);

    if (!canFallbackChunk) {
      throw error;
    }

    const fallbackBatchPages = Math.min(8, Math.max(4, Math.ceil(plan.totalPages / 2)));
    digitizationLogger.log(
      'warn',
      'worker',
      `OCR toàn file "${fileNameStr}" (${plan.totalPages} trang) gặp giới hạn (${details.message}); tự động chia đoạn ~${fallbackBatchPages} trang để đảm bảo hoàn tất.`,
      { fileName: fileNameStr, totalPages: plan.totalPages, fallbackBatchPages },
    );
    options.onProgress?.(
      `Tài liệu lớn (${plan.totalPages} trang); tự động chia thành các phần ${fallbackBatchPages} trang giữ ngữ cảnh để xử lý tiếp...`,
    );

    const fallbackBatches = await splitPdfIntoBatches(options.base64Data, fallbackBatchPages, 100);
    const result = await executeBatchList(fallbackBatches, false);
    return {
      ...result,
      totalPages: plan.totalPages,
      processedPages: plan.totalPages,
      mode: 'chunked',
    };
  }
}
