import { describe, it, expect } from 'vitest';
import {
  cleanAndDeduplicateEventData,
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
      expect(cleaned.metrics![0].value).toBe(125);
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
          fileHash: 'abcdef1234567890abcdef1234567890',
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
        'abcdef1234567890abcdef1234567890',
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
  });
});
