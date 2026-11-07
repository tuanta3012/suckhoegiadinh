import { PDFDocument } from 'pdf-lib';

export interface PdfPageBatch {
  firstPage: number;
  lastPage: number;
  base64Data: string;
}

export class PdfPageBatchError extends Error {}

/**
 * Accurately detects the exact number of pages in a PDF file from base64 or ArrayBuffer
 */
export async function getPdfPageCount(base64OrArrayBuffer: string | ArrayBuffer): Promise<number> {
  try {
    const buffer = typeof base64OrArrayBuffer === 'string'
      ? Buffer.from(base64OrArrayBuffer, 'base64')
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
  maximumPages = 60,
): Promise<PdfPageBatch[]> {
  if (!Number.isInteger(batchPages) || batchPages < 1) {
    throw new Error('PDF batch size must be a positive integer.');
  }
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(Buffer.from(base64Data, 'base64'));
  } catch (error) {
    throw new PdfPageBatchError('Không đọc được PDF. Tệp có thể bị hỏng hoặc được bảo vệ bằng mật khẩu.', { cause: error });
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
      base64Data: Buffer.from(compressedBytes).toString('base64'),
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
      base64Data: Buffer.from(bytes).toString('base64'),
    });
  }
  return batches;
}
