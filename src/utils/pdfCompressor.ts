import { PDFDocument } from 'pdf-lib';

export interface PdfCompressResult {
  file: File;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  reductionPercent: number;
  totalPages: number;
}

/**
 * Client-side PDF stream & object compressor.
 * Runs directly in the browser/app before uploading to Google Drive or sending to OCR.
 */
export async function compressPdfIfNeeded(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<PdfCompressResult> {
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) {
    return {
      file,
      originalSizeBytes: file.size,
      compressedSizeBytes: file.size,
      reductionPercent: 0,
      totalPages: 1,
    };
  }

  const originalSizeBytes = file.size;
  const originalMb = (originalSizeBytes / (1024 * 1024)).toFixed(1);
  onProgress?.(`Đang tối ưu & nén tệp PDF "${file.name}" (${originalMb} MB)...`);

  let totalPages = 1;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    totalPages = pdfDoc.getPageCount();

    onProgress?.(`Đang nén các luồng đối tượng & hình ảnh trong PDF (${totalPages} trang)...`);
    const compressedBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const compressedBlob = new Blob([compressedBytes], { type: 'application/pdf' });
    const compressedSizeBytes = compressedBlob.size;

    let finalFile = file;
    if (compressedSizeBytes < originalSizeBytes) {
      finalFile = new File([compressedBlob], file.name, {
        type: 'application/pdf',
        lastModified: Date.now(),
      });
    }

    const reductionPercent =
      originalSizeBytes > 0
        ? Math.max(0, Math.round(((originalSizeBytes - finalFile.size) / originalSizeBytes) * 100))
        : 0;

    return {
      file: finalFile,
      originalSizeBytes,
      compressedSizeBytes: finalFile.size,
      reductionPercent,
      totalPages,
    };
  } catch (error) {
    console.warn('[PDF Client Compressor Warning]: Could not compress PDF client-side, using original.', error);
    return {
      file,
      originalSizeBytes,
      compressedSizeBytes: file.size,
      reductionPercent: 0,
      totalPages,
    };
  }
}
