import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildMultiPageCameraPdf,
  finalizeCapturedCameraPages,
  processMlKitScanResultToFile,
  resolveQuickActionTargetLabel,
} from './cameraDocumentBundle';

// Minimal valid 1x1 PNG (68 bytes)
const TINY_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
  0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

function createSamplePngFile(name: string): File {
  return new File([TINY_PNG_BYTES], name, { type: 'image/png' });
}

describe('cameraDocumentBundle', () => {
  it('merges multiple captured images into a single multi-page PDF', async () => {
    const pages = [
      createSamplePngFile('page-1.png'),
      createSamplePngFile('page-2.png'),
      createSamplePngFile('page-3.png'),
    ];

    const pdfFile = await buildMultiPageCameraPdf(pages, { dateStr: '2026-11-18' });

    expect(pdfFile.type).toBe('application/pdf');
    expect(pdfFile.name).toMatch(/^kham-benh-2026-11-18-3trang-\d+\.pdf$/);

    const parsedPdf = await PDFDocument.load(new Uint8Array(await pdfFile.arrayBuffer()));
    expect(parsedPdf.getPageCount()).toBe(3);
  });

  it('keeps single-shot or 1-page capture as a single image file and bundles 2+ pages as PDF', async () => {
    const singleFile = createSamplePngFile('single.png');
    const finalizedSingle = await finalizeCapturedCameraPages([singleFile], 'single');
    expect(finalizedSingle.type).toBe('image/png');
    expect(finalizedSingle.name).toBe('single.png');

    const finalizedMultiOnePage = await finalizeCapturedCameraPages([singleFile], 'multi');
    expect(finalizedMultiOnePage.type).toBe('image/png');

    const finalizedMultiThreePages = await finalizeCapturedCameraPages(
      [
        createSamplePngFile('p1.png'),
        createSamplePngFile('p2.png'),
      ],
      'multi',
    );
    expect(finalizedMultiThreePages.type).toBe('application/pdf');
    const parsedPdf = await PDFDocument.load(
      new Uint8Array(await finalizedMultiThreePages.arrayBuffer()),
    );
    expect(parsedPdf.getPageCount()).toBe(2);
  });

  it('throws when trying to finalize an empty page list', async () => {
    await expect(finalizeCapturedCameraPages([], 'multi')).rejects.toThrow();
  });

  it('processes ML Kit single-page scan as cropped image and multi-page scan as compiled PDF', async () => {
    const samplePdf = await PDFDocument.create();
    samplePdf.addPage([200, 300]);
    samplePdf.addPage([200, 300]);
    const samplePdfBytes = await samplePdf.save();

    const singleFile = await processMlKitScanResultToFile(
      {
        mode: 'single',
        pages: [{ webPath: 'https://localhost/_capacitor_file_/p1.jpg', format: 'jpeg' }],
        pdf: { webPath: 'https://localhost/_capacitor_file_/doc.pdf', pageCount: 1 },
      },
      'single',
      async (uri) =>
        uri.endsWith('.pdf')
          ? new Blob([samplePdfBytes], { type: 'application/pdf' })
          : new Blob([TINY_PNG_BYTES], { type: 'image/png' }),
    );
    expect(singleFile.type).toBe('image/png');

    const multiPdfFile = await processMlKitScanResultToFile(
      {
        mode: 'multi',
        pages: [
          { webPath: 'https://localhost/_capacitor_file_/p1.jpg', format: 'jpeg' },
          { webPath: 'https://localhost/_capacitor_file_/p2.jpg', format: 'jpeg' },
        ],
        pdf: { webPath: 'https://localhost/_capacitor_file_/doc.pdf', pageCount: 2 },
      },
      'multi',
      async (uri) =>
        uri.endsWith('.pdf')
          ? new Blob([samplePdfBytes], { type: 'application/pdf' })
          : new Blob([TINY_PNG_BYTES], { type: 'image/png' }),
    );
    expect(multiPdfFile.type).toBe('application/pdf');
    expect(multiPdfFile.name).toMatch(/-2trang-\d+\.pdf$/);

    const multiFallbackPdf = await processMlKitScanResultToFile(
      {
        mode: 'multi',
        pages: [
          { webPath: 'https://localhost/_capacitor_file_/p1.png', format: 'png' },
          { webPath: 'https://localhost/_capacitor_file_/p2.png', format: 'png' },
        ],
      },
      'multi',
      async () => new Blob([TINY_PNG_BYTES], { type: 'image/png' }),
    );
    expect(multiFallbackPdf.type).toBe('application/pdf');
    const parsedFallback = await PDFDocument.load(
      new Uint8Array(await multiFallbackPdf.arrayBuffer()),
    );
    expect(parsedFallback.getPageCount()).toBe(2);
  });

  it('resolves auto-detect vs explicit member label accurately for the input modal', () => {
    const members = [
      { id: 'member_1', name: 'Trương Quang Minh' },
      { id: 'member_2', name: 'Vũ Thị Tú Anh' },
    ];

    expect(resolveQuickActionTargetLabel(undefined, members)).toEqual({
      isAutoDetect: true,
      label: 'Tự động nhận diện',
    });

    expect(resolveQuickActionTargetLabel('member_2', members)).toEqual({
      isAutoDetect: false,
      label: 'Vũ Thị Tú Anh',
    });

    expect(resolveQuickActionTargetLabel('missing_id', members)).toEqual({
      isAutoDetect: true,
      label: 'Tự động nhận diện',
    });
  });
});
