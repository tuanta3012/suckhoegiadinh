import { describe, expect, it, vi } from 'vitest';
import type { FamilyMember, HealthEvent, HealthProfile } from '../types';
import type { DriveFile, HealthDriveWorkspace } from './healthDriveService';
import { mergeHealthProfiles } from './healthProfile';
import { cleanupWorkspaceDuplicates } from './workspaceAuditService';

const member: FamilyMember = {
  id: 'member-1',
  name: 'Nguyen An',
  role: 'other',
  driveFolderId: 'member-folder',
  profileFileId: 'profile-file',
};

function createProfile(sources: HealthProfile['sources']): HealthProfile {
  const event: HealthEvent = {
    id: 'event-1',
    sourceFileId: 'file-1',
    sourceFileName: 'report.pdf',
    type: 'test_result',
    title: 'Kết quả khám',
    date: '2026-03-10',
    diagnoses: [],
    medications: [],
    metrics: [],
    recordedAt: '2026-03-10T08:00:00.000Z',
  };
  return {
    schemaVersion: 2,
    member,
    timeline: [event],
    sources,
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: event.recordedAt,
    updatedAt: event.recordedAt,
  };
}

const workspace = {
  rootFolderId: 'workspace',
  familyFileId: 'family',
  family: { members: [member] },
} as HealthDriveWorkspace;

const makeSource = (driveFileId: string): HealthProfile['sources'][number] => ({
  driveFileId,
  fileName: 'report.pdf',
  mimeType: 'application/pdf',
  uploadedAt: '2026-03-10T08:00:00.000Z',
  status: 'processed',
  digitizedAt: '2026-03-10T08:05:00.000Z',
});

describe('cleanupWorkspaceDuplicates', () => {
  it('does not delete files that only share a name and size', async () => {
    const rawFiles: DriveFile[] = [
      { id: 'file-1', name: 'report.pdf', mimeType: 'application/pdf', createdTime: '2026-03-10', size: '100', md5Checksum: 'a'.repeat(32) },
      { id: 'file-2', name: 'report.pdf', mimeType: 'application/pdf', createdTime: '2026-03-11', size: '100', md5Checksum: 'b'.repeat(32) },
    ];
    const deleteFile = vi.fn();

    await cleanupWorkspaceDuplicates(
      workspace,
      async () => createProfile([makeSource('file-1')]),
      async (_fileId, profile) => profile,
      async () => rawFiles,
      deleteFile,
    );

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('trashes exact checksum duplicates only after the canonical OCR result is saved', async () => {
    const rawFiles: DriveFile[] = [
      { id: 'file-1', name: 'report.pdf', mimeType: 'application/pdf', createdTime: '2026-03-10', size: '100', md5Checksum: 'a'.repeat(32) },
      { id: 'file-2', name: 'copy.pdf', mimeType: 'application/pdf', createdTime: '2026-03-11', size: '100', md5Checksum: 'a'.repeat(32) },
    ];
    const profile = createProfile([makeSource('file-1'), { ...makeSource('file-2'), fileName: 'copy.pdf' }]);
    const saveProfile = vi.fn(async (_fileId: string, value: HealthProfile) => value);
    const deleteFile = vi.fn(async () => undefined);

    await cleanupWorkspaceDuplicates(
      workspace,
      async () => profile,
      saveProfile,
      async () => rawFiles,
      deleteFile,
    );

    expect(deleteFile).toHaveBeenCalledWith('file-2');
    expect(saveProfile.mock.calls[0][1].timeline[0].sourceFileId).toBe('file-1');
    expect(saveProfile.mock.calls.at(-1)?.[1].sources.find((source) => source.driveFileId === 'file-2')?.rawDeletedAt)
      .toBeTruthy();
  });

  it('preserves metadata when cleaning multiple checksum groups in one profile', async () => {
    const rawFiles: DriveFile[] = [
      { id: 'file-1', name: 'first.pdf', mimeType: 'application/pdf', createdTime: '2026-03-10', md5Checksum: 'a'.repeat(32) },
      { id: 'file-2', name: 'first-copy.pdf', mimeType: 'application/pdf', createdTime: '2026-03-11', md5Checksum: 'a'.repeat(32) },
      { id: 'file-3', name: 'second.pdf', mimeType: 'application/pdf', createdTime: '2026-03-12', md5Checksum: 'b'.repeat(32) },
      { id: 'file-4', name: 'second-copy.pdf', mimeType: 'application/pdf', createdTime: '2026-03-13', md5Checksum: 'b'.repeat(32) },
    ];
    const profile = createProfile([
      makeSource('file-1'),
      { ...makeSource('file-2'), fileName: 'first-copy.pdf' },
      { ...makeSource('file-3'), fileName: 'second.pdf' },
      { ...makeSource('file-4'), fileName: 'second-copy.pdf' },
    ]);
    profile.timeline.push({
      ...profile.timeline[0],
      id: 'event-2',
      sourceFileId: 'file-3',
      sourceFileName: 'second.pdf',
    });
    let savedProfile = profile;
    const deleteFile = vi.fn(async () => undefined);

    await cleanupWorkspaceDuplicates(
      workspace,
      async () => savedProfile,
      async (_fileId, value) => {
        savedProfile = value;
        return value;
      },
      async () => rawFiles,
      deleteFile,
    );

    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(savedProfile.sources.find((source) => source.driveFileId === 'file-2')?.rawDeletedAt).toBeTruthy();
    expect(savedProfile.sources.find((source) => source.driveFileId === 'file-4')?.rawDeletedAt).toBeTruthy();
    expect(savedProfile.sources.find((source) => source.driveFileId === 'file-1')?.sourceContributions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ fileName: 'first-copy.pdf' })]));
    expect(savedProfile.sources.find((source) => source.driveFileId === 'file-3')?.sourceContributions)
      .toEqual(expect.arrayContaining([expect.objectContaining({ fileName: 'second-copy.pdf' })]));
  });

  it('does not trash a duplicate when the provenance save is pending', async () => {
    const rawFiles: DriveFile[] = [
      { id: 'file-1', name: 'report.pdf', mimeType: 'application/pdf', createdTime: '2026-03-10', md5Checksum: 'a'.repeat(32) },
      { id: 'file-2', name: 'copy.pdf', mimeType: 'application/pdf', createdTime: '2026-03-11', md5Checksum: 'a'.repeat(32) },
    ];
    const pendingProfile = { ...createProfile([makeSource('file-1')]), syncPending: true };
    const deleteFile = vi.fn();

    await cleanupWorkspaceDuplicates(
      workspace,
      async () => createProfile([makeSource('file-1'), { ...makeSource('file-2'), fileName: 'copy.pdf' }]),
      async () => pendingProfile,
      async () => rawFiles,
      deleteFile,
    );

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('merges an earlier standalone lab slip into a comprehensive checkup within the clinical episode window and trashes the redundant lab raw file', async () => {
    const rawFiles: DriveFile[] = [
      { id: 'file-lab', name: 'xet-nghiem-08-06.pdf', mimeType: 'application/pdf', createdTime: '2026-06-08T10:00:00Z', md5Checksum: 'c'.repeat(32) },
      { id: 'file-checkup', name: 'ho-so-2026.pdf', mimeType: 'application/pdf', createdTime: '2026-06-11T10:00:00Z', md5Checksum: 'd'.repeat(32) },
    ];
    const sharedMetrics = [
      { name: 'HBsAb định lượng', value: 1000, unit: 'IU/L' },
      { name: 'Định lượng Acid Uric', value: 933.88, unit: 'µmol/L' },
      { name: 'Định lượng HDL-C', value: 0.99, unit: 'mmol/L' },
      { name: 'PRO (Nước tiểu)', value: 0.15, unit: 'G/L' },
    ];
    const labEvent: HealthEvent = {
      id: 'ev-lab',
      sourceFileId: 'file-lab',
      sourceFileName: 'xet-nghiem-08-06.pdf',
      type: 'test_result',
      title: 'Phiếu kết quả xét nghiệm tổng quát',
      date: '2026-06-08',
      facility: 'Bệnh Viện Đại Học Y Dược TP.HCM - Phòng Khám Bệnh Viện Đại Học Y Dược 1',
      diagnoses: ['Z00.0 - Khám sức khỏe tổng quát'],
      medications: [],
      metrics: sharedMetrics,
      recordedAt: '2026-06-08T12:00:00.000Z',
    };
    const checkupEvent: HealthEvent = {
      id: 'ev-checkup',
      sourceFileId: 'file-checkup',
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
        { name: 'Định lượng Glucose', value: 5.2, unit: 'mmol/L' },
      ],
      imagingResults: [{ modality: 'Siêu âm tuyến giáp', findings: 'Nang keo', conclusion: 'TIRADS 1' }],
      recordedAt: '2026-06-11T15:00:00.000Z',
    };
    let savedProfile: HealthProfile = {
      schemaVersion: 2,
      member,
      timeline: [labEvent, checkupEvent],
      sources: [
        { ...makeSource('file-lab'), fileName: 'xet-nghiem-08-06.pdf' },
        { ...makeSource('file-checkup'), fileName: 'ho-so-2026.pdf' },
      ],
      summary: { latestDiagnoses: [], latestMetrics: {} },
      createdAt: labEvent.recordedAt,
      updatedAt: checkupEvent.recordedAt,
    };
    const deleteFile = vi.fn(async () => undefined);

    const result = await cleanupWorkspaceDuplicates(
      workspace,
      async () => savedProfile,
      async (_fileId, value) => {
        savedProfile = value;
        return value;
      },
      async () => rawFiles,
      deleteFile,
    );

    expect(result.deletedRawFiles).toBe(1);
    expect(result.mergedEvents).toBe(1);
    expect(deleteFile).toHaveBeenCalledWith('file-lab');
    expect(savedProfile.timeline).toHaveLength(1);
    expect(savedProfile.timeline[0].type).toBe('comprehensive_exam');
    expect(savedProfile.timeline[0].title).toBe('Hồ sơ sức khỏe định kỳ năm 2026');
    expect(savedProfile.timeline[0].date).toBe('2026-06-11');
    expect(savedProfile.timeline[0].additionalSources?.map((s) => s.driveFileId)).toEqual(
      expect.arrayContaining(['file-checkup', 'file-lab']),
    );
    expect(savedProfile.sources.find((s) => s.driveFileId === 'file-lab')?.rawDeletedAt).toBeTruthy();
  });

  it('merges same-day lab and prescription events, records deletedEvents tombstones, and prevents resurrection on Drive profile merge', async () => {
    const rawFiles: DriveFile[] = [
      { id: 'file-lab', name: 'lab-0902.jpg', mimeType: 'image/jpeg', createdTime: '2026-02-09T07:30:00Z', md5Checksum: 'e'.repeat(32) },
      { id: 'file-rx', name: 'rx-0902.jpg', mimeType: 'image/jpeg', createdTime: '2026-02-09T07:37:00Z', md5Checksum: 'f'.repeat(32) },
    ];
    const sharedMetrics = [
      { name: 'Định lượng HbA1c', value: 6.1, unit: '%' },
      { name: 'Định lượng Glucose', value: 6.33, unit: 'mmol/L' },
    ];
    const labEvent: HealthEvent = {
      id: 'ev-lab-split',
      sourceFileId: 'file-lab',
      sourceFileName: 'lab-0902.jpg',
      type: 'test_result',
      title: 'Phiếu kết quả xét nghiệm',
      date: '2026-02-09',
      facility: 'Phòng khám Bệnh viện Đại học Y Dược 1',
      doctorName: 'BS. Đặng Đồng Quốc Chí',
      diagnoses: ['E11 - Bệnh đái tháo đường không phụ thuộc insulin', 'I10 - Bệnh tăng huyết áp vô căn (nguyên phát)'],
      medications: [],
      metrics: sharedMetrics,
      recordedAt: '2026-02-09T07:35:00.000Z',
    };
    const rxEvent: HealthEvent = {
      id: 'ev-rx-main',
      sourceFileId: 'file-rx',
      sourceFileName: 'rx-0902.jpg',
      type: 'prescription',
      title: 'Đơn thuốc',
      date: '2026-02-09',
      facility: 'Bệnh viện Đại học Y Dược TP.HCM - Phòng khám Bệnh viện Đại học Y Dược 1',
      doctorName: 'BS. ThS.BS. Đặng Đồng Quốc Chí',
      diagnoses: ['I10 - Bệnh tăng huyết áp vô căn (nguyên phát)', 'E11 - Bệnh đái tháo đường không phụ thuộc insulin', 'E78.2 - Tăng lipid máu hỗn hợp'],
      medications: [{ name: 'METFORMIN HCL 850/SITAGLIPTIN 50', dosage: '50mg+850mg' }],
      metrics: sharedMetrics,
      nextFollowUp: '2026-05-09',
      recordedAt: '2026-02-09T07:40:00.000Z',
    };
    const remoteStaleProfile: HealthProfile = {
      schemaVersion: 2,
      member,
      timeline: [labEvent, rxEvent],
      sources: [
        { ...makeSource('file-lab'), fileName: 'lab-0902.jpg', fileHash: '1'.repeat(64) },
        {
          ...makeSource('file-rx'),
          fileName: 'rx-0902.jpg',
          fileHash: '2'.repeat(64),
          sourceContributions: [
            {
              fileName: 'lab-0902.jpg',
              fileHash: '1'.repeat(64),
              hashAlgorithm: 'sha256',
              uploadedAt: '2026-02-09T07:35:00.000Z',
              disposition: 'included',
              reason: 'Nội dung nằm trọn trong bản đầy đủ hơn',
              mergedIntoEventId: 'ev-lab-split',
            },
          ],
        },
      ],
      summary: { latestDiagnoses: [], latestMetrics: {} },
      createdAt: labEvent.recordedAt,
      updatedAt: rxEvent.recordedAt,
    };

    let currentProfile = remoteStaleProfile;
    const deleteFile = vi.fn(async () => undefined);

    const result = await cleanupWorkspaceDuplicates(
      workspace,
      async () => currentProfile,
      async (_fileId, incoming) => {
        // Mô phỏng hành vi saveHealthProfileRemote: luôn merge với bản cũ nhất trên Drive!
        currentProfile = mergeHealthProfiles(remoteStaleProfile, incoming);
        return currentProfile;
      },
      async () => rawFiles,
      deleteFile,
    );

    expect(result.mergedEvents).toBeGreaterThanOrEqual(1);
    expect(currentProfile.timeline).toHaveLength(1);
    expect(currentProfile.timeline[0].id).toBe('ev-rx-main');
    expect(currentProfile.timeline[0].type).toBe('prescription');
    expect(currentProfile.deletedEvents?.map((t) => t.id)).toContain('ev-lab-split');
    expect(
      currentProfile.sources.find((s) => s.driveFileId === 'file-rx')?.sourceContributions?.[0]?.mergedIntoEventId,
    ).toBe('ev-rx-main');
  });
});
