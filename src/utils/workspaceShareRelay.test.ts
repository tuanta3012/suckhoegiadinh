import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listHealthWorkspaceAssignments,
  publishHealthWorkspaceAssignments,
  readHealthWorkspaceAssignment,
  registerHealthWorkspaceRelay,
} from './workspaceShareRelay';

const mocks = vi.hoisted(() => {
  const batchSet = vi.fn();
  const batchCommit = vi.fn().mockResolvedValue(undefined);
  return {
    batchCommit,
    batchSet,
    collection: vi.fn((...parts: unknown[]) => parts.slice(1).join('/')),
    doc: vi.fn((...parts: unknown[]) => parts.slice(1).join('/')),
    getDoc: vi.fn(),
    getDocs: vi.fn(),
    onSnapshot: vi.fn(),
    query: vi.fn((...parts: unknown[]) => parts),
    setDoc: vi.fn(),
    where: vi.fn((...parts: unknown[]) => parts),
    writeBatch: vi.fn(() => ({
      commit: batchCommit,
      delete: vi.fn(),
      set: batchSet,
      update: vi.fn(),
    })),
  };
});

vi.mock('firebase/firestore', () => ({
  collection: mocks.collection,
  doc: mocks.doc,
  getDoc: mocks.getDoc,
  getDocs: mocks.getDocs,
  onSnapshot: mocks.onSnapshot,
  query: mocks.query,
  setDoc: mocks.setDoc,
  where: mocks.where,
  writeBatch: mocks.writeBatch,
}));

vi.mock('./firebaseFirestore', () => ({
  firestoreAuth: { currentUser: { email: 'admin@example.com', uid: 'admin-uid' } },
  firestoreDb: {},
}));

vi.mock('./googleDriveService', () => ({
  getSignedInGoogleEmail: () => 'admin@example.com',
}));

describe('workspace access relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a member directly from one normalized email-keyed access record', async () => {
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        email: 'member@example.com',
        familyId: 'root-folder',
        rootFolderId: 'root-folder',
        familyFileId: 'family-file',
        adminEmail: 'admin@example.com',
        adminUid: 'admin-uid',
        role: 'EDITOR',
        status: 'active',
        updatedAt: 123,
      }),
    });

    await expect(readHealthWorkspaceAssignment(' Member@Example.com ')).resolves.toEqual({
      rootFolderId: 'root-folder',
      familyFileId: 'family-file',
      adminEmail: 'admin@example.com',
      memberEmail: 'member@example.com',
      role: 'EDITOR',
      updatedAt: 123,
      source: undefined,
    });
    expect(mocks.doc).toHaveBeenCalledWith({}, 'workspaceAccess', 'member@example.com');
    expect(mocks.getDoc).toHaveBeenCalledTimes(1);
  });

  it('publishes the Admin and all member permissions in workspaceAccess only', async () => {
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ adminUid: 'admin-uid', status: 'active' }),
    });

    await publishHealthWorkspaceAssignments(
      'root-folder',
      'family-file',
      ' ADMIN@Example.com ',
      [{
        email: ' Member@Example.com ',
        role: 'EDITOR',
        source: 'family_member',
      }],
    );

    expect(mocks.batchSet).toHaveBeenCalledTimes(2);
    expect(mocks.batchSet).toHaveBeenNthCalledWith(
      2,
      'workspaceAccess/member@example.com',
      expect.objectContaining({
        email: 'member@example.com',
        rootFolderId: 'root-folder',
        familyFileId: 'family-file',
        adminUid: 'admin-uid',
        status: 'active',
      }),
      { merge: true },
    );
    expect(mocks.batchCommit).toHaveBeenCalledOnce();
  });

  it('recreates the Admin and member access records when the collection is empty', async () => {
    mocks.getDoc
      .mockResolvedValueOnce({ exists: () => false })
      .mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ adminUid: 'admin-uid', status: 'active' }),
      });

    await registerHealthWorkspaceRelay('root-folder', 'family-file', 'admin@example.com');
    await publishHealthWorkspaceAssignments(
      'root-folder',
      'family-file',
      'admin@example.com',
      [{ email: 'member@example.com', role: 'EDITOR' }],
    );

    expect(mocks.setDoc).toHaveBeenCalledWith(
      'workspaceAccess/admin@example.com',
      expect.objectContaining({
        email: 'admin@example.com',
        rootFolderId: 'root-folder',
        role: 'ADMIN',
        status: 'active',
      }),
      { merge: true },
    );
    expect(mocks.batchSet).toHaveBeenCalledWith(
      'workspaceAccess/member@example.com',
      expect.objectContaining({
        email: 'member@example.com',
        rootFolderId: 'root-folder',
        role: 'EDITOR',
        status: 'active',
      }),
      { merge: true },
    );
  });

  it('uses the single collection after the Admin completes the legacy migration', async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{
        data: () => ({
          email: 'admin@example.com',
          familyId: 'root-folder',
          rootFolderId: 'root-folder',
          familyFileId: 'family-file',
          adminEmail: 'admin@example.com',
          adminUid: 'admin-uid',
          role: 'ADMIN',
          status: 'active',
          updatedAt: 123,
          migrationComplete: true,
        }),
      }, {
        data: () => ({
          email: 'member@example.com',
          familyId: 'root-folder',
          rootFolderId: 'root-folder',
          familyFileId: 'family-file',
          adminEmail: 'admin@example.com',
          adminUid: 'admin-uid',
          role: 'EDITOR',
          status: 'active',
          updatedAt: 123,
        }),
      }],
    });

    await expect(listHealthWorkspaceAssignments('root-folder')).resolves.toHaveLength(2);
    expect(mocks.getDocs).toHaveBeenCalledTimes(1);
  });

  it('reads legacy invitations only while the Admin migration is incomplete', async () => {
    mocks.getDocs
      .mockResolvedValueOnce({
        docs: [{
          data: () => ({
            email: 'admin@example.com',
            familyId: 'root-folder',
            rootFolderId: 'root-folder',
            familyFileId: 'family-file',
            adminEmail: 'admin@example.com',
            adminUid: 'admin-uid',
            role: 'ADMIN',
            status: 'active',
            updatedAt: 123,
            migrationComplete: false,
          }),
        }],
      })
      .mockResolvedValueOnce({
        docs: [{
          id: 'member@example.com',
          data: () => ({
            familyId: 'root-folder',
            adminEmail: 'admin@example.com',
            role: 'EDITOR',
            updatedAt: 123,
          }),
        }],
      });

    const assignments = await listHealthWorkspaceAssignments('root-folder');

    expect(assignments.map(assignment => assignment.memberEmail)).toContain('member@example.com');
    expect(mocks.getDocs).toHaveBeenCalledTimes(2);
  });
});
