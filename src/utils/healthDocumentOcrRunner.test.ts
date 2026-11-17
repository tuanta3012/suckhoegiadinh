import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeGeminiWithPool: vi.fn(),
  planPdfOcrBatches: vi.fn(),
  shouldFallbackToBatchedPdfOcr: vi.fn(),
  splitPdfIntoBatches: vi.fn(),
}));

vi.mock('./geminiUnifiedExecutor', () => ({
  describeGeminiError: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
    isInvalidKey: false,
    isRateLimit: false,
    status: (error as { status?: number })?.status,
  }),
  executeGeminiWithPool: mocks.executeGeminiWithPool,
  GEMINI_TIMEOUTS: { ocrTotalMs: 1_000 },
}));

vi.mock('./pdfPageBatches', () => ({
  planPdfOcrBatches: mocks.planPdfOcrBatches,
  shouldFallbackToBatchedPdfOcr: mocks.shouldFallbackToBatchedPdfOcr,
  splitPdfIntoBatches: mocks.splitPdfIntoBatches,
}));

vi.mock('./healthAiPrompts', () => ({
  buildBatchOcrPrompt: (_name: string, first: number, last: number) => `pages:${first}-${last}`,
  buildHealthExtractionSystemInstruction: () => 'instruction',
  buildWholeDocumentOcrPrompt: () => 'whole-document',
}));

import { runUnifiedHealthDocumentOcr } from './healthDocumentOcrRunner';

describe('runUnifiedHealthDocumentOcr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes batches in order and keeps subsequent batches on the same key', async () => {
    mocks.planPdfOcrBatches.mockResolvedValue({
      mode: 'chunked',
      totalPages: 4,
      batches: [
        { firstPage: 1, lastPage: 2, base64Data: 'first-batch' },
        { firstPage: 3, lastPage: 4, base64Data: 'second-batch' },
      ],
    });
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    mocks.executeGeminiWithPool.mockImplementation(async (options: { preferredProjectId?: string }) => {
      expect(completed).toBe(mocks.executeGeminiWithPool.mock.calls.length - 1);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      completed++;
      return {
        text: JSON.stringify({ title: `Batch ${completed}`, contentIndexPages: [`Page ${completed}`] }),
        modelUsed: 'gemini-3.5-flash-lite',
        projectId: 'account-1',
      };
    });

    const result = await runUnifiedHealthDocumentOcr({
      base64Data: 'document-data',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      interBatchDelayMs: 0,
    });

    expect(maxActive).toBe(1);
    expect(mocks.executeGeminiWithPool).toHaveBeenCalledTimes(2);
    expect(mocks.executeGeminiWithPool.mock.calls[0][0].preferredProjectId).toBeUndefined();
    expect(mocks.executeGeminiWithPool.mock.calls[1][0].preferredProjectId).toBe('account-1');
    expect(result.mode).toBe('chunked');
    expect(result.processedPages).toBe(4);
  });

  it('falls back to chunked batches when whole-document OCR fails with 503 Service Unavailable', async () => {
    mocks.planPdfOcrBatches.mockResolvedValue({
      mode: 'whole_file',
      totalPages: 6,
      batches: [{ firstPage: 1, lastPage: 6, base64Data: 'whole-file-data' }],
    });
    mocks.shouldFallbackToBatchedPdfOcr.mockReturnValue(false);
    mocks.splitPdfIntoBatches.mockResolvedValue([
      { firstPage: 1, lastPage: 3, base64Data: 'batch-1' },
      { firstPage: 4, lastPage: 6, base64Data: 'batch-2' },
    ]);

    mocks.executeGeminiWithPool
      .mockRejectedValueOnce(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))
      .mockResolvedValueOnce({
        text: JSON.stringify({ title: 'Tập 1', contentIndexPages: ['P1', 'P2', 'P3'] }),
        modelUsed: 'gemini-3.5-flash-lite',
        projectId: 'account-1',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ title: 'Tập 2', contentIndexPages: ['P4', 'P5', 'P6'] }),
        modelUsed: 'gemini-3.5-flash-lite',
        projectId: 'account-1',
      });

    const result = await runUnifiedHealthDocumentOcr({
      base64Data: 'pdf-data',
      mimeType: 'application/pdf',
      fileName: 'Xet nghiem mau 2026.pdf',
      interBatchDelayMs: 0,
    });

    expect(mocks.splitPdfIntoBatches).toHaveBeenCalledWith('pdf-data', 4, 100);
    expect(mocks.executeGeminiWithPool).toHaveBeenCalledTimes(3);
    expect(result.mode).toBe('chunked');
    expect(result.totalPages).toBe(6);
    expect(result.processedPages).toBe(6);
  });

  it('aborts immediately and does not attempt chunk fallback when cancelled', async () => {
    mocks.planPdfOcrBatches.mockResolvedValue({
      mode: 'whole_file',
      totalPages: 6,
      batches: [{ firstPage: 1, lastPage: 6, base64Data: 'whole-file-data' }],
    });
    const controller = new AbortController();
    mocks.executeGeminiWithPool.mockImplementationOnce(async () => {
      controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
      throw new DOMException('The user aborted a request.', 'AbortError');
    });

    await expect(runUnifiedHealthDocumentOcr({
      base64Data: 'pdf-data',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      signal: controller.signal,
      interBatchDelayMs: 0,
    })).rejects.toThrow();

    expect(mocks.splitPdfIntoBatches).not.toHaveBeenCalled();
    expect(mocks.executeGeminiWithPool).toHaveBeenCalledOnce();
  });

  it('runs batches concurrently across keys without key-pinning when multiple API keys are available', async () => {
    mocks.planPdfOcrBatches.mockResolvedValue({
      mode: 'chunked',
      totalPages: 4,
      batches: [
        { firstPage: 1, lastPage: 2, base64Data: 'batch-1' },
        { firstPage: 3, lastPage: 4, base64Data: 'batch-2' },
      ],
    });
    let active = 0;
    let maxActive = 0;
    mocks.executeGeminiWithPool.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {
        text: JSON.stringify({ title: 'Batch result', contentIndexPages: ['P1'] }),
        modelUsed: 'gemini-3.5-flash-lite',
        projectId: 'account-pool',
      };
    });

    const result = await runUnifiedHealthDocumentOcr({
      base64Data: 'document-data',
      mimeType: 'application/pdf',
      fileName: 'multipage.pdf',
      clientGeminiKeys: ['key-1', 'key-2'],
    });

    expect(maxActive).toBeGreaterThan(1); // Parallel execution occurred
    expect(mocks.executeGeminiWithPool).toHaveBeenCalledTimes(2);
    // Neither batch pinned preferredProjectId to account-1
    expect(mocks.executeGeminiWithPool.mock.calls[0][0].preferredProjectId).toBeUndefined();
    expect(mocks.executeGeminiWithPool.mock.calls[1][0].preferredProjectId).toBeUndefined();
    expect(result.mode).toBe('chunked');
    expect(result.processedPages).toBe(4);
  });
});


