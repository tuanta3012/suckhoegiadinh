import { PDFDocument } from 'pdf-lib';

export interface PdfPageBatch {
  firstPage: number;
  lastPage: number;
  base64Data: string;
}

export class PdfPageBatchError extends Error {}

export async function splitPdfIntoBatches(
  base64Data: string,
  batchPages = 3,
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
  if (pageCount === 0) throw new PdfPageBatchError('PDF không có trang để số hóa.');
  if (pageCount > maximumPages) {
    throw new PdfPageBatchError(`PDF có hơn ${maximumPages} trang; hãy chia tài liệu thành các tệp nhỏ hơn trước khi tải lên.`);
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
    const bytes = await batch.save();
    batches.push({
      firstPage: firstIndex + 1,
      lastPage: firstIndex + indices.length,
      base64Data: Buffer.from(bytes).toString('base64'),
    });
  }
  return batches;
}
