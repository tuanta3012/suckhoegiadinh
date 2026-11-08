export interface PendingMemberDeletion {
  memberId: string;
  email?: string;
  revokeSharedAccess: boolean;
  queuedAt: number;
}

const STORAGE_KEY_PREFIX = 'health_pending_member_deletions_v1_';

function getStorageKey(workspaceRootId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(workspaceRootId)}`;
}

function isPendingMemberDeletion(value: unknown): value is PendingMemberDeletion {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingMemberDeletion>;
  return typeof item.memberId === 'string' &&
    item.memberId.length > 0 &&
    (item.email === undefined || typeof item.email === 'string') &&
    typeof item.revokeSharedAccess === 'boolean' &&
    typeof item.queuedAt === 'number' &&
    Number.isFinite(item.queuedAt);
}

export function readPendingMemberDeletions(
  workspaceRootId: string,
  storage: Storage = localStorage,
): PendingMemberDeletion[] {
  const value = storage.getItem(getStorageKey(workspaceRootId));
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Không đọc được yêu cầu xóa thành viên đang chờ đồng bộ.', { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(isPendingMemberDeletion)) {
    throw new Error('Danh sách yêu cầu xóa thành viên chờ đồng bộ không hợp lệ.');
  }
  return parsed;
}

export function queueMemberDeletion(
  workspaceRootId: string,
  deletion: PendingMemberDeletion,
  storage: Storage = localStorage,
): PendingMemberDeletion[] {
  const queued = readPendingMemberDeletions(workspaceRootId, storage)
    .filter((item) => item.memberId !== deletion.memberId);
  queued.push(deletion);
  storage.setItem(getStorageKey(workspaceRootId), JSON.stringify(queued));
  return queued;
}

export function completeMemberDeletion(
  workspaceRootId: string,
  memberId: string,
  storage: Storage = localStorage,
): PendingMemberDeletion[] {
  const queued = readPendingMemberDeletions(workspaceRootId, storage)
    .filter((item) => item.memberId !== memberId);
  const key = getStorageKey(workspaceRootId);
  if (queued.length) storage.setItem(key, JSON.stringify(queued));
  else storage.removeItem(key);
  return queued;
}
