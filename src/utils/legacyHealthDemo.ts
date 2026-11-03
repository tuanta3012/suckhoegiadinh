const LEGACY_WORKSPACE_KEY = 'health_family_local_workspace_v2';

const LEGACY_SAMPLE_MEMBERS = [
  { id: 'member_bo', driveFolderId: 'local_bo_folder', profileFileId: 'local_bo_profile' },
  { id: 'member_me', driveFolderId: 'local_me_folder', profileFileId: 'local_me_profile' },
  { id: 'member_con', driveFolderId: 'local_con_folder', profileFileId: 'local_con_profile' },
] as const;

interface LegacyWorkspaceStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export function clearLegacyHealthDemoData(storage: LegacyWorkspaceStorage): boolean {
  const savedWorkspace = storage.getItem(LEGACY_WORKSPACE_KEY);
  if (!savedWorkspace) return false;

  const parsed: unknown = JSON.parse(savedWorkspace);
  if (typeof parsed !== 'object' || parsed === null) return false;
  const candidate = parsed as {
    rootFolderId?: unknown;
    isLocal?: unknown;
    family?: { members?: unknown };
  };
  if (
    candidate.rootFolderId !== 'local_root_folder' ||
    candidate.isLocal !== true ||
    !Array.isArray(candidate.family?.members) ||
    candidate.family.members.length === 0
  ) {
    return false;
  }

  const allMembersAreSamples = candidate.family.members.every((member: unknown) => {
    if (typeof member !== 'object' || member === null) return false;
    const savedMember = member as Record<string, unknown>;
    return LEGACY_SAMPLE_MEMBERS.some(
      (sample) =>
        savedMember.id === sample.id &&
        savedMember.driveFolderId === sample.driveFolderId &&
        savedMember.profileFileId === sample.profileFileId
    );
  });
  if (!allMembersAreSamples) return false;

  storage.removeItem(LEGACY_WORKSPACE_KEY);
  for (const member of LEGACY_SAMPLE_MEMBERS) {
    storage.removeItem(`health_local_profile_${member.id}`);
  }
  return true;
}
