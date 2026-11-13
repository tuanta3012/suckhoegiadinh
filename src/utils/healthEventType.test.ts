import { describe, expect, it } from 'vitest';
import {
  classifyHealthEventType,
  cleanHospitalizationRecord,
  hasMeaningfulHospitalization,
} from './healthEventType';

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

  it('does not misclassify lab reports with an empty hospitalization object as discharge', () => {
    expect(classifyHealthEventType({
      title: 'Kết quả xét nghiệm',
      type: 'discharge',
      facility: 'Công ty TNHH Lab Group International Vietnam - Medical Diag Center',
      hospitalization: {},
      metrics: [{ name: 'Glucose', value: 5.1, unit: 'mmol/L' }],
    }, '26020379765_vi.pdf')).toBe('test_result');
  });

  it('ignores placeholder hospitalization strings', () => {
    expect(hasMeaningfulHospitalization({
      department: 'Không có',
      treatmentSummary: 'N/A',
    })).toBe(false);
    expect(cleanHospitalizationRecord({
      department: 'Nội tổng hợp',
      dischargeDate: '2026-08-10',
    })).toEqual({
      department: 'Nội tổng hợp',
      dischargeDate: '2026-08-10',
    });
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

  it('uses internal pageTexts header and body when title and filename are generic', () => {
    expect(classifyHealthEventType({
      title: 'Tài liệu y tế',
      pageTexts: ['PHIẾU KẾT QUẢ SIÊU ÂM DOPPLER TUYẾN GIÁP\nKết luận: Bình thường.'],
    }, 'scan001.pdf')).toBe('imaging');

    expect(classifyHealthEventType({
      title: 'Hồ sơ sức khỏe',
      pageTexts: ['MEDICAL DIAG CENTER\nKết quả tổng hợp'],
      metrics: [
        { name: 'WBC', value: 6.2, unit: 'G/L' },
        { name: 'RBC', value: 4.8, unit: 'T/L' },
      ],
    }, '26020551115_vi.pdf')).toBe('test_result');

    expect(classifyHealthEventType({
      title: 'Hồ sơ sức khỏe',
      pageTexts: ['SỔ KHÁM BỆNH\nKhám chuyên khoa nội'],
    }, 'scan002.pdf')).toBe('medical_report');
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

  it('classifies "Hồ sơ sức khỏe định kỳ năm 2026" as comprehensive_exam even if model guessed imaging', () => {
    expect(classifyHealthEventType({
      title: 'Hồ sơ sức khỏe định kỳ năm 2026',
      type: 'imaging',
      facility: 'Phòng khám Bệnh viện Đại học Y Dược 1',
      diagnoses: ['Đa polyp túi mật', 'Nang giáp keo hai thùy', 'Tăng acid uric máu', 'Đạm niệu (+)'],
      metrics: [
        { name: 'Định lượng Acid Uric', value: 933.88, unit: 'µmol/L' },
        { name: 'Tổng phân tích nước tiểu – PRO', value: 0.15, unit: 'G/L' },
      ],
      imagingResults: [{ modality: 'Siêu âm tuyến giáp', findings: 'Nang keo', conclusion: 'TIRADS 1' }],
    })).toBe('comprehensive_exam');
  });

  it('classifies multi-specialty dossiers without checkup keywords in title as comprehensive_exam', () => {
    expect(classifyHealthEventType({
      title: 'Kết quả khám bệnh tổng hợp',
      type: 'imaging',
      physicalExam: { bp_mmHg: '120/80', weight_kg: 68 },
      diagnoses: ['Tăng acid uric máu', 'Gan nhiễm mỡ'],
      metrics: [
        { name: 'Acid Uric', value: 520, unit: 'µmol/L' },
        { name: 'Cholesterol', value: 5.4, unit: 'mmol/L' },
      ],
      imagingResults: [{ modality: 'Siêu âm bụng', findings: '', conclusion: 'Gan nhiễm mỡ độ 1' }],
    })).toBe('comprehensive_exam');
  });

  it('keeps standalone lab slips with Z00.0 diagnosis as test_result', () => {
    expect(classifyHealthEventType({
      title: 'Phiếu kết quả xét nghiệm tổng quát',
      type: 'test_result',
      facility: 'Bệnh Viện Đại Học Y Dược TP.HCM - Phòng Khám Bệnh Viện Đại Học Y Dược 1',
      diagnoses: ['Z00.0 - Khám sức khỏe tổng quát'],
      metrics: [
        { name: 'HBsAb định lượng', value: 1000, unit: 'IU/L' },
        { name: 'Định lượng Acid Uric', value: 933.88, unit: 'µmol/L' },
      ],
    })).toBe('test_result');
  });
});
