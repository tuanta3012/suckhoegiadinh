import { describe, expect, it } from 'vitest';
import type { FamilyMember, HealthEvent } from '../types';
import {
  addHealthSource,
  canDeleteRawSource,
  createHealthProfile,
  digitizeHealthSource,
  excludeDeletedFamilyMembers,
  mergeDuplicateMemberProfiles,
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

  it('keeps comprehensive and imaging event types and extracted document details after reload', () => {
    const profile = parseHealthProfile({
      timeline: [
        {
          ...event,
          id: 'checkup-event',
          sourceFileName: 'kham-suc-khoe.pdf',
          type: 'test_result',
          title: 'Khám sức khỏe định kỳ',
          doctorName: 'Bác sĩ Nguyễn Văn A',
          customCategory: 'Khám đoàn thể',
          physicalExam: { height_cm: 170, classification: 'Loại I' },
        },
        {
          ...event,
          id: 'imaging-event',
          sourceFileName: 'sieu-am.pdf',
          type: 'imaging',
          title: 'Siêu âm ổ bụng',
          imagingResults: [{ modality: 'Siêu âm', findings: '', conclusion: 'Bình thường.' }],
        },
      ],
    }, member);

    expect(profile.timeline.map((item) => item.type)).toEqual(['comprehensive_exam', 'imaging']);
    expect(profile.timeline[0].doctorName).toBe('Bác sĩ Nguyễn Văn A');
    expect(profile.timeline[0].physicalExam?.classification).toBe('Loại I');
    expect(profile.timeline[1].imagingResults?.[0].conclusion).toBe('Bình thường.');
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

  it('preserves sourceContributions and mergedInto provenance metadata on parse and merge', () => {
    const canonicalSource = {
      driveFileId: 'source-main',
      fileName: 'tuanta 2026.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:00:00.000Z',
      status: 'processed' as const,
      sourceContributions: [
        {
          fileName: 'Xet nghiem mau 2026 tuanta.pdf',
          fileHash: 'a'.repeat(64),
          hashAlgorithm: 'sha256' as const,
          uploadedAt: '2026-03-10T08:05:00.000Z',
          disposition: 'included' as const,
          reason: 'Nội dung nằm trọn trong tài liệu đầy đủ hơn',
          fileSize: 338503,
          totalPages: 3,
          mergedIntoEventId: 'event-1',
        },
      ],
    };
    const mergedSource = {
      driveFileId: 'source-dup',
      fileName: 'Xet nghiem mau 2025 tuanta.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:02:00.000Z',
      status: 'processed' as const,
      rawDeletedAt: '2026-03-10T08:06:00.000Z',
      mergedIntoFileId: 'source-main',
      mergedIntoFileName: 'tuanta 2026.pdf',
      mergedDisposition: 'included' as const,
      mergedReason: 'Nội dung nằm trọn trong bản đầy đủ hơn',
    };

    const parsed = parseHealthProfile(
      {
        ...createHealthProfile(member),
        sources: [canonicalSource, mergedSource],
      },
      member,
    );

    expect(parsed.sources[0].sourceContributions?.[0]).toMatchObject({
      fileName: 'Xet nghiem mau 2026 tuanta.pdf',
      fileSize: 338503,
      totalPages: 3,
      mergedIntoEventId: 'event-1',
    });
    expect(parsed.sources[1]).toMatchObject({
      mergedIntoFileId: 'source-main',
      mergedIntoFileName: 'tuanta 2026.pdf',
      mergedDisposition: 'included',
    });

    const merged = mergeHealthProfiles(
      { ...parsed, sources: [{ ...canonicalSource, sourceContributions: undefined }] },
      parsed,
    );
    expect(merged.sources.find((s) => s.driveFileId === 'source-main')?.sourceContributions).toHaveLength(1);
    expect(merged.sources.find((s) => s.driveFileId === 'source-dup')?.mergedIntoFileName).toBe('tuanta 2026.pdf');
  });

  it('compares timestamps for aiDeepAnalysis and keeps the newer analysis regardless of merge direction', () => {
    const base = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      timeline: [event],
      timelineUpdatedAt: '2026-03-10T09:00:00.000Z',
    };
    const olderAnalysis = {
      analyzedAt: '2026-03-10T10:00:00.000Z',
      healthScore: 70,
      overallAssessment: 'Bản phân tích cũ',
      crossCorrelations: [],
      velocityTrends: [],
      chronicSurveillance: [],
      roadmap: {
        criticalAlerts: [],
        specialistReferrals: [],
        timeBoundPlan: { next3Months: [], next6Months: [], next12Months: [] },
      },
    };
    const newerAnalysis = {
      ...olderAnalysis,
      analyzedAt: '2026-03-11T12:00:00.000Z',
      healthScore: 84,
      overallAssessment: 'Bản phân tích mới hơn',
    };

    const withNewerCurrent = {
      ...base,
      aiDeepAnalysis: newerAnalysis,
      aiAnalysis: { analyzedAt: newerAnalysis.analyzedAt, overviewSummary: 'Mới hơn' },
    };
    const withOlderIncoming = {
      ...base,
      aiDeepAnalysis: olderAnalysis,
      aiAnalysis: { analyzedAt: olderAnalysis.analyzedAt, overviewSummary: 'Cũ hơn' },
    };

    const merged = mergeHealthProfiles(withNewerCurrent, withOlderIncoming);
    expect(merged.aiDeepAnalysis?.healthScore).toBe(84);
    expect(merged.aiAnalysis?.overviewSummary).toBe('Mới hơn');
    expect(merged.aiAnalysisInvalidatedAt).toBeUndefined();
  });

  it('invalidates aiDeepAnalysis and sets aiAnalysisInvalidatedAt when timeline updates are newer', () => {
    const analyzedProfile = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      timeline: [event],
      timelineUpdatedAt: '2026-03-10T09:00:00.000Z',
      aiDeepAnalysis: {
        analyzedAt: '2026-03-10T10:00:00.000Z',
        healthScore: 78,
        overallAssessment: 'Phân tích trước khi thêm khám mới',
        crossCorrelations: [],
        velocityTrends: [],
        chronicSurveillance: [],
        roadmap: {
          criticalAlerts: [],
          specialistReferrals: [],
          timeBoundPlan: { next3Months: [], next6Months: [], next12Months: [] },
        },
      },
      aiAnalysis: {
        analyzedAt: '2026-03-10T10:00:00.000Z',
        overviewSummary: 'Cần cập nhật khi có dữ liệu mới',
      },
    };

    const newerEvent = {
      ...event,
      id: 'event-2',
      title: 'Khám bổ sung',
      recordedAt: '2026-03-12T08:00:00.000Z',
    };
    const deviceWithNewEvent = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      timeline: [event, newerEvent],
      timelineUpdatedAt: '2026-03-12T08:00:00.000Z',
      aiAnalysisInvalidatedAt: '2026-03-12T08:00:00.000Z',
    };

    const merged = mergeHealthProfiles(analyzedProfile, deviceWithNewEvent);
    expect(merged.timeline).toHaveLength(2);
    expect(merged.aiDeepAnalysis).toBeUndefined();
    expect(merged.aiAnalysis).toBeUndefined();
    expect(merged.aiAnalysisInvalidatedAt).toBe('2026-03-12T08:00:00.000Z');
  });

  it('invalidates aiDeepAnalysis on digitizeHealthSource and clears flag when fresh analysis is saved', () => {
    const staged = addHealthSource(createHealthProfile(member), {
      driveFileId: 'source-1',
      fileName: 'lab.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:00:00.000Z',
      status: 'pending',
    });
    const digitized = digitizeHealthSource(staged, event, '2026-03-10T09:05:00.000Z');
    expect(digitized.timelineUpdatedAt).toBe('2026-03-10T09:05:00.000Z');
    expect(digitized.aiAnalysisInvalidatedAt).toBe('2026-03-10T09:05:00.000Z');
    expect(digitized.aiDeepAnalysis).toBeUndefined();
  });

  it('compares medicalHistoryUpdatedAt so newer medicalHistory is not overwritten by older remote copy', () => {
    const newerHistory = {
      surgeries: [{ procedure: 'Phẫu thuật mới', year: '2026' }],
      chronicConditions: [{ condition: 'Tăng huyết áp' }],
    };
    const olderHistory = {
      surgeries: [],
      chronicConditions: [{ condition: 'Bản cũ' }],
    };

    const current = {
      ...createHealthProfile(member),
      medicalHistory: newerHistory,
      medicalHistoryUpdatedAt: '2026-04-02T10:00:00.000Z',
    };
    const incoming = {
      ...createHealthProfile(member),
      medicalHistory: olderHistory,
      medicalHistoryUpdatedAt: '2026-04-01T10:00:00.000Z',
    };

    const merged = mergeHealthProfiles(current, incoming);
    expect(merged.medicalHistory).toEqual(newerHistory);
    expect(merged.medicalHistoryUpdatedAt).toBe('2026-04-02T10:00:00.000Z');
  });

  it('prevents older remote snapshots from resurrecting deleted timeline events or sources', () => {
    const source = {
      driveFileId: 'source-1',
      fileName: 'lab.pdf',
      mimeType: 'application/pdf',
      uploadedAt: '2026-03-10T08:00:00.000Z',
      status: 'processed' as const,
      digitizedAt: '2026-03-10T09:05:00.000Z',
    };
    const remoteSnapshot = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      timeline: [event],
      sources: [source],
      timelineUpdatedAt: '2026-03-10T09:05:00.000Z',
    };
    const localAfterDeletion = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      timeline: [],
      sources: [],
      deletedEvents: [{ id: 'event-1', deletedAt: '2026-03-11T10:00:00.000Z' }],
      deletedSources: [{ id: 'source-1', deletedAt: '2026-03-11T10:00:00.000Z' }],
      timelineUpdatedAt: '2026-03-11T10:00:00.000Z',
      aiAnalysisInvalidatedAt: '2026-03-11T10:00:00.000Z',
    };

    const merged = mergeHealthProfiles(remoteSnapshot, localAfterDeletion);
    expect(merged.timeline).toEqual([]);
    expect(merged.sources).toEqual([]);
    expect(merged.deletedEvents).toEqual([{ id: 'event-1', deletedAt: '2026-03-11T10:00:00.000Z' }]);
    expect(merged.deletedSources).toEqual([{ id: 'source-1', deletedAt: '2026-03-11T10:00:00.000Z' }]);

    const reparsed = parseHealthProfile(merged, member);
    expect(reparsed.deletedEvents).toEqual([{ id: 'event-1', deletedAt: '2026-03-11T10:00:00.000Z' }]);
    expect(reparsed.deletedSources).toEqual([{ id: 'source-1', deletedAt: '2026-03-11T10:00:00.000Z' }]);
  });

  it('allows a previously relocated or deleted source and event to be restored with newer timestamps', () => {
    const profileWithOlderTombstone = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      deletedEvents: [{ id: 'event-1', deletedAt: '2026-03-11T10:00:00.000Z' }],
      deletedSources: [{ id: 'source-1', deletedAt: '2026-03-11T10:00:00.000Z' }],
    };
    const restoredIncoming = {
      ...createHealthProfile(member, '2026-01-01T00:00:00.000Z'),
      timeline: [{ ...event, recordedAt: '2026-03-12T08:00:00.000Z' }],
      sources: [{
        driveFileId: 'source-1',
        fileName: 'lab.pdf',
        mimeType: 'application/pdf',
        uploadedAt: '2026-03-10T08:00:00.000Z',
        status: 'processed' as const,
        digitizedAt: '2026-03-10T09:05:00.000Z',
        restoredAt: '2026-03-12T08:00:00.000Z',
      }],
      timelineUpdatedAt: '2026-03-12T08:00:00.000Z',
    };

    const merged = mergeHealthProfiles(profileWithOlderTombstone, restoredIncoming);
    expect(merged.timeline).toHaveLength(1);
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].restoredAt).toBe('2026-03-12T08:00:00.000Z');
    expect(merged.deletedEvents).toBeUndefined();
    expect(merged.deletedSources).toBeUndefined();
  });

  it('merges duplicate member profiles, enriching metadata, consolidating timeline and deduplicating sources', () => {
    const primaryMember: FamilyMember = {
      id: 'minh-1',
      name: 'Trương Quang Minh',
      email: 'minhtq411@gmail.com',
      gender: 'male',
      birthDate: '2007-11-04',
      driveFolderId: 'folder-1',
      profileFileId: 'profile-1',
    };
    const duplicateMember: FamilyMember = {
      id: 'minh-2',
      name: 'Minh Truong',
      gender: 'other',
      birthDate: '2007-11-04',
      driveFolderId: 'folder-2',
      profileFileId: 'profile-2',
    };

    const primaryProfile = {
      ...createHealthProfile(primaryMember, '2026-01-01T00:00:00.000Z'),
      timeline: [
        {
          ...event,
          id: 'ev-1',
          date: '2026-03-10',
          title: 'Khám sức khỏe',
          metrics: [{ name: 'Glucose', value: 5.2, unit: 'mmol/L' }],
        },
      ],
      sources: [
        {
          driveFileId: 'src-1',
          fileName: 'kham-tong-quat.pdf',
          mimeType: 'application/pdf',
          uploadedAt: '2026-03-10T08:00:00.000Z',
          status: 'processed' as const,
        },
      ],
    };

    const duplicateProfile = {
      ...createHealthProfile(duplicateMember, '2026-01-02T00:00:00.000Z'),
      timeline: [
        {
          ...event,
          id: 'ev-2',
          date: '2026-03-10',
          title: 'Đơn thuốc',
          type: 'prescription' as const,
          medications: [{ name: 'Paracetamol', dosage: '500mg' }],
        },
      ],
      sources: [
        {
          driveFileId: 'src-2',
          fileName: 'don-thuoc.jpg',
          mimeType: 'image/jpeg',
          uploadedAt: '2026-03-10T08:30:00.000Z',
          status: 'processed' as const,
        },
      ],
      medicalHistory: {
        surgeries: [{ procedure: 'Mổ ruột thừa', year: '2020' }],
        chronicConditions: [],
      },
    };

    const result = mergeDuplicateMemberProfiles(
      primaryMember,
      primaryProfile,
      duplicateMember,
      duplicateProfile,
      '2026-03-15T00:00:00.000Z',
    );

    // Primary ID, folder, and diacritics name preserved
    expect(result.mergedMember.id).toBe('minh-1');
    expect(result.mergedMember.name).toBe('Trương Quang Minh');
    expect(result.mergedMember.gender).toBe('male'); // Enriched from primary over 'other'
    expect(result.mergedMember.email).toBe('minhtq411@gmail.com');

    // Sources combined
    expect(result.mergedProfile.sources).toHaveLength(2);
    expect(result.mergedProfile.sources.map((s) => s.driveFileId)).toEqual(['src-1', 'src-2']);

    // Timeline consolidated (same date medical report + prescription merged or consolidated)
    expect(result.mergedProfile.timeline.length).toBeGreaterThanOrEqual(1);

    // Medical history preserved from duplicate
    expect(result.mergedProfile.medicalHistory?.surgeries).toEqual([
      { procedure: 'Mổ ruột thừa', year: '2020' },
    ]);
  });
});


