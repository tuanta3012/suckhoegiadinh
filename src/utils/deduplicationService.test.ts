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

    it('deduplicates diagnoses by ICD-10 code and normalizes medical spelling variants', () => {
      const event: Partial<HealthEvent> = {
        diagnoses: [
          'Bệnh tăng huyết áp vô căn (nguyên phát) (I10)',
          'Bệnh đái tháo đường không phụ thuộc insuline (E11)',
          'Tăng lipid máu hỗn hợp (E78.2)',
          'Bệnh đái tháo đường không phụ thuộc insulin (E11)',
        ],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.diagnoses).toHaveLength(3);
      expect(cleaned.diagnoses).toContain('Bệnh tăng huyết áp vô căn (nguyên phát) (I10)');
      expect(cleaned.diagnoses).toContain('Bệnh đái tháo đường không phụ thuộc insulin (E11)');
      expect(cleaned.diagnoses).toContain('Tăng lipid máu hỗn hợp (E78.2)');
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

    it('deduplicates complex compound medications with brand names and redundant dosages', () => {
      const event: Partial<HealthEvent> = {
        medications: [
          {
            name: 'Sitagliptin + metformin (SITA-MET 50/1000) 50mg + 1000mg',
            dosage: '50mg + 1000mg',
            quantity: '60 Viên',
            frequency: 'Mỗi ngày 1 lần, mỗi lần 1 Viên',
            duration: '60 ngày',
          },
          {
            name: 'Ezetimibe + Atorvastatin (JAPET) 10mg + 20mg',
            dosage: '10mg + 20mg',
            quantity: '60 Viên',
            frequency: 'Mỗi ngày 1 lần, mỗi lần 1 Viên',
            duration: '60 ngày',
          },
          {
            name: 'Sitagliptin + Metformin (SITA-MET 50/1000)',
            dosage: '50mg + 1000mg',
            frequency: '1 lần/ngày',
            duration: '60 days',
          },
          {
            name: 'Ezetimibe + Atorvastatin (JAPET)',
            dosage: '10mg + 20mg',
            frequency: '1 lần/ngày',
            duration: '60 days',
          },
        ],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.medications).toHaveLength(2);

      const sitamet = cleaned.medications?.find((m) => m.name.includes('SITA-MET'));
      expect(sitamet).toBeDefined();
      expect(sitamet?.name).toBe('Sitagliptin + Metformin (SITA-MET 50/1000)');
      expect(sitamet?.quantity).toBe('60 Viên');
      expect(sitamet?.frequency).toBe('Mỗi ngày 1 lần, mỗi lần 1 Viên');
      expect(sitamet?.duration).toBe('60 ngày');

      const japet = cleaned.medications?.find((m) => m.name.includes('JAPET'));
      expect(japet).toBeDefined();
      expect(japet?.name).toBe('Ezetimibe + Atorvastatin (JAPET)');
      expect(japet?.quantity).toBe('60 Viên');
    });

    it('deduplicates STRADIRAS and eye drops with percentages', () => {
      const event: Partial<HealthEvent> = {
        medications: [
          {
            name: 'Sitagliptin + Metformin (STRADIRAS 50/850mg)',
            dosage: '50mg + 850mg',
            frequency: '1 lần/ngày',
            duration: '60 ngày',
          },
          {
            name: 'Sitagliptin + metformin (STRADIRAS 50/850MG) 50mg + 850mg',
            dosage: '50mg + 850mg',
            frequency: '1 lần/ngày',
            duration: '60 ngày',
          },
          {
            name: 'Natri Hyaluronat (SANLEIN EYE DROP 0.1% 5ML) 0.1% 5ML',
            dosage: '1 giọt/lần',
          },
          {
            name: 'Natri Hyaluronat (SANLEIN EYE DROP 0.1% 5ML)',
            dosage: '1 giọt/lần',
          },
        ],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.medications).toHaveLength(2);
      expect(cleaned.medications![0].name).toBe('Sitagliptin + Metformin (STRADIRAS 50/850mg)');
      expect(cleaned.medications![1].name).toBe('Natri Hyaluronat (SANLEIN EYE DROP 0.1% 5ML)');
    });

    it('deduplicates concatenated and repeated doctor advice clauses', () => {
      const event: Partial<HealthEvent> = {
        advice:
          'Hạn chế ăn dầu mỡ, chất béo, nội tạng động vật. Uống đủ nước (2000-2500ml/ngày), tăng cường ăn rau xanh. Hạn chế ăn dầu mỡ, chất béo, nội tạng động vật. Uống đủ nước (2000-2500ml/ngày).',
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.advice).toBe(
        'Hạn chế ăn dầu mỡ, chất béo, nội tạng động vật. Uống đủ nước (2000-2500ml/ngày), tăng cường ăn rau xanh.'
      );
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

    it('retains numeric-string and qualitative metrics instead of dropping them', () => {
      const event: Partial<HealthEvent> = {
        metrics: [
          { name: 'Định lượng 25-OH Vitamin D [Huyết Thanh]', value: '26' as any, unit: '' },
          { name: 'Đạm', standardKey: 'URINE_PRO', value: 'Có phát hiện / Dương Tính', unit: '' },
        ],
      };
      const cleaned = cleanAndDeduplicateEventData(event);
      expect(cleaned.metrics).toEqual([
        { name: 'Định lượng 25-OH Vitamin D [Huyết Thanh]', value: 26, unit: '' },
        { name: 'Đạm', standardKey: 'URINE_PRO', value: 'Có phát hiện / Dương Tính', unit: '' },
      ]);
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

    it('detects exact re-upload of a file previously absorbed into canonical sourceContributions', () => {
      const absorbedHash = '9999999999999999999999999999999999999999999999999999999999999999';
      const profileWithContribution: HealthProfile = {
        ...mockProfile,
        sources: [
          {
            ...mockProfile.sources[0],
            sourceContributions: [
              {
                fileName: 'Xet nghiem mau 2026 tuanta.pdf',
                fileHash: absorbedHash,
                hashAlgorithm: 'sha256',
                uploadedAt: '2026-11-16T00:47:50.000Z',
                disposition: 'included',
                reason: 'Nội dung là một phần nằm trọn trong tài liệu đầy đủ hơn',
                mergedIntoEventId: 'ev_1',
              },
            ],
          },
        ],
      };

      const match = detectDuplicateFile(
        { name: 'Xet nghiem mau 2026 tuanta.pdf', size: 338503 },
        absorbedHash,
        profileWithContribution,
      );

      expect(match).not.toBeNull();
      expect(match?.isExactContentMatch).toBe(true);
      expect(match?.existingSource.driveFileId).toBe('file_drive_1');
      expect(match?.matchedContribution?.fileName).toBe('Xet nghiem mau 2026 tuanta.pdf');
      expect(match?.linkedEvent?.id).toBe('ev_1');
    });

    it('resolves canonical source and linked event when a trashed duplicate source is re-uploaded', () => {
      const trashedHash = '8888888888888888888888888888888888888888888888888888888888888888';
      const profileWithTrashedDup: HealthProfile = {
        ...mockProfile,
        timeline: [
          {
            ...mockProfile.timeline[0],
            additionalSources: [
              { driveFileId: 'file_drive_1', fileName: 'tuanta-2025.pdf' },
              { driveFileId: 'file_drive_trashed', fileName: 'Xet nghiem mau 2025 tuanta.pdf' },
            ],
          },
        ],
        sources: [
          { ...mockProfile.sources[0], fileName: 'tuanta-2025.pdf' },
          {
            driveFileId: 'file_drive_trashed',
            fileName: 'Xet nghiem mau 2025 tuanta.pdf',
            fileSize: 726500,
            fileHash: trashedHash,
            mimeType: 'application/pdf',
            uploadedAt: '2026-11-16T00:46:22.000Z',
            status: 'processed',
            rawDeletedAt: '2026-11-16T00:46:39.000Z',
            mergedIntoFileId: 'file_drive_1',
            mergedIntoFileName: 'tuanta-2025.pdf',
            mergedDisposition: 'included',
          },
        ],
      };

      const match = detectDuplicateFile(
        { name: 'Xet nghiem mau 2025 tuanta.pdf', size: 726500 },
        trashedHash,
        profileWithTrashedDup,
      );

      expect(match).not.toBeNull();
      expect(match?.existingSource.driveFileId).toBe('file_drive_1');
      expect(match?.linkedEvent?.id).toBe('ev_1');
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
