import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildMultiPageCameraPdf,
  finalizeCapturedCameraPages,
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
