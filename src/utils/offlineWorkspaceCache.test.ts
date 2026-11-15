import { describe, expect, it } from 'vitest';
import type { HealthDriveWorkspace } from './healthDriveService';
import {
  hasNativeOfflineCache,
  loadNativeOfflineState,
  LOCAL_PROFILES_KEY,
  LOCAL_WORKSPACE_KEY,
  offlineCacheKey,
} from './offlineWorkspaceCache';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  } as Storage;
}

function workspace(adminEmail: string): HealthDriveWorkspace {
  return {
    rootFolderId: 'drive-root-1',
    familyFileId: 'family-file-1',
    family: {
      schemaVersion: 1,
      adminEmail,
      rawFilesFolderId: 'raw-folder',
      profilesFolderId: 'profiles-folder',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      members: [{
        id: 'member-1',
        name: 'Member One',
        driveFolderId: 'member-folder',
        profileFileId: 'profile-file',
      }],
    },
  };
}

describe('native offline workspace cache', () => {
  it('keeps a legacy cache when another account logs out or signs in', () => {
    const storage = createMemoryStorage();
    const legacy = workspace('owner@example.com');
    storage.setItem(LOCAL_WORKSPACE_KEY, JSON.stringify(legacy));
    storage.setItem(LOCAL_PROFILES_KEY, JSON.stringify({}));

    const loaded = loadNativeOfflineState('different@example.com', storage, true);

    expect(loaded.workspace.rootFolderId).toBe('local_offline_workspace');
    expect(storage.getItem(LOCAL_WORKSPACE_KEY)).toBe(JSON.stringify(legacy));
    expect(storage.getItem(LOCAL_PROFILES_KEY)).toBe('{}');
  });

  it('migrates a matching legacy account cache without losing its member data', () => {
    const storage = createMemoryStorage();
    const legacy = workspace(' Owner@Example.com ');
    storage.setItem(LOCAL_WORKSPACE_KEY, JSON.stringify(legacy));
    storage.setItem(LOCAL_PROFILES_KEY, JSON.stringify({ 'member-1': { timeline: [] } }));

    const loaded = loadNativeOfflineState('owner@example.com', storage, true);

    expect(loaded.workspace.rootFolderId).toBe('drive-root-1');
    expect(loaded.workspace.family.members[0].name).toBe('Member One');
    expect(storage.getItem(offlineCacheKey(LOCAL_WORKSPACE_KEY, 'owner@example.com')))
      .toBe(JSON.stringify(legacy));
    expect(storage.getItem(LOCAL_WORKSPACE_KEY)).toBeNull();
  });

  it('recognizes account cache only when it contains a valid workspace with members', () => {
    const storage = createMemoryStorage();
    const email = 'owner@example.com';
    const key = offlineCacheKey(LOCAL_WORKSPACE_KEY, email);
    storage.setItem(key, JSON.stringify(workspace(email)));

    expect(hasNativeOfflineCache(email, storage)).toBe(true);
    expect(hasNativeOfflineCache('other@example.com', storage)).toBe(false);
  });
});
