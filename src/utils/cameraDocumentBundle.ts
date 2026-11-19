import { PDFDocument } from 'pdf-lib';
import type { DocumentScanMode, DocumentScanResult } from '../plugins/documentScanner';
import { compressImageIfNeeded } from './imageCompressor';

export interface CapturedPageItem {
  id: string;
  file: File;
  previewUrl: string;
}

export interface QuickActionTargetInfo {
  isAutoDetect: boolean;
  label: string;
}

export function resolveQuickActionTargetLabel(
  pickedMemberId: string | undefined,
  members: Array<{ id: string; name: string }>,
): QuickActionTargetInfo {
  if (!pickedMemberId) {
    return {
      isAutoDetect: true,
      label: 'Tự động nhận diện',
    };
  }
  const matchedMember = members.find((member) => member.id === pickedMemberId);
  if (!matchedMember) {
    return {
      isAutoDetect: true,
      label: 'Tự động nhận diện',
    };
  }
  return {
    isAutoDetect: false,
    label: matchedMember.name,
  };
}

export async function cameraPhotoToFile(
  photo: { webPath?: string; format?: string },
  pageIndex?: number,
): Promise<File> {
  if (!photo.webPath) {
    throw new Error('Không nhận được đường dẫn ảnh từ camera.');
  }
  const response = await fetch(photo.webPath);
  if (!response.ok) {
    throw new Error('Không đọc được ảnh chụp từ camera.');
  }
  const blob = await response.blob();
  const ext = (photo.format || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const datePart = new Date().toISOString().slice(0, 10);
  const pageSuffix = typeof pageIndex === 'number' ? `-trang${pageIndex}` : '';
  const uniqueSuffix = Date.now().toString().slice(-4);
  const mimeType = blob.type && blob.type.startsWith('image/')
    ? blob.type
    : ext === 'png'
    ? 'image/png'
    : 'image/jpeg';

  return new File([blob], `kham-benh-${datePart}${pageSuffix}-${uniqueSuffix}.${ext}`, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

function isPngBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function convertImageFileToJpeg(file: File, quality = 0.88): Promise<File> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return file;
  }
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width || 1;
      canvas.height = img.height || 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(file);
        return;
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          resolve(
            new File([blob], file.name.replace(/\.[^/.]+$/, '.jpg'), {
              type: 'image/jpeg',
              lastModified: Date.now(),
            }),
          );
        },
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

export async function buildMultiPageCameraPdf(
  files: File[],
  options?: { dateStr?: string },
): Promise<File> {
  if (files.length === 0) {
    throw new Error('Chưa có trang ảnh nào để gộp thành PDF.');
  }

  const pdfDoc = await PDFDocument.create();

  for (const rawFile of files) {
    let prepared = await compressImageIfNeeded(rawFile, 1800, 0.86);
    let bytes = new Uint8Array(await prepared.arrayBuffer());

    if (!isJpegBytes(bytes) && !isPngBytes(bytes)) {
      prepared = await convertImageFileToJpeg(prepared, 0.86);
      bytes = new Uint8Array(await prepared.arrayBuffer());
    }

    const embeddedImage = isPngBytes(bytes)
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);

    const width = Math.max(1, embeddedImage.width);
    const height = Math.max(1, embeddedImage.height);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width,
      height,
    });
  }

  const pdfBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  const datePart = options?.dateStr || new Date().toISOString().slice(0, 10);
  const uniqueSuffix = Date.now().toString().slice(-4);
  const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

  return new File([pdfBlob], `kham-benh-${datePart}-${files.length}trang-${uniqueSuffix}.pdf`, {
    type: 'application/pdf',
    lastModified: Date.now(),
  });
}

export async function finalizeCapturedCameraPages(
  files: File[],
  mode: 'single' | 'multi',
): Promise<File> {
  if (files.length === 0) {
    throw new Error('Chưa có ảnh chụp nào để xử lý.');
  }
  if (mode === 'single' || files.length === 1) {
    return compressImageIfNeeded(files[0], 1800, 0.88);
  }
  return buildMultiPageCameraPdf(files);
}

export async function processMlKitScanResultToFile(
  result: DocumentScanResult,
  requestedMode: DocumentScanMode,
  fetchUri: (uri: string) => Promise<Blob> = async (uri) => {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error('Không đọc được tệp tài liệu sau khi quét.');
    }
    return response.blob();
  },
): Promise<File> {
  const mode: DocumentScanMode = result.mode || requestedMode;
  const datePart = new Date().toISOString().slice(0, 10);
  const uniqueSuffix = Date.now().toString().slice(-4);
  const pages = (result.pages || []).filter((page) => Boolean(page?.webPath || page?.path));

  const useCompiledPdf =
    Boolean(result.pdf?.webPath || result.pdf?.path) &&
    ((mode === 'multi' && (result.pdf?.pageCount ?? pages.length) >= 2) || pages.length === 0);

  if (useCompiledPdf && result.pdf) {
    const pdfUri = result.pdf.webPath || result.pdf.path!;
    const pdfBlob = await fetchUri(pdfUri);
    const pageCount = Math.max(1, result.pdf.pageCount || pages.length || 1);
    return new File([pdfBlob], `kham-benh-${datePart}-${pageCount}trang-${uniqueSuffix}.pdf`, {
      type: 'application/pdf',
      lastModified: Date.now(),
    });
  }

  if (pages.length === 0) {
    throw new Error('Không nhận được trang tài liệu nào từ máy quét.');
  }

  const pageFiles: File[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageUri = page.webPath || page.path!;
    const blob = await fetchUri(pageUri);
    const ext = (page.format || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const mimeType = blob.type && blob.type.startsWith('image/')
      ? blob.type
      : ext === 'png'
      ? 'image/png'
      : 'image/jpeg';
    pageFiles.push(
      new File([blob], `kham-benh-${datePart}-trang${i + 1}-${uniqueSuffix}.${ext}`, {
        type: mimeType,
        lastModified: Date.now(),
      }),
    );
  }

  return finalizeCapturedCameraPages(pageFiles, mode);
}
