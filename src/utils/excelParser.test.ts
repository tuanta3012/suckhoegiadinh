import { describe, expect, it } from 'vitest';
import { getXLSX } from './excelParser';

describe('spreadsheet library compatibility', () => {
  it('reads and writes an XLSX workbook through the existing API', async () => {
    const XLSX = await getXLSX();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Ngân hàng', 'Tiền gốc'], ['SEA', 10_000_000]]),
      'Sổ tiết kiệm'
    );

    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
    const reopened = XLSX.read(buffer, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(reopened.Sheets['Sổ tiết kiệm'], { header: 1 });

    expect(rows).toEqual([['Ngân hàng', 'Tiền gốc'], ['SEA', 10_000_000]]);
  });
});
