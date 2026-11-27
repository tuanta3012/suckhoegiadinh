import { describe, expect, it } from 'vitest';
import type { HealthEvent } from '../types';
import {
  doesMetricMatchTimelineKeyword,
  filterTimelineEvents,
  matchesTimelineKeyword,
  splitTextWithHighlights,
} from './healthTimelineFilter';

const TYPE_LABELS: Record<string, string> = {
  comprehensive_exam: 'Khám tổng quát',
  medical_report: 'Khám bệnh',
  prescription: 'Đơn thuốc',
  test_result: 'Xét nghiệm',
  imaging: 'Chẩn đoán hình ảnh',
  vaccination: 'Tiêm chủng',
  discharge: 'Ra viện',
  other: 'Khác',
};

const SAMPLE_EVENTS: HealthEvent[] = [
  {
    id: 'ev-1',
    sourceFileId: 'f1',
    sourceFileName: 'xet_nghiem_mau_2026.pdf',
    type: 'test_result',
    title: 'Xét nghiệm sinh hóa máu & miễn dịch',
    date: '2026-06-11',
    facility: 'Bệnh viện Đa khoa Tâm Anh',
    doctorName: 'Nguyễn Văn Hùng',
    patientName: 'Trương Anh Tuấn',
    diagnoses: ['Tăng acid uric máu', 'Theo dõi chức năng tuyến giáp'],
    medications: [],
    metrics: [
      {
        name: 'Acid Uric',
        standardKey: 'uric_acid',
        value: 933.88,
        unit: 'µmol/L',
        refRange: '208 - 428',
        status: 'warning_high',
      },
      {
        name: 'HbA1c',
        standardKey: 'hba1c',
        value: 5.4,
        unit: '%',
        refRange: '4.0 - 5.7',
        status: 'normal',
      },
    ],
    extractedData: {
      nhomMau: 'O Rh+',
    },
    recordedAt: '2026-06-11T08:00:00Z',
  },
  {
    id: 'ev-2',
    sourceFileId: 'f2',
    sourceFileName: 'sieu_am_tuyen_giap.jpg',
    type: 'imaging',
    title: 'Siêu âm tuyến giáp và ổ bụng',
    date: '2025-05-30',
    facility: 'Bệnh viện Đại học Y dược',
    patientName: 'Trương Anh Tuấn',
    diagnoses: ['Đa polyp túi mật', 'Rối loạn chức năng tâm trương thất trái', 'Nốt tuyến giáp TI-RADS 1'],
    medications: [
      {
        name: 'Levothyroxine 50mcg',
        dosage: '1 viên/ngày',
        timing: 'Trước ăn sáng 30 phút',
      },
    ],
    metrics: [],
    imagingResults: [
      {
        modality: 'Siêu âm tuyến giáp',
        findings: 'Nốt thùy phải dmax 5x5 mm, lành tính',
        conclusion: 'TI-RADS 1 lành tính',
      },
    ],
    nextFollowUp: '2026-05-30',
    recordedAt: '2025-05-30T09:00:00Z',
  },
];

describe('healthTimelineFilter', () => {
  it('matches Vietnamese queries regardless of tone marks and case', () => {
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], 'tam anh', { typeLabel: TYPE_LABELS.test_result })).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], 'Tuyến Giáp')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], 'nhom mau O')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'dai hoc y duoc', { typeLabel: TYPE_LABELS.imaging })).toBe(true);
  });

  it('does NOT falsely match "tam anh" on unrelated facility events containing scattered "tâm" + "ảnh"/"lành"/"Anh"', () => {
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'tam anh', { typeLabel: TYPE_LABELS.imaging })).toBe(false);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'benh vien tam anh', { typeLabel: TYPE_LABELS.imaging })).toBe(false);
  });

  it('combines multi-word phrases and standalone tokens accurately across fields', () => {
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], 'acid uric 2026')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], 'acid uric 2025')).toBe(false);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'polyp dai hoc y duoc')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'tuyen giap, dai hoc y duoc')).toBe(true);
  });

  it('matches formatted VN dates, decimals with comma or dot, and medications/imaging', () => {
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], '11/06/2026')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], '5,4')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'levothyroxine')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'TI-RADS 1')).toBe(true);
  });

  it('supports semantic keywords for abnormal metrics and follow-ups', () => {
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[0], 'bat thuong')).toBe(true);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'bat thuong')).toBe(false);
    expect(matchesTimelineKeyword(SAMPLE_EVENTS[1], 'tai kham')).toBe(true);
  });

  it('combines keyword filtering and event type filtering accurately', () => {
    const resultAll = filterTimelineEvents(SAMPLE_EVENTS, {
      typeFilter: 'all',
      keyword: 'tuyen giap',
      typeLabelMap: TYPE_LABELS,
    });
    expect(resultAll.keywordMatched).toHaveLength(2);
    expect(resultAll.filtered).toHaveLength(2);

    const resultImaging = filterTimelineEvents(SAMPLE_EVENTS, {
      typeFilter: 'imaging',
      keyword: 'tuyen giap',
      typeLabelMap: TYPE_LABELS,
    });
    expect(resultImaging.keywordMatched).toHaveLength(2);
    expect(resultImaging.filtered).toHaveLength(1);
    expect(resultImaging.filtered[0].id).toBe('ev-2');
  });

  it('splits text into highlighted segments preserving Vietnamese diacritics and phrase boundaries', () => {
    expect(splitTextWithHighlights('Bệnh viện Đa khoa Tâm Anh', 'tam anh')).toEqual([
      { text: 'Bệnh viện Đa khoa ', highlighted: false },
      { text: 'Tâm Anh', highlighted: true },
    ]);

    // Isolated "tâm" or "ảnh" should NOT be highlighted when searching phrase "tam anh"
    expect(
      splitTextWithHighlights('Rối loạn tâm trương & Chẩn đoán hình ảnh', 'tam anh'),
    ).toEqual([
      { text: 'Rối loạn tâm trương & Chẩn đoán hình ảnh', highlighted: false },
    ]);

    // Multiple clauses & comma decimal highlighting
    expect(splitTextWithHighlights('HbA1c: 5.4 % (tuyến giáp)', 'tuyen giap, 5,4')).toEqual([
      { text: 'HbA1c: ', highlighted: false },
      { text: '5.4', highlighted: true },
      { text: ' % (', highlighted: false },
      { text: 'tuyến giáp', highlighted: true },
      { text: ')', highlighted: false },
    ]);
  });

  it('detects individual metric keyword matches for auto-expanding normal metrics', () => {
    const hba1c = SAMPLE_EVENTS[0].metrics[1];
    expect(doesMetricMatchTimelineKeyword(hba1c, 'hba1c')).toBe(true);
    expect(doesMetricMatchTimelineKeyword(hba1c, '5,4')).toBe(true);
    expect(doesMetricMatchTimelineKeyword(hba1c, 'uric')).toBe(false);
  });
});
