import { describe, expect, it } from 'vitest';
import { clearLegacyHealthDemoData } from './legacyHealthDemo';

const demoWorkspace = {
  rootFolderId: 'local_root_folder',
  isLocal: true,
  family: {
    members: [
      { id: 'member_bo', driveFolderId: 'local_bo_folder', profileFileId: 'local_bo_profile' },
      { id: 'member_me', driveFolderId: 'local_me_folder', profileFileId: 'local_me_profile' },
      { id: 'member_con', driveFolderId: 'local_con_folder', profileFileId: 'local_con_profile' },
    ],
  },
};

function createStorage(values: Record<string, string>) {
  const items = new Map(Object.entries(values));
  return {
    items,
    storage: {
      getItem: (key: string) => items.get(key) || null,
      removeItem: (key: string) => items.delete(key),
    },
  };
}

describe('legacy health demo cleanup', () => {
  it('removes the seeded local workspace and its sample profiles', () => {
    const { items, storage } = createStorage({
      health_family_local_workspace_v2: JSON.stringify(demoWorkspace),
      health_local_profile_member_bo: '{}',
      health_local_profile_member_me: '{}',
      health_local_profile_member_con: '{}',
      health_local_profile_real_member: '{"timeline":[{"id":"real-event"}]}',
    });

    expect(clearLegacyHealthDemoData(storage)).toBe(true);
    expect(items.has('health_family_local_workspace_v2')).toBe(false);
    expect(items.has('health_local_profile_member_bo')).toBe(false);
    expect(items.has('health_local_profile_member_me')).toBe(false);
    expect(items.has('health_local_profile_member_con')).toBe(false);
    expect(items.has('health_local_profile_real_member')).toBe(true);
  });

  it('preserves local workspaces that are not the seeded demo', () => {
    const { items, storage } = createStorage({
      health_family_local_workspace_v2: JSON.stringify({
        ...demoWorkspace,
        rootFolderId: 'user-created-workspace',
      }),
      health_local_profile_member_bo: '{"timeline":[{"id":"real-event"}]}',
    });

    expect(clearLegacyHealthDemoData(storage)).toBe(false);
    expect(items.has('health_family_local_workspace_v2')).toBe(true);
    expect(items.has('health_local_profile_member_bo')).toBe(true);
  });

  it('preserves a workspace containing any non-seed member', () => {
    const { items, storage } = createStorage({
      health_family_local_workspace_v2: JSON.stringify({
        ...demoWorkspace,
        family: {
          members: [
            ...demoWorkspace.family.members,
            { id: 'real-member', driveFolderId: 'real-folder', profileFileId: 'real-profile' },
          ],
        },
      }),
      health_local_profile_member_bo: '{}',
    });

    expect(clearLegacyHealthDemoData(storage)).toBe(false);
    expect(items.has('health_family_local_workspace_v2')).toBe(true);
    expect(items.has('health_local_profile_member_bo')).toBe(true);
  });
});
