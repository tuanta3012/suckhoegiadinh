import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureDriveFolderAccess,
  deleteDriveFile,
  deleteDriveFamilyMember,
  openHealthWorkspace,
  openAssignedHealthWorkspace,
  resolveSingleFamilyManifestFile,
  stampHealthWorkspaceFolder,
  syncHealthWorkspaceMemberAssignments,
  updateDriveFamilyMember,
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

  describe('deleteDriveFile', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.unstubAllGlobals();
    });

    it('treats a missing Drive file as already deleted without requesting reauthorization', async () => {
      const eventTypes: string[] = [];
      vi.stubGlobal('window', {
        dispatchEvent: (event: Event) => {
          eventTypes.push(event.type);
          return true;
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

      await expect(deleteDriveFile('missing-folder')).resolves.toBeUndefined();
      expect(eventTypes).not.toContain('google-drive-request-error');
    });

    it('continues to report actual Drive deletion errors', async () => {
      const eventTypes: string[] = [];
      vi.stubGlobal('window', {
        dispatchEvent: (event: Event) => {
          eventTypes.push(event.type);
          return true;
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Permission denied' } }), { status: 403 }),
      );

      await expect(deleteDriveFile('protected-folder')).rejects.toThrow('Permission denied');
      expect(eventTypes).toContain('google-drive-request-error');
    });
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

    it('reports incomplete revocation while removing the member assignment', async () => {
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
        if (init?.method === 'DELETE') {
          return new Response(JSON.stringify({ error: { message: 'Inherited permission' } }), { status: 403 });
        }
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

      await expect(syncHealthWorkspaceMemberAssignments(
        { ...workspace, family: { ...workspace.family, members: [] } },
        ['old@example.com'],
      )).rejects.toThrow('Chưa thu hồi hoàn tất quyền của thành viên đã gỡ');
      expect(removeHealthWorkspaceAssignment).toHaveBeenCalledWith('workspace-1', 'old@example.com');
    });

    it('blocks non-admins from editing or deleting existing members', async () => {
      const sharedWorkspace = {
        rootFolderId: 'workspace-1',
        familyFileId: 'family-1',
        family: {
          ...workspace.family,
          adminEmail: 'admin@example.com',
          members: [{
            id: 'member-1',
            name: 'Family member',
            email: 'member@example.com',
            role: 'other' as const,
            driveFolderId: 'member-folder',
            profileFileId: 'member-profile',
          }],
        },
      };

      await expect(updateDriveFamilyMember(sharedWorkspace, 'member-1', { name: 'Changed' }))
        .rejects.toThrow('Chỉ Admin của Workspace mới được chỉnh sửa thông tin thành viên.');
      await expect(deleteDriveFamilyMember(sharedWorkspace, 'member-1'))
        .rejects.toThrow('Chỉ Admin của Workspace mới được xóa thành viên.');
    });

    it('does not open a cached workspace for an email removed from family.json', async () => {
      const family = {
        schemaVersion: 1,
        adminEmail: 'admin@example.com',
        rawFilesFolderId: 'raw-folder',
        profilesFolderId: 'profiles-folder',
        members: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      globalThis.fetch = vi.fn().mockImplementation(async (rawUrl: string) => {
        const url = new URL(rawUrl);
        if (url.pathname.endsWith('/family-1') && url.searchParams.get('alt') === 'media') {
          return new Response(JSON.stringify(family), { status: 200 });
        }
        if (url.pathname.endsWith('/family-1')) {
          return new Response(JSON.stringify({
            id: 'family-1',
            name: 'family.json',
            mimeType: 'application/json',
            parents: ['folder-1'],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: 'folder-1',
          name: 'Suc khoe gia dinh',
          mimeType: 'application/vnd.google-apps.folder',
        }), { status: 200 });
      });

      await expect(openHealthWorkspace('folder-1', 'family-1'))
        .rejects.toThrow('Email đang đăng nhập không còn trong danh sách thành viên Workspace.');
    });

    it('does not publish the Firestore assignment when Drive permission verification fails', async () => {
      vi.mocked(listHealthWorkspaceAssignments).mockResolvedValue([]);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'permission denied' },
      }), { status: 403 }));

      await expect(syncHealthWorkspaceMemberAssignments(workspace)).rejects.toThrow(
        'Chưa thể xác nhận quyền Drive',
      );
      expect(publishHealthWorkspaceAssignments).not.toHaveBeenCalled();
    });

    it('serializes overlapping assignment syncs so the latest family email is published last', async () => {
      let resolveInitialRead!: (assignments: []) => void;
      const initialRead = new Promise<[]>(resolve => {
        resolveInitialRead = resolve;
      });
      vi.mocked(listHealthWorkspaceAssignments)
        .mockReturnValueOnce(initialRead)
        .mockResolvedValue([]);
      const publishedEmails: string[][] = [];
      vi.mocked(publishHealthWorkspaceAssignments).mockImplementation(
        async (_rootId, _familyFileId, _adminEmail, assignments) => {
          publishedEmails.push(assignments.map(({ email }) => email));
        },
      );
      let granted = false;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          granted = true;
          return new Response(JSON.stringify({
            id: 'permission-new',
            type: 'user',
            emailAddress: 'member@example.com',
            role: 'writer',
            permissionDetails: [{ inherited: false }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          permissions: granted
            ? [{
                id: 'permission-new',
                type: 'user',
                emailAddress: 'member@example.com',
                role: 'writer',
                permissionDetails: [{ inherited: false }],
              }]
            : [],
        }), { status: 200 });
      });

      const initialWorkspace = {
        ...workspace,
        family: { ...workspace.family, members: [] },
      };
      const updatedWorkspace = {
        ...workspace,
        family: {
          ...workspace.family,
          members: [
            ...workspace.family.members,
            {
              id: 'member-2',
              name: 'New family member',
              email: 'member@example.com',
              role: 'other' as const,
              driveFolderId: 'raw-2',
              profileFileId: 'profile-2',
            },
          ],
        },
      };
      const initialSync = syncHealthWorkspaceMemberAssignments(initialWorkspace);
      const updatedSync = syncHealthWorkspaceMemberAssignments(updatedWorkspace);
      resolveInitialRead([]);
      await Promise.all([initialSync, updatedSync]);

      expect(publishedEmails).toEqual([[], ['member@example.com']]);
    });
  });

  describe('ensureDriveFolderAccess', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    describe('shared workspace connection', () => {
      const originalFetch = globalThis.fetch;

      afterEach(() => {
        globalThis.fetch = originalFetch;
      });

      it('stamps and verifies the Drive folder app property', async () => {
        let properties: Record<string, string> = {};
        globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'PATCH') {
            properties = JSON.parse(String(init.body)).appProperties;
          }
          return new Response(JSON.stringify({
            id: 'folder-1',
            name: 'Suc khoe gia dinh',
            mimeType: 'application/vnd.google-apps.folder',
            appProperties: properties,
          }), { status: 200 });
        });

        await stampHealthWorkspaceFolder('folder-1');

        const patch = vi.mocked(globalThis.fetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
        expect(JSON.parse(String(patch?.[1]?.body)).appProperties).toEqual({
          app_id: 'com.suckhoegiadinh.app',
        });
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      });

      it('opens the assigned folder only after family.json confirms the member identity', async () => {
        let properties: Record<string, string> = {};
        const family = {
          schemaVersion: 1,
          adminEmail: 'admin@example.com',
          rawFilesFolderId: 'raw-folder',
          profilesFolderId: 'profiles-folder',
          members: [{
            id: 'member-1',
            name: 'Family member',
            email: 'user@example.com',
            role: 'other',
            driveFolderId: 'member-folder',
            profileFileId: 'profile-file',
          }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
        globalThis.fetch = vi.fn().mockImplementation(async (rawUrl: string, init?: RequestInit) => {
          const url = new URL(rawUrl);
          if (url.pathname.endsWith('/family-1') && url.searchParams.get('alt') === 'media') {
            return new Response(JSON.stringify(family), { status: 200 });
          }
          if (url.pathname.endsWith('/family-1')) {
            return new Response(JSON.stringify({
              id: 'family-1',
              name: 'family.json',
              mimeType: 'application/json',
              parents: ['folder-1'],
            }), { status: 200 });
          }
          if (url.pathname.endsWith('/files') && url.searchParams.has('q')) {
            return new Response(JSON.stringify({
              files: [{
                id: 'family-1',
                name: 'family.json',
                mimeType: 'application/json',
                createdTime: '2026-01-01T00:00:00.000Z',
              }],
            }), { status: 200 });
          }
          if (init?.method === 'PATCH') {
            properties = JSON.parse(String(init.body)).appProperties;
          }
          return new Response(JSON.stringify({
            id: 'folder-1',
            name: 'Suc khoe gia dinh',
            mimeType: 'application/vnd.google-apps.folder',
            appProperties: properties,
          }), { status: 200 });
        });

        const workspace = await openAssignedHealthWorkspace({
          rootFolderId: 'folder-1',
          familyFileId: 'family-1',
          adminEmail: 'admin@example.com',
          memberEmail: 'user@example.com',
          role: 'EDITOR',
          updatedAt: 1,
        }, 'user@example.com');

        expect(workspace.family.members[0].email).toBe('user@example.com');
      });
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

    it('creates Drive permission without sending a notification email', async () => {
      let granted = false;
      const permission = {
        id: 'permission-new',
        type: 'user',
        emailAddress: 'member@example.com',
        role: 'writer',
        permissionDetails: [{ inherited: false }],
      };
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          granted = true;
          return new Response(JSON.stringify(permission), { status: 200 });
        }
        return new Response(JSON.stringify({
          permissions: granted ? [permission] : [],
        }), { status: 200 });
      });

      await ensureDriveFolderAccess('folder-1', 'member@example.com', 'EDITOR');

      const createRequest = vi.mocked(globalThis.fetch).mock.calls.find(
        ([, init]) => init?.method === 'POST',
      );
      expect(createRequest?.[0]).toContain('sendNotificationEmail=false');
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
