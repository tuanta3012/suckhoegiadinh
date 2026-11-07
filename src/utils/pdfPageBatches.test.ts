import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { splitPdfIntoBatches } from './pdfPageBatches';

describe('splitPdfIntoBatches', () => {
  it('splits a ten-page PDF into bounded sequential batches', async () => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 10; index++) source.addPage();

    const batches = await splitPdfIntoBatches(
      Buffer.from(await source.save()).toString('base64'),
      3,
    );

    expect(batches.map(({ firstPage, lastPage }) => [firstPage, lastPage])).toEqual([
      [1, 3],
      [4, 6],
      [7, 9],
      [10, 10],
    ]);
    const pageCounts = await Promise.all(batches.map(async (batch) => {
      const document = await PDFDocument.load(Buffer.from(batch.base64Data, 'base64'));
      return document.getPageCount();
    }));
    expect(pageCounts).toEqual([3, 3, 3, 1]);
  });

  it('rejects PDFs that exceed the configured page limit', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    source.addPage();
    await expect(splitPdfIntoBatches(
      Buffer.from(await source.save()).toString('base64'),
      3,
      1,
    )).rejects.toThrow('hơn 1 trang');
  });
});
