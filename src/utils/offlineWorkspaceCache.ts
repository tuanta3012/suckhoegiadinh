import { Capacitor } from '@capacitor/core';
import type { HealthProfile } from '../types';
import { createHealthProfile } from './healthProfile';
import type { HealthDriveWorkspace } from './healthDriveService';

export const PROFILE_ROOT_KEY = 'health_family_drive_root_id';
export const LOCAL_WORKSPACE_KEY = 'health_offline_workspace_v2';
export const LOCAL_PROFILES_KEY = 'health_offline_profiles_v2';

export interface NativeOfflineState {
  workspace: HealthDriveWorkspace;
  profiles: Record<string, HealthProfile>;
}

export function offlineCacheKey(baseKey: string, userEmail: string | null): string {
  return `${baseKey}_${encodeURIComponent(userEmail?.trim().toLowerCase() || 'guest')}`;
}

export function createDefaultLocalWorkspace(adminEmail: string | null): HealthDriveWorkspace {
  return {
    rootFolderId: 'local_offline_workspace',
    familyFileId: 'local_family_file',
    family: {
      schemaVersion: 1,
      rawFilesFolderId: 'local_raw_folder',
      profilesFolderId: 'local_profiles_folder',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      adminEmail: adminEmail || 'offline@user',
      members: [],
    },
  };
}

export function loadNativeOfflineState(
  userEmail: string | null,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined =
    typeof localStorage === 'undefined' ? undefined : localStorage,
  isNative = Capacitor.isNativePlatform(),
): NativeOfflineState {
  const workspace = createDefaultLocalWorkspace(userEmail);
  const fallback: NativeOfflineState = { workspace, profiles: {} };
  if (!isNative || !storage) return fallback;

  const workspaceKey = offlineCacheKey(LOCAL_WORKSPACE_KEY, userEmail);
  const profilesKey = offlineCacheKey(LOCAL_PROFILES_KEY, userEmail);
  let serializedWorkspace = storage.getItem(workspaceKey);
  let serializedProfiles = storage.getItem(profilesKey);
  let migratingLegacyCache = false;
  if (!serializedWorkspace) {
    const legacyWorkspace = storage.getItem(LOCAL_WORKSPACE_KEY);
    if (legacyWorkspace) {
      try {
        const parsed = JSON.parse(legacyWorkspace) as HealthDriveWorkspace;
        const expectedEmail = userEmail?.trim().toLowerCase() || 'offline@user';
        const cachedAdminEmail = parsed.family?.adminEmail?.trim().toLowerCase();
        if (cachedAdminEmail === expectedEmail) {
          serializedWorkspace = legacyWorkspace;
          serializedProfiles = storage.getItem(LOCAL_PROFILES_KEY);
          migratingLegacyCache = true;
        }
      } catch (error) {
        console.warn('[Offline cache] Legacy workspace cache is invalid; preserving it for recovery.', error);
      }
    }
  }
  if (!serializedWorkspace) return fallback;

  try {
    const parsedWorkspace = JSON.parse(serializedWorkspace) as HealthDriveWorkspace;
    if (
      !parsedWorkspace?.family ||
      typeof parsedWorkspace.rootFolderId !== 'string' ||
      !Array.isArray(parsedWorkspace.family.members)
    ) return fallback;

    const parsedProfiles = serializedProfiles
      ? JSON.parse(serializedProfiles) as Record<string, HealthProfile>
      : {};
    if (!parsedProfiles || typeof parsedProfiles !== 'object' || Array.isArray(parsedProfiles)) {
      throw new Error('Dữ liệu hồ sơ ngoại tuyến không hợp lệ.');
    }
    if (migratingLegacyCache) {
      storage.setItem(workspaceKey, serializedWorkspace);
      if (serializedProfiles) storage.setItem(profilesKey, serializedProfiles);
      storage.removeItem(LOCAL_WORKSPACE_KEY);
      storage.removeItem(LOCAL_PROFILES_KEY);
    }
    if (parsedWorkspace.rootFolderId !== 'local_offline_workspace' && userEmail) {
      storage.setItem(
        `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`,
        parsedWorkspace.rootFolderId,
      );
    }
    if (parsedWorkspace.rootFolderId === 'local_offline_workspace') {
      for (const member of parsedWorkspace.family.members) {
        parsedProfiles[member.id] ||= createHealthProfile(member);
      }
    }
    return { workspace: parsedWorkspace, profiles: parsedProfiles };
  } catch (error) {
    console.warn('[Offline cache] Could not restore native workspace data.', error);
    return fallback;
  }
}

export function hasNativeOfflineCache(
  userEmail: string,
  storage: Pick<Storage, 'getItem'> | undefined =
    typeof localStorage === 'undefined' ? undefined : localStorage,
): boolean {
  if (!storage || !userEmail.trim()) return false;
  const workspaceValue = storage.getItem(offlineCacheKey(LOCAL_WORKSPACE_KEY, userEmail));
  if (!workspaceValue) return false;
  try {
    const workspace = JSON.parse(workspaceValue) as HealthDriveWorkspace;
    return typeof workspace.rootFolderId === 'string' &&
      Array.isArray(workspace.family?.members) &&
      workspace.family.members.length > 0;
  } catch {
    return false;
  }
}

export function loadGuestLocalState(
  storage: Pick<Storage, 'getItem'> | undefined =
    typeof localStorage === 'undefined' ? undefined : localStorage,
  isNative = Capacitor.isNativePlatform(),
): NativeOfflineState | null {
  if (!isNative || !storage) return null;
  try {
    const workspaceValue = storage.getItem(offlineCacheKey(LOCAL_WORKSPACE_KEY, null));
    if (!workspaceValue) return null;
    const workspace = JSON.parse(workspaceValue) as HealthDriveWorkspace;
    if (
      workspace.rootFolderId !== 'local_offline_workspace' ||
      !Array.isArray(workspace.family?.members)
    ) return null;
    const profilesValue = storage.getItem(offlineCacheKey(LOCAL_PROFILES_KEY, null));
    const profiles = profilesValue ? JSON.parse(profilesValue) as Record<string, HealthProfile> : {};
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
      throw new Error('Dữ liệu hồ sơ ngoại tuyến không hợp lệ.');
    }
    for (const member of workspace.family.members) {
      profiles[member.id] ||= createHealthProfile(member);
    }
    return { workspace, profiles };
  } catch (error) {
    console.warn('[Offline cache] Could not inspect guest data for Drive import.', error);
    return null;
  }
}
