import { describe, expect, it } from 'vitest';
import type { FamilyMember, HealthEvent } from '../types';
import {
  addHealthSource,
  canDeleteRawSource,
  createHealthProfile,
  digitizeHealthSource,
  excludeDeletedFamilyMembers,
  mergeFamilyMemberTombstones,
  mergeFamilyMembers,
  mergeHealthProfiles,
  parseHealthProfile,
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
  metrics: [{ name: 'Hemoglobin', standardKey: 'HGB', value: 12, unit: 'g/dL' }],
  recordedAt: '2026-03-10T09:00:00.000Z',
};

describe('health profile', () => {
  it('applies member updates while retaining members added concurrently on another device', () => {
    const updatedMember = { ...member, name: 'Mẹ mới', email: 'me@example.com', avatarUrl: 'avatar.png' };
    const remotelyUpdatedMember = { ...member, gender: 'female' as const };
    const concurrentMember = { ...member, id: 'member-2', name: 'Bố' };

    expect(mergeFamilyMembers(
      [remotelyUpdatedMember, concurrentMember],
      [updatedMember],
      [member],
    )).toEqual([
      { ...updatedMember, gender: 'female' },
      concurrentMember,
    ]);
  });

  it('rejects concurrent edits to the same member field instead of last-write-wins', () => {
    const firstEdit = { ...member, name: 'Mẹ thiết bị A' };
    const secondEdit = { ...member, name: 'Mẹ thiết bị B' };
    expect(() => mergeFamilyMembers([firstEdit], [secondEdit], [member]))
      .toThrow('đã được sửa trên nhiều thiết bị');
  });

  it('keeps deletion tombstones and prevents stale member snapshots from restoring a deleted profile', () => {
    const tombstones = mergeFamilyMemberTombstones(
      [{ memberId: 'member-2', deletedAt: '2026-03-10T10:00:00.000Z' }],
      [{ memberId: 'member-2', deletedAt: '2026-03-10T11:00:00.000Z' }],
    );
    const staleAndCurrent = mergeFamilyMembers(
      [member],
      [member, { ...member, id: 'member-2', name: 'Bố' }],
    );

    expect(excludeDeletedFamilyMembers(staleAndCurrent, tombstones).map(({ id }) => id))
      .toEqual(['member-1']);
    expect(mergeFamilyMemberTombstones(
      tombstones,
      [{ memberId: 'member-2', deletedAt: '2026-03-10T12:00:00.000Z' }],
    ).find((item) => item.memberId === 'member-2')?.deletedAt)
      .toBe('2026-03-10T12:00:00.000Z');
  });

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

  it('preserves unresolved-subject state until the source is assigned and digitized', () => {
    const profile = parseHealthProfile({
      sources: [{
        driveFileId: 'source-1',
        fileName: 'unknown-patient.pdf',
        mimeType: 'application/pdf',
        uploadedAt: '2026-03-10T08:00:00.000Z',
        status: 'pending',
        subjectStatus: 'unresolved',
      }],
    }, member);

    expect(profile.timeline).toEqual([]);
    expect(profile.sources[0].subjectStatus).toBe('unresolved');

    const assignedProfile = digitizeHealthSource(profile, event, '2026-03-10T09:05:00.000Z');
    expect(assignedProfile.sources[0].subjectStatus).toBeUndefined();
    expect(assignedProfile.sources[0].status).toBe('processed');
  });

  it('merges unresolved-subject state from another device', () => {
    const base = createHealthProfile(member);
    const source = {
      driveFileId: 'source-1',
      fileName: 'unknown-patient.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:00:00.000Z',
      status: 'pending' as const,
    };
    const merged = mergeHealthProfiles(
      { ...base, sources: [source] },
      { ...base, sources: [{ ...source, subjectStatus: 'unresolved' }] },
    );

    expect(merged.sources[0].subjectStatus).toBe('unresolved');
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
    expect(merged.summary.latestMetrics.HGB.value).toBe(12);
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

  it('merges contents intelligently for the same event id when timestamps are equal', () => {
    const base = createHealthProfile(member);
    const firstCopy = {
      ...base,
      timeline: [{ ...event, id: 'shared-event', diagnoses: ['Viêm họng'] }],
    };
    const secondCopy = {
      ...base,
      timeline: [{ ...event, id: 'shared-event', diagnoses: ['Viêm phế quản'], title: 'Kết quả đã bổ sung' }],
    };

    const merged = mergeHealthProfiles(firstCopy, secondCopy);
    expect(merged.timeline).toHaveLength(1);
    expect(merged.timeline[0].diagnoses).toContain('Viêm họng');
    expect(merged.timeline[0].diagnoses).toContain('Viêm phế quản');
  });

  it('updates conflicting event with newer recorded timestamp (Last-Write-Wins)', () => {
    const base = createHealthProfile(member);
    const firstCopy = {
      ...base,
      timeline: [{ ...event, id: 'shared-event', title: 'Bản cũ', recordedAt: '2026-03-10T08:00:00.000Z' }],
    };
    const secondCopy = {
      ...base,
      timeline: [{
        ...event,
        id: 'shared-event',
        title: 'Bản mới đã chỉnh sửa',
        recordedAt: '2027-01-01T10:00:00.000Z',
      }],
    };

    const merged = mergeHealthProfiles(firstCopy, secondCopy);
    expect(merged.timeline).toHaveLength(1);
    expect(merged.timeline[0].title).toBe('Bản mới đã chỉnh sửa');
    expect(merged.timeline[0].recordedAt).toBe('2027-01-01T10:00:00.000Z');
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

  it('rejects malformed health events instead of loading partial data as a valid profile', () => {
    const profile = createHealthProfile(member);
    expect(() =>
      parseHealthProfile(
        { ...profile, timeline: [{ ...event, metrics: 'not-an-array' }] },
        member,
      ),
    ).toThrow('sự kiện thiếu trường bắt buộc');
  });

  it('preserves health events with an unknown date without assigning the current date', () => {
    const profile = createHealthProfile(member);
    const parsed = parseHealthProfile(
      { ...profile, timeline: [{ ...event, date: '' }] },
      member,
    );
    expect(parsed.timeline[0].date).toBe('');
    expect(parsed.summary.latestEventDate).toBeUndefined();
  });

  it('rejects malformed source records', () => {
    const profile = createHealthProfile(member);
    expect(() =>
      parseHealthProfile({ ...profile, sources: [{ driveFileId: 'source-1' }] }, member),
    ).toThrow('tài liệu nguồn thiếu trường bắt buộc');
  });
});
