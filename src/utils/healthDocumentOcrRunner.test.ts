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
});
