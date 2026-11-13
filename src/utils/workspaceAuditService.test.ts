import { describe, expect, it, vi } from 'vitest';
import type { FamilyMember, HealthEvent, HealthProfile } from '../types';
import type { DriveFile, HealthDriveWorkspace } from './healthDriveService';
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
});
