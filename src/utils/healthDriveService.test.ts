import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureDriveFolderAccess,
  openAssignedHealthWorkspace,
  resolveSingleFamilyManifestFile,
  syncHealthWorkspaceMemberAssignments,
} from './healthDriveService';
import {
  listHealthWorkspaceAssignments,
  publishHealthWorkspaceAssignments,
  removeHealthWorkspaceAssignment,
} from './workspaceShareRelay';

vi.mock('./workspaceShareRelay', () => ({
  findAdminWorkspaceRelay: vi.fn(),
  listHealthWorkspaceAssignments: vi.fn(),
  publishHealthWorkspaceAssignments: vi.fn(),
  readHealthWorkspaceAssignment: vi.fn(),
  registerHealthWorkspaceRelay: vi.fn(),
  removeHealthWorkspaceAssignment: vi.fn(),
  unregisterHealthWorkspace: vi.fn(),
}));

vi.mock('./googleDriveService', () => ({
  getValidGoogleAccessToken: vi.fn().mockResolvedValue('test-token'),
  getGoogleAccessToken: vi.fn().mockReturnValue('test-token'),
  trySilentRefresh: vi.fn().mockResolvedValue(null),
  getSignedInGoogleEmail: vi.fn().mockReturnValue('user@example.com'),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => false,
    },
  };
});

describe('resolveSingleFamilyManifestFile', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('syncHealthWorkspaceMemberAssignments', () => {
    const originalFetch = globalThis.fetch;
    const workspace = {
      rootFolderId: 'workspace-1',
      familyFileId: 'family-1',
      family: {
        schemaVersion: 1 as const,
        adminEmail: 'user@example.com',
        rawFilesFolderId: 'raw-1',
        profilesFolderId: 'profiles-1',
        members: [{
          id: 'member-1',
          name: 'Family member',
          role: 'other' as const,
          email: 'member@example.com',
          driveFolderId: 'raw-member-1',
          profileFileId: 'profile-1',
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('grants family members Editor and preserves separate invitations', async () => {
      vi.mocked(listHealthWorkspaceAssignments).mockResolvedValue([{
        rootFolderId: 'workspace-1',
        familyFileId: 'family-1',
        adminEmail: 'user@example.com',
        memberEmail: 'guest@example.com',
        role: 'VIEWER',
        updatedAt: 1,
      }]);
      vi.mocked(publishHealthWorkspaceAssignments).mockResolvedValue();
      globalThis.fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        permissions: [{
          id: 'member-permission',
          type: 'user',
          emailAddress: 'member@example.com',
          role: 'writer',
          permissionDetails: [{ inherited: false }],
        }],
      }), { status: 200 }));

      await syncHealthWorkspaceMemberAssignments(workspace);

      expect(publishHealthWorkspaceAssignments).toHaveBeenCalledWith(
        'workspace-1',
        'family-1',
        'user@example.com',
        expect.arrayContaining([
          { email: 'member@example.com', role: 'EDITOR', source: 'family_member' },
          { email: 'guest@example.com', role: 'VIEWER', source: undefined },
        ]),
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('revokes a removed member and removes the matching Firestore assignment', async () => {
      vi.mocked(listHealthWorkspaceAssignments).mockResolvedValue([{
        rootFolderId: 'workspace-1',
        familyFileId: 'family-1',
        adminEmail: 'user@example.com',
        memberEmail: 'old@example.com',
        role: 'EDITOR',
        updatedAt: 1,
        source: 'family_member',
      }]);
      vi.mocked(publishHealthWorkspaceAssignments).mockResolvedValue();
      vi.mocked(removeHealthWorkspaceAssignment).mockResolvedValue();
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return new Response(JSON.stringify({
          permissions: [{
            id: 'old-permission',
            type: 'user',
            emailAddress: 'old@example.com',
            role: 'writer',
            permissionDetails: [{ inherited: false }],
          }],
        }), { status: 200 });
      });

      await syncHealthWorkspaceMemberAssignments(
        { ...workspace, family: { ...workspace.family, members: [] } },
        ['old@example.com'],
      );

      expect(publishHealthWorkspaceAssignments).toHaveBeenCalledWith(
        'workspace-1',
        'family-1',
        'user@example.com',
        [],
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(removeHealthWorkspaceAssignment).toHaveBeenCalledWith('workspace-1', 'old@example.com');
    });
  });

  describe('ensureDriveFolderAccess', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('updates and verifies a direct permission for the requested role', async () => {
      const permissions = [{
        id: 'permission-1',
        type: 'user',
        emailAddress: 'member@example.com',
        role: 'writer',
        permissionDetails: [{ inherited: false }],
      }];
      const methods: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        methods.push(init?.method || 'GET');
        if (init?.method === 'PATCH') {
          permissions[0].role = JSON.parse(String(init.body)).role;
          return new Response(JSON.stringify(permissions[0]), { status: 200 });
        }
        if (url.includes('/permissions?')) {
          return new Response(JSON.stringify({ permissions }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      await ensureDriveFolderAccess('folder-1', 'Member@example.com', 'VIEWER');

      expect(methods).toEqual(['GET', 'PATCH', 'GET']);
      expect(permissions[0].role).toBe('reader');
    });

    it('rejects a workspace assignment addressed to another signed-in email', async () => {
      await expect(openAssignedHealthWorkspace({
        rootFolderId: 'folder-1',
        familyFileId: 'manifest-1',
        adminEmail: 'admin@example.com',
        memberEmail: 'other@example.com',
        role: 'EDITOR',
        updatedAt: 1,
      }, 'member@example.com')).rejects.toThrow('không khớp');
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when no family.json file is found', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/files?')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const result = await resolveSingleFamilyManifestFile('root-123');
    expect(result).toBeNull();
  });

  it('returns the single file directly if only one family.json exists', async () => {
    const singleFile = {
      id: 'file-single',
      name: 'family.json',
      mimeType: 'application/json',
      createdTime: '2026-11-10T00:00:00Z',
    };

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/files?')) {
        return new Response(JSON.stringify({ files: [singleFile] }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const result = await resolveSingleFamilyManifestFile('root-123');
    expect(result).toEqual(singleFile);
  });

  it('deduplicates multiple family.json files, keeping the one with most members and deleting duplicates', async () => {
    const fileEmpty = {
      id: 'file-empty-1',
      name: 'family.json',
      mimeType: 'application/json',
      createdTime: '2026-11-10T01:00:00Z',
      modifiedTime: '2026-11-10T01:00:00Z',
    };
    const fileEmpty2 = {
      id: 'file-empty-2',
      name: 'family.json',
      mimeType: 'application/json',
      createdTime: '2026-11-10T02:00:00Z',
      modifiedTime: '2026-11-10T02:00:00Z',
    };
    const fileWithMembers = {
      id: 'file-with-data',
      name: 'family.json',
      mimeType: 'application/json',
      createdTime: '2026-11-10T03:00:00Z',
      modifiedTime: '2026-11-10T03:00:00Z',
    };

    const deletedIds: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        const id = url.split('/files/')[1];
        deletedIds.push(id);
        return new Response(null, { status: 204 });
      }

      if (url.includes('/files?') && !url.includes('alt=media')) {
        return new Response(
          JSON.stringify({ files: [fileEmpty, fileWithMembers, fileEmpty2] }),
          { status: 200 },
        );
      }

      if (url.includes('/files/file-with-data?alt=media')) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            adminEmail: 'user@example.com',
            rawFilesFolderId: 'raw-1',
            profilesFolderId: 'prof-1',
            members: [{ id: 'm1', name: 'Nguyen Van A' }, { id: 'm2', name: 'Le Thi B' }],
            createdAt: '2026-11-10T03:00:00Z',
            updatedAt: '2026-11-10T03:05:00Z',
          }),
          { status: 200 },
        );
      }

      if (url.includes('/files/file-empty-1?alt=media') || url.includes('/files/file-empty-2?alt=media')) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            adminEmail: 'user@example.com',
            rawFilesFolderId: 'raw-1',
            profilesFolderId: 'prof-1',
            members: [],
            createdAt: '2026-11-10T01:00:00Z',
            updatedAt: '2026-11-10T01:00:00Z',
          }),
          { status: 200 },
        );
      }

      return new Response('Not found', { status: 404 });
    });

    const result = await resolveSingleFamilyManifestFile('root-123');
    expect(result?.id).toBe('file-with-data');
    expect(deletedIds).toContain('file-empty-1');
    expect(deletedIds).toContain('file-empty-2');
    expect(deletedIds).not.toContain('file-with-data');
  });
});
