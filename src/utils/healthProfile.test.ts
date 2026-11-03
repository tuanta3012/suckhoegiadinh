import { describe, expect, it } from 'vitest';
import type { FamilyMember, HealthEvent } from '../types';
import {
  addHealthSource,
  canDeleteRawSource,
  createHealthProfile,
  digitizeHealthSource,
  mergeHealthProfiles,
} from './healthProfile';

const member: FamilyMember = {
  id: 'member-1',
  name: 'Mẹ',
  role: 'mother',
  driveFolderId: 'raw-folder',
  profileFileId: 'profile-file',
};

const event: HealthEvent = {
  id: 'event-1',
  sourceFileId: 'source-1',
  sourceFileName: 'lab.pdf',
  type: 'test_result',
  title: 'Xét nghiệm máu',
  date: '2026-03-10',
  diagnoses: ['Thiếu máu'],
  medications: [],
  metrics: [{ name: 'Hemoglobin', value: 12, unit: 'g/dL' }],
  recordedAt: '2026-03-10T09:00:00.000Z',
};

describe('health profile', () => {
  it('keeps uploaded originals ineligible for deletion until a linked event is digitized', () => {
    let profile = createHealthProfile(member);
    profile = addHealthSource(profile, {
      driveFileId: 'source-1',
      fileName: 'lab.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:00:00.000Z',
      status: 'pending',
    });

    expect(canDeleteRawSource(profile, 'source-1')).toBe(false);
    profile = digitizeHealthSource(profile, event, '2026-03-10T09:05:00.000Z');
    expect(canDeleteRawSource(profile, 'source-1')).toBe(true);
    expect(profile.sources[0].digitizedAt).toBe('2026-03-10T09:05:00.000Z');
  });

  it('merges timeline and sources without dropping existing events', () => {
    const first = createHealthProfile(member, '2026-01-01T00:00:00.000Z');
    const original = {
      ...first,
      timeline: [{ ...event, id: 'older', date: '2025-01-01' }],
    };
    const update = {
      ...first,
      timeline: [event],
      sources: [{
        driveFileId: 'source-1',
        fileName: 'lab.pdf',
        mimeType: 'application/pdf',
        uploadedAt: '2026-03-10T08:00:00.000Z',
        status: 'processed' as const,
        digitizedAt: '2026-03-10T09:05:00.000Z',
      }],
    };

    const merged = mergeHealthProfiles(original, update, '2026-03-10T10:00:00.000Z');

    expect(merged.timeline.map((item) => item.id)).toEqual(['older', 'event-1']);
    expect(merged.sources[0].status).toBe('processed');
    expect(merged.summary.latestMetrics.Hemoglobin.value).toBe(12);
  });

  it('preserves independent events added on two devices', () => {
    const base = createHealthProfile(member);
    const firstDevice = { ...base, timeline: [{ ...event, id: 'event-device-a' }] };
    const secondDevice = {
      ...base,
      timeline: [{ ...event, id: 'event-device-b', title: 'Tái khám' }],
    };

    const merged = mergeHealthProfiles(firstDevice, secondDevice);

    expect(merged.timeline.map((item) => item.id).sort()).toEqual(['event-device-a', 'event-device-b']);
  });

  it('merges the same event idempotently when only its recorded timestamp differs', () => {
    const base = createHealthProfile(member);
    const firstCopy = { ...base, timeline: [{ ...event, id: 'shared-event' }] };
    const secondCopy = {
      ...base,
      timeline: [{ ...event, id: 'shared-event', recordedAt: '2026-03-10T09:10:00.000Z' }],
    };

    const merged = mergeHealthProfiles(firstCopy, secondCopy);

    expect(merged.timeline).toHaveLength(1);
    expect(merged.timeline[0].recordedAt).toBe('2026-03-10T09:10:00.000Z');
  });

  it('rejects conflicting contents for the same event id instead of overwriting them', () => {
    const base = createHealthProfile(member);
    const firstCopy = { ...base, timeline: [{ ...event, id: 'shared-event' }] };
    const secondCopy = {
      ...base,
      timeline: [{ ...event, id: 'shared-event', title: 'Kết quả đã chỉnh sửa trên thiết bị khác' }],
    };

    expect(() => mergeHealthProfiles(firstCopy, secondCopy)).toThrow('Xung đột đồng bộ');
  });

  it('rejects digitization without a title or a valid source', () => {
    const profile = createHealthProfile(member);
    expect(() => digitizeHealthSource(profile, event)).toThrow('Không tìm thấy tài liệu gốc');

    const staged = addHealthSource(profile, {
      driveFileId: 'source-1',
      fileName: 'lab.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:00:00.000Z',
      status: 'pending',
    });
    expect(() => digitizeHealthSource(staged, { ...event, title: ' ' })).toThrow('Cần nhập tiêu đề');
  });
});
