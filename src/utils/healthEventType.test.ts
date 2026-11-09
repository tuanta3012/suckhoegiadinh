import { describe, expect, it } from 'vitest';
import { classifyHealthEventType } from './healthEventType';

describe('classifyHealthEventType', () => {
  it('classifies a periodic health examination as comprehensive despite attached lab results', () => {
    expect(classifyHealthEventType({
      title: 'Khám sức khỏe định kỳ năm 2026',
      type: 'test_result',
      metrics: [{ name: 'Creatinin', value: 77.5, unit: 'µmol/L' }],
      imagingResults: [{ modality: 'Siêu âm', findings: '', conclusion: 'Không ghi nhận bất thường.' }],
    }, 'tuanta 2026.pdf')).toBe('comprehensive_exam');
  });

  it('classifies stand-alone laboratory reports from their Vietnamese title', () => {
    expect(classifyHealthEventType({
      title: 'Kết quả xét nghiệm tổng quát',
      metrics: [{ name: 'Creatinin', value: 77.5, unit: 'µmol/L' }],
    })).toBe('test_result');
  });

  it.each([
    ['Phieu tiem chung vac xin', 'vaccination'],
    ['Đơn thuốc điều trị ngoại trú', 'prescription'],
    ['Giấy ra viện', 'discharge'],
    ['Kết quả siêu âm ổ bụng', 'imaging'],
    ['Phiếu khám bệnh', 'medical_report'],
  ] as const)('classifies document title "%s"', (title, expected) => {
    expect(classifyHealthEventType({ title })).toBe(expected);
  });

  it('uses the document filename when the extracted title is generic', () => {
    expect(classifyHealthEventType({
      title: 'Kết quả tổng quát',
      metrics: [{ name: 'Creatinin', value: 77.5, unit: 'µmol/L' }],
    }, 'phieu-xet-nghiem-mau.pdf')).toBe('test_result');
  });

  it('preserves a supported model classification when no stronger document clues exist', () => {
    expect(classifyHealthEventType({ title: 'Hồ sơ y tế', type: 'vaccination' })).toBe('vaccination');
  });
});
