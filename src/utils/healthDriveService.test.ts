import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveSingleFamilyManifestFile } from './healthDriveService';

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
