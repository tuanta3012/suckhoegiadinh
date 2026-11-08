import { describe, expect, it } from 'vitest';
import {
  completeMemberDeletion,
  queueMemberDeletion,
  readPendingMemberDeletions,
} from './pendingMemberDeletions';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('pending member deletions', () => {
  it('stores deletions by workspace and deduplicates repeated requests', () => {
    const storage = new MemoryStorage();
    queueMemberDeletion('workspace-1', {
      memberId: 'member-1',
      email: 'person@example.com',
      revokeSharedAccess: true,
      queuedAt: 1,
    }, storage);
    queueMemberDeletion('workspace-1', {
      memberId: 'member-1',
      email: 'person@example.com',
      revokeSharedAccess: true,
      queuedAt: 2,
    }, storage);
    queueMemberDeletion('workspace-2', {
      memberId: 'member-2',
      revokeSharedAccess: false,
      queuedAt: 3,
    }, storage);

    expect(readPendingMemberDeletions('workspace-1', storage)).toHaveLength(1);
    expect(readPendingMemberDeletions('workspace-1', storage)[0].queuedAt).toBe(2);
    expect(readPendingMemberDeletions('workspace-2', storage)[0].memberId).toBe('member-2');
  });

  it('removes completed deletions and cleans up an empty queue', () => {
    const storage = new MemoryStorage();
    queueMemberDeletion('workspace-1', {
      memberId: 'member-1',
      revokeSharedAccess: true,
      queuedAt: 1,
    }, storage);

    expect(completeMemberDeletion('workspace-1', 'member-1', storage)).toEqual([]);
    expect(readPendingMemberDeletions('workspace-1', storage)).toEqual([]);
  });

  it('rejects malformed queued deletions rather than dropping them', () => {
    const storage = new MemoryStorage();
    storage.setItem('health_pending_member_deletions_v1_workspace-1', '[{}]');
    expect(() => readPendingMemberDeletions('workspace-1', storage)).toThrow('không hợp lệ');
  });
});
