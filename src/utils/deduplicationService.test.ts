import { describe, it, expect } from 'vitest';
import {
  cleanAndDeduplicateEventData,
  compareStructuredEventContainment,
  consolidateTimelineEvents,
  detectDuplicateEvent,
  detectDuplicateFile,
  mergeHealthEvents,
  normalizeMedicalText,
  normalizeMedicationName,
  normalizeMetricName,
} from './deduplicationService';
import type { HealthEvent, HealthProfile } from '../types';

describe('Deduplication Service', () => {
  describe('Text Normalization', () => {
    it('normalizes medical text correctly', () => {
      expect(normalizeMedicalText('Viêm Họng Cấp.')).toBe('viêm họng cấp');
      expect(normalizeMedicalText('  Tăng  huyết áp:   ')).toBe('tăng huyết áp');
    });

    it('normalizes medication names stripping dosage suffixes', () => {
      expect(normalizeMedicationName('Amlodipin 5mg')).toBe('amlodipin');
      expect(normalizeMedicationName('Panadol Extra 500mg')).toBe('panadol extra');
      expect(normalizeMedicationName('Augmentin 1g')).toBe('augmentin');
    });

    it('normalizes metric names', () => {
      expect(normalizeMetricName('HA tâm thu')).toBe('huyết áp tâm thu');
      expect(normalizeMetricName('Huyết Áp Tâm Trương')).toBe('huyết áp tâm trương');
      expect(normalizeMetricName('Đường huyết mao mạch')).toContain('đường huyết');
    });
  });

  describe('Inner-event Deduplication', () => {
    it('removes duplicate diagnoses within an event', () => {
      const event: Partial<HealthEvent> = {
        diagnoses: ['Viêm phế quản cấp', 'viêm phế quản cấp.', 'Tăng huyết áp', 'Tăng huyết áp'],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.diagnoses).toHaveLength(2);
      expect(cleaned.diagnoses).toEqual(['Viêm phế quản cấp', 'Tăng huyết áp']);
    });

    it('removes duplicate medications, keeping richer details', () => {
      const event: Partial<HealthEvent> = {
        medications: [
          { name: 'Amlodipin', dosage: '5mg' },
          { name: 'Amlodipin 5mg', dosage: '5mg', frequency: '1 viên sáng', duration: '30 ngày' },
        ],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.medications).toHaveLength(1);
      expect(cleaned.medications![0].frequency).toBe('1 viên sáng');
      expect(cleaned.medications![0].duration).toBe('30 ngày');
    });

    it('removes duplicate metrics', () => {
      const event: Partial<HealthEvent> = {
        metrics: [
          { name: 'Huyết áp tâm thu', value: 120, unit: 'mmHg' },
          { name: 'HA tâm thu', value: 125, unit: 'mmHg' },
        ],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.metrics).toHaveLength(1);
      expect(cleaned.metrics![0].value).toBe(120);
    });
  });

  describe('Document / File Duplicate Detection', () => {
    const mockProfile: HealthProfile = {
      schemaVersion: 1,
      member: {
        id: 'mem_1',
        name: 'Nguyễn Văn A',
        driveFolderId: 'folder_1',
        profileFileId: 'prof_1',
      },
      timeline: [
        {
          id: 'ev_1',
          sourceFileId: 'file_drive_1',
          sourceFileName: 'don-thuoc-tai-mui-hong.pdf',
          type: 'prescription',
          title: 'Khám tai mũi họng',
          date: '2026-03-10',
          diagnoses: ['Viêm tai giữa'],
          medications: [],
          metrics: [],
          recordedAt: '2026-03-10T08:00:00Z',
        },
      ],
      sources: [
        {
          driveFileId: 'file_drive_1',
          fileName: 'don-thuoc-tai-mui-hong.pdf',
          fileSize: 102400,
          fileHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          mimeType: 'application/pdf',
          uploadedAt: '2026-03-10T08:00:00Z',
          status: 'processed',
        },
      ],
      summary: { latestDiagnoses: [], latestMetrics: {} },
      createdAt: '2026-03-10T08:00:00Z',
      updatedAt: '2026-03-10T08:00:00Z',
    };

    it('detects duplicate file by matching hash and size', () => {
      const match = detectDuplicateFile(
        { name: 'don-thuoc-tai-mui-hong.pdf', size: 102400 },
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        mockProfile
      );
      expect(match).not.toBeNull();
      expect(match?.isExactContentMatch).toBe(true);
      expect(match?.linkedEvent?.title).toBe('Khám tai mũi họng');
    });

    it('returns null for non-duplicate file', () => {
      const match = detectDuplicateFile(
        { name: 'xet-nghiem-mau.pdf', size: 204800 },
        'different_hash_987654321',
        mockProfile
      );
      expect(match).toBeNull();
    });

    it('does not treat a matching filename as proof of duplicate content', () => {
      const match = detectDuplicateFile(
        { name: 'don-thuoc-tai-mui-hong.pdf', size: 102400 },
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        mockProfile,
      );
      expect(match).toBeNull();
    });
  });

  describe('Event Duplicate Detection & Smart Merge', () => {
    const existingTimeline: HealthEvent[] = [
      {
        id: 'ev_main_1',
        sourceFileId: 'file_1',
        sourceFileName: 'kham-benh.pdf',
        type: 'medical_report',
        title: 'Khám tim mạch định kỳ',
        date: '2026-03-15',
        facility: 'Bệnh viện Bạch Mai',
        diagnoses: ['Tăng huyết áp'],
        medications: [{ name: 'Amlodipin', dosage: '5mg' }],
        metrics: [{ name: 'Huyết áp tâm thu', value: 130, unit: 'mmHg' }],
        recordedAt: '2026-03-15T09:00:00Z',
      },
    ];

    it('detects duplicate event on same date and same facility with overlapping diagnoses', () => {
      const incoming: Partial<HealthEvent> = {
        date: '2026-03-15',
        facility: 'Bệnh viện Bạch Mai',
        type: 'medical_report',
        diagnoses: ['Tăng huyết áp', 'Rối loạn lipid máu'],
      };

      const match = detectDuplicateEvent(existingTimeline, incoming);
      expect(match).not.toBeNull();
      expect(match?.confidence).toBe('high');
      expect(match?.matchedEvent.id).toBe('ev_main_1');
      expect(match?.reasons.some((r) => r.includes('Bạch Mai'))).toBe(true);
    });

    it('does not flag duplicate if dates are different', () => {
      const incoming: Partial<HealthEvent> = {
        date: '2026-04-20',
        facility: 'Bệnh viện Bạch Mai',
        diagnoses: ['Tăng huyết áp'],
      };

      const match = detectDuplicateEvent(existingTimeline, incoming);
      expect(match).toBeNull();
    });

    it('merges two health events without duplicating diagnoses or medications', () => {
      const incoming: HealthEvent = {
        id: 'ev_incoming_2',
        sourceFileId: 'file_2',
        sourceFileName: 'xet-nghiem-them.pdf',
        type: 'test_result',
        title: 'Bổ sung kết quả mỡ máu',
        date: '2026-03-15',
        facility: 'Bệnh viện Bạch Mai',
        diagnoses: ['Tăng huyết áp', 'Rối loạn lipid máu'],
        medications: [
          { name: 'Amlodipin', dosage: '5mg', frequency: '1 viên sáng' },
          { name: 'Atorvastatin', dosage: '20mg' },
        ],
        metrics: [{ name: 'Cholesterol toàn phần', value: 5.6, unit: 'mmol/L' }],
        advice: 'Tập thể dục đều đặn',
        recordedAt: '2026-03-15T11:00:00Z',
      };

      const merged = mergeHealthEvents(existingTimeline[0], incoming);
      expect(merged.diagnoses).toHaveLength(2);
      expect(merged.diagnoses).toContain('Tăng huyết áp');
      expect(merged.diagnoses).toContain('Rối loạn lipid máu');

      expect(merged.medications).toHaveLength(2);
      const amlodipin = merged.medications.find((m) => m.name.includes('Amlodipin'));
      expect(amlodipin?.frequency).toBe('1 viên sáng');

      expect(merged.metrics).toHaveLength(2);
      expect(merged.advice).toBe('Tập thể dục đều đặn');
    });

    it('identifies subset and equivalent structured clinical events on the same date', () => {
      const fullCheckup: Partial<HealthEvent> = {
        date: '2026-08-10',
        title: 'Khám sức khỏe định kỳ năm 2026',
        metrics: [
          { name: 'WBC', standardKey: 'WBC', value: 6.41, unit: 'G/L' },
          { name: 'Glucose', standardKey: 'GLUCOSE', value: 5.1, unit: 'mmol/L' },
          { name: 'Creatinin', standardKey: 'CREATININ', value: 78, unit: 'µmol/L' },
        ],
        imagingResults: [{ modality: 'Siêu âm ổ bụng', findings: '', conclusion: 'Bình thường' }],
      };
      const labSubset: Partial<HealthEvent> = {
        date: '2026-08-10',
        title: 'Kết quả xét nghiệm',
        metrics: [
          { name: 'WBC', standardKey: 'WBC', value: 6.41, unit: 'G/L' },
          { name: 'Glucose', standardKey: 'GLUCOSE', value: 5.1, unit: 'mmol/L' },
        ],
      };

      expect(compareStructuredEventContainment(labSubset, fullCheckup)).toBe('right_contains_left');
      expect(compareStructuredEventContainment(fullCheckup, labSubset)).toBe('left_contains_right');
      expect(compareStructuredEventContainment(labSubset, { ...labSubset })).toBe('equivalent');
      expect(compareStructuredEventContainment(labSubset, { ...fullCheckup, date: '2026-08-11' })).toBe('none');
    });

    it('deduplicates canonical metric variants like urine PRO across different naming styles', () => {
      const cleaned = cleanAndDeduplicateEventData({
        metrics: [
          { name: 'Tổng phân tích nước tiểu – PRO', value: 0.15, unit: 'G/L', refRange: 'Negative' },
          { name: 'PRO (Nước tiểu)', value: 0.15, unit: 'G/L' },
        ],
      });
      expect(cleaned.metrics).toHaveLength(1);
      expect(cleaned.metrics![0].value).toBe(0.15);
    });

    it('matches and merges an earlier lab slip into a comprehensive checkup dossier within 14 days when metrics match', () => {
      const labSlip: HealthEvent = {
        id: 'ev_lab_0806',
        sourceFileId: 'file_lab',
        sourceFileName: 'xet-nghiem.pdf',
        type: 'test_result',
        title: 'Phiếu kết quả xét nghiệm tổng quát',
        date: '2026-06-08',
        facility: 'Bệnh Viện Đại Học Y Dược TP.HCM - Phòng Khám Bệnh Viện Đại Học Y Dược 1',
        diagnoses: ['Z00.0 - Khám sức khỏe tổng quát'],
        medications: [],
        metrics: [
          { name: 'HBsAb định lượng', value: 1000, unit: 'IU/L' },
          { name: 'Định lượng Acid Uric', value: 933.88, unit: 'µmol/L' },
          { name: 'Định lượng HDL-C', value: 0.99, unit: 'mmol/L' },
          { name: 'PRO (Nước tiểu)', value: 0.15, unit: 'G/L' },
        ],
        recordedAt: '2026-06-08T08:00:00Z',
      };

      const annualCheckup: HealthEvent = {
        id: 'ev_checkup_1106',
        sourceFileId: 'file_checkup',
        sourceFileName: 'ho-so-2026.pdf',
        type: 'comprehensive_exam',
        title: 'Hồ sơ sức khỏe định kỳ năm 2026',
        date: '2026-06-11',
        facility: 'Phòng khám Bệnh viện Đại học Y Dược 1',
        diagnoses: ['Tăng acid uric máu', 'Đạm niệu (+)', 'Nang giáp keo hai thùy'],
        medications: [],
        metrics: [
          { name: 'HBsAb định lượng', value: 1000, unit: 'IU/L' },
          { name: 'Định lượng Acid Uric', value: 933.88, unit: 'µmol/L' },
          { name: 'Định lượng HDL-C', value: 0.99, unit: 'mmol/L' },
          { name: 'Tổng phân tích nước tiểu – PRO', value: 0.15, unit: 'G/L' },
          { name: 'Định lượng Glucose', value: 5.1, unit: 'mmol/L' },
        ],
        imagingResults: [{ modality: 'Siêu âm tuyến giáp', findings: 'Nang keo', conclusion: 'TIRADS 1' }],
        recordedAt: '2026-06-11T10:00:00Z',
      };

      expect(compareStructuredEventContainment(labSlip, annualCheckup)).toBe('right_contains_left');
      expect(compareStructuredEventContainment(annualCheckup, labSlip)).toBe('left_contains_right');

      const matchFromLabFirst = detectDuplicateEvent([labSlip], annualCheckup);
      expect(matchFromLabFirst).not.toBeNull();
      expect(matchFromLabFirst?.matchedEvent.id).toBe('ev_lab_0806');

      const mergedLabFirst = mergeHealthEvents(labSlip, annualCheckup);
      expect(mergedLabFirst.type).toBe('comprehensive_exam');
      expect(mergedLabFirst.title).toBe('Hồ sơ sức khỏe định kỳ năm 2026');
      expect(mergedLabFirst.date).toBe('2026-06-11');
      expect(mergedLabFirst.metrics).toHaveLength(5);

      const consolidated = consolidateTimelineEvents([labSlip, annualCheckup]);
      expect(consolidated.mergedCount).toBe(1);
      expect(consolidated.timeline).toHaveLength(1);
      expect(consolidated.timeline[0].type).toBe('comprehensive_exam');
      expect(consolidated.timeline[0].title).toBe('Hồ sơ sức khỏe định kỳ năm 2026');
    });
  });
});
