import { describe, expect, it } from 'vitest';
import { mergeExtractedBatches } from './healthDocumentExtraction';

describe('mergeExtractedBatches', () => {
  it('normalizes supplied standard keys to stable canonical names', () => {
    const merged = mergeExtractedBatches([{
      firstPage: 1,
      lastPage: 1,
      extracted: {
        metrics: [
          { name: 'Đường huyết', standardKey: 'blood glucose', value: 5.2, unit: 'mmol/L' },
          { name: 'Đường huyết', standardKey: 'GLUCOSE', value: 6.1, unit: 'mmol/L' },
          { name: 'HbA1c', standardKey: 'hba1c', value: 6, unit: '%' },
        ],
      },
    }]);

    expect(merged.metrics).toEqual([
      { name: 'Đường huyết', standardKey: 'GLUCOSE', value: 5.2, unit: 'mmol/L' },
      { name: 'HbA1c', standardKey: 'HBA1C', value: 6, unit: '%' },
    ]);
  });

  it('merges page data, removes duplicates, and retains page provenance', () => {
    const merged = mergeExtractedBatches([
      {
        firstPage: 1,
        lastPage: 3,
        extracted: {
          title: 'Kết quả khám',
          date: '2026-10-10',
          diagnoses: ['Viêm họng', ' viêm họng.'],
          medications: [{ name: 'Thuốc A 10 mg', dosage: '1 viên' }],
          metrics: [{ name: 'Huyết áp', value: 120, unit: 'mmHg' }],
          notes: 'Trang đầu.',
          advice: 'Tái khám sau một tuần.',
        },
      },
      {
        firstPage: 4,
        lastPage: 6,
        extracted: {
          diagnoses: ['Viêm họng', 'Sốt'],
          medications: [{ name: 'Thuốc A 20 mg', frequency: '2 lần/ngày' }],
          metrics: [{ name: 'Nhiệt độ', value: 38, unit: '°C' }],
          advice: 'Uống đủ nước.',
        },
      },
    ]);

    expect(merged.diagnoses).toEqual(['Viêm họng', 'Sốt']);
    expect(merged.medications).toHaveLength(1);
    expect(merged.medications).toEqual([
      { name: 'Thuốc A 10 mg', dosage: '1 viên', frequency: '2 lần/ngày', duration: undefined },
    ]);
    expect(merged.metrics).toHaveLength(2);
    expect(merged.notes).toContain('Trang đầu.');
    expect(merged.advice).toBe('Tái khám sau một tuần.\nUống đủ nước.');
  });

  it('uses the document title and filename to correct a conflicting model type', () => {
    const merged = mergeExtractedBatches([{
      firstPage: 1,
      lastPage: 4,
      extracted: {
        title: 'Khám sức khỏe định kỳ năm 2026',
        type: 'test_result',
        metrics: [{ name: 'Creatinin', value: 77.5, unit: 'µmol/L' }],
      },
    }], undefined, 'kham-suc-khoe-2026.pdf');

    expect(merged.type).toBe('comprehensive_exam');
  });
});
