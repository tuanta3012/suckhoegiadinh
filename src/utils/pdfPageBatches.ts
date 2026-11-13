import { PDFDocument } from 'pdf-lib';

export interface PdfPageBatch {
  firstPage: number;
  lastPage: number;
  base64Data: string;
}

export class PdfPageBatchError extends Error {}

export const WHOLE_PDF_MAX_PAGES = 30;
export const WHOLE_PDF_MAX_BASE64_CHARS = 18 * 1024 * 1024; // ~13.5 MB binary, safely under Gemini's 20 MB inline payload cap
export const FALLBACK_MAX_BATCH_PAGES = 10;

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Use a more memory-efficient way to convert large arrays to base64
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Accurately detects the exact number of pages in a PDF file from base64 or ArrayBuffer
 */
export async function getPdfPageCount(base64OrArrayBuffer: string | ArrayBuffer): Promise<number> {
  try {
    const buffer = typeof base64OrArrayBuffer === 'string'
      ? base64ToUint8Array(base64OrArrayBuffer)
      : new Uint8Array(base64OrArrayBuffer);
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return pdfDoc.getPageCount();
  } catch (error) {
    console.warn('[PDF Page Count Detector Warning]: Could not detect PDF page count.', error);
    return 1;
  }
}

export async function splitPdfIntoBatches(
  base64Data: string,
  batchPages = 6,
  maximumPages = 100,
): Promise<PdfPageBatch[]> {
  if (!Number.isInteger(batchPages) || batchPages < 1) {
    throw new Error('PDF batch size must be a positive integer.');
  }
  let source: PDFDocument;
  try {
    // Luôn sử dụng ignoreEncryption: true để đọc được cả các file PDF có bảo vệ cơ bản
    source = await PDFDocument.load(base64ToUint8Array(base64Data), { ignoreEncryption: true });
  } catch (error) {
    console.error('[PDF Split Error]:', error);
    throw new PdfPageBatchError('Không đọc được PDF. Tệp có thể bị hỏng hoặc được bảo vệ mật khẩu nâng cao.', { cause: error });
  }
  const pageCount = source.getPageCount();
  console.info(`[OCR] PDF ${pageCount} pages detected.`);
  if (pageCount === 0) throw new PdfPageBatchError('PDF không có trang để số hóa.');
  if (pageCount > maximumPages) {
    throw new PdfPageBatchError(`PDF có hơn ${maximumPages} trang; hãy chia tài liệu thành các tệp nhỏ hơn trước khi tải lên.`);
  }

  if (pageCount <= batchPages) {
    const compressedBytes = await source.save({ useObjectStreams: true });
    return [{
      firstPage: 1,
      lastPage: pageCount,
      base64Data: uint8ArrayToBase64(compressedBytes),
    }];
  }

  const batches: PdfPageBatch[] = [];
  for (let firstIndex = 0; firstIndex < pageCount; firstIndex += batchPages) {
    const indices = Array.from(
      { length: Math.min(batchPages, pageCount - firstIndex) },
      (_, offset) => firstIndex + offset,
    );
    const batch = await PDFDocument.create();
    const copiedPages = await batch.copyPages(source, indices);
    copiedPages.forEach((page) => batch.addPage(page));
    const bytes = await batch.save({ useObjectStreams: true });
    batches.push({
      firstPage: firstIndex + 1,
      lastPage: firstIndex + indices.length,
      base64Data: uint8ArrayToBase64(bytes),
    });
  }
  return batches;
}

/**
 * Kế hoạch OCR PDF ưu tiên truyền NGUYÊN FILE (whole-PDF) để giữ toàn bộ ngữ cảnh xuyên trang
 * (tên bệnh nhân, ngày khám, chẩn đoán, chỉ số, kết luận cuối sổ).
 * Chỉ tự động chia thành số chunk tối thiểu nếu vượt ngưỡng payload/trang của Gemini inlineData.
 */
export async function planPdfOcrBatches(
  base64Data: string,
  options: {
    maximumPages?: number;
    wholePdfMaxPages?: number;
    wholePdfMaxBase64Chars?: number;
  } = {},
): Promise<{
  mode: 'whole_file' | 'chunked';
  totalPages: number;
  batches: PdfPageBatch[];
}> {
  const maximumPages = options.maximumPages ?? 100;
  const wholePdfMaxPages = options.wholePdfMaxPages ?? WHOLE_PDF_MAX_PAGES;
  const wholePdfMaxBase64Chars = options.wholePdfMaxBase64Chars ?? WHOLE_PDF_MAX_BASE64_CHARS;

  let source: PDFDocument;
  try {
    source = await PDFDocument.load(base64ToUint8Array(base64Data), { ignoreEncryption: true });
  } catch (error) {
    console.error('[PDF Plan Error]:', error);
    throw new PdfPageBatchError('Không đọc được PDF. Tệp có thể bị hỏng hoặc được bảo vệ mật khẩu nâng cao.', { cause: error });
  }

  const pageCount = source.getPageCount();
  if (pageCount === 0) throw new PdfPageBatchError('PDF không có trang để số hóa.');
  if (pageCount > maximumPages) {
    throw new PdfPageBatchError(`PDF có hơn ${maximumPages} trang; hãy chia tài liệu thành các tệp nhỏ hơn trước khi tải lên.`);
  }

  if (pageCount <= wholePdfMaxPages && base64Data.length <= wholePdfMaxBase64Chars) {
    console.info(`[OCR] PDF ${pageCount} pages (${(base64Data.length / 1024 / 1024).toFixed(2)} MB b64): sending WHOLE PDF for full cross-page context.`);
    return {
      mode: 'whole_file',
      totalPages: pageCount,
      batches: [{
        firstPage: 1,
        lastPage: pageCount,
        base64Data,
      }],
    };
  }

  // Oversized PDF: split into the minimum number of context-preserving chunks that stay comfortably under the inline limit.
  const minChunksBySize = Math.max(1, Math.ceil(base64Data.length / (wholePdfMaxBase64Chars * 0.75)));
  const minChunksByPages = Math.max(1, Math.ceil(pageCount / FALLBACK_MAX_BATCH_PAGES));
  const chunkCount = Math.max(2, minChunksBySize, minChunksByPages);
  const optimalBatchPages = Math.max(2, Math.ceil(pageCount / chunkCount));
  console.info(`[OCR] PDF ${pageCount} pages exceeds whole-PDF inline threshold; splitting into ~${optimalBatchPages}-page context chunks.`);
  const batches = await splitPdfIntoBatches(base64Data, optimalBatchPages, maximumPages);
  return {
    mode: 'chunked',
    totalPages: pageCount,
    batches,
  };
}

export function shouldFallbackToBatchedPdfOcr(error: unknown, totalPages: number): boolean {
  if (totalPages <= 1) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status =
    typeof error === 'object' && error !== null
      ? Number((error as Record<string, unknown>).status ?? (error as Record<string, unknown>).code ?? 0)
      : 0;
  return (
    status === 413 ||
    status === 504 ||
    /payload|too large|request size|DEADLINE_EXCEEDED|deadline|timeout|timed out|token|truncated|JSON|unterminated|unexpected end/i.test(message)
  );
}
