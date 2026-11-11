import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { splitPdfIntoBatches } from './pdfPageBatches';

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
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

describe('splitPdfIntoBatches', () => {
  it('splits a ten-page PDF into bounded sequential batches', async () => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 10; index++) source.addPage();

    const batches = await splitPdfIntoBatches(
      uint8ArrayToBase64(await source.save()),
      3,
    );

    expect(batches.map(({ firstPage, lastPage }) => [firstPage, lastPage])).toEqual([
      [1, 3],
      [4, 6],
      [7, 9],
      [10, 10],
    ]);
    const pageCounts = await Promise.all(batches.map(async (batch) => {
      const document = await PDFDocument.load(base64ToUint8Array(batch.base64Data), { ignoreEncryption: true });
      return document.getPageCount();
    }));
    expect(pageCounts).toEqual([3, 3, 3, 1]);
  });

  it('rejects PDFs that exceed the configured page limit', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    source.addPage();
    await expect(splitPdfIntoBatches(
      uint8ArrayToBase64(await source.save()),
      3,
      1,
    )).rejects.toThrow('hơn 1 trang');
  });
});
