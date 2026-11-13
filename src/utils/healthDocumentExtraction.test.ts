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

  it('keeps an OCR text index only when every page is represented', () => {
    const complete = mergeExtractedBatches([{
      firstPage: 3,
      lastPage: 4,
      extracted: { pageTexts: ['Trang ba có nội dung', 'Trang bốn có nội dung'] },
    }]);
    expect(complete.contentIndexComplete).toBe(true);
    expect(complete.contentIndexPages).toEqual(['Trang ba có nội dung', 'Trang bốn có nội dung']);

    const incomplete = mergeExtractedBatches([{
      firstPage: 1,
      lastPage: 2,
      extracted: { pageTexts: ['Chỉ trang một có nội dung'] },
    }]);
    expect(incomplete.contentIndexComplete).toBe(false);
    expect(incomplete.contentIndexPages).toEqual([]);
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

  it('ignores placeholder patientName/DOB in early batches and recovers name from pageTexts', () => {
    const mergedFromLaterBatch = mergeExtractedBatches([
      {
        firstPage: 1,
        lastPage: 3,
        extracted: {
          patientName: 'Không rõ',
          patientBirthDate: 'N/A',
          patientGender: 'Chưa rõ',
        },
      },
      {
        firstPage: 4,
        lastPage: 6,
        extracted: {
          patientName: 'Ông Trương Anh Tuấn (Nam)',
          patientBirthDate: '1984-05-10',
          patientGender: 'Nam',
        },
      },
    ]);

    expect(mergedFromLaterBatch.patientName).toBe('Trương Anh Tuấn');
    expect(mergedFromLaterBatch.patientBirthDate).toBe('1984-05-10');
    expect(mergedFromLaterBatch.patientGender).toBe('Nam');

    const recoveredFromText = mergeExtractedBatches([
      {
        firstPage: 1,
        lastPage: 2,
        extracted: {
          patientName: 'Bệnh nhân',
          pageTexts: ['PHIẾU XÉT NGHIỆM\nHọ và tên: Vũ Thị Tú Anh\nTuổi: 38'],
        },
      },
    ]);

    expect(recoveredFromText.patientName).toBe('Vũ Thị Tú Anh');
  });
});

