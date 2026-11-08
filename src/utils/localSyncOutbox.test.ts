import { describe, expect, it } from 'vitest';
import type { FamilyMember, HealthProfile } from '../types';
import { createLocalSyncOutbox } from './localSyncOutbox';

class MemoryStore {
  private files = new Map<string, string>();
  async list(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
      .map((name) => name.slice(prefix.length));
  }
  async readText(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error('not found');
    return value;
  }
  async writeText(path: string, value: string) {
    this.files.set(path, value);
  }
  async writeBase64(path: string, value: string) {
    this.files.set(path, value);
  }
  async readBase64(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error('not found');
    return value;
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async removeDirectory(path: string) {
    const prefix = `${path}/`;
    for (const name of this.files.keys()) {
      if (name.startsWith(prefix)) this.files.delete(name);
    }
  }
  has(path: string) {
    return this.files.has(path);
  }
}

const member: FamilyMember = {
  id: 'member-1',
  name: 'Lan',
  email: 'lan@example.com',
  driveFolderId: 'folder-1',
  profileFileId: 'profile-1',
};

const profile: HealthProfile = {
  schemaVersion: 2,
  member,
  timeline: [],
  sources: [],
  summary: { latestDiagnoses: [], latestMetrics: {} },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('local sync outbox', () => {
  it('persists and orders pending profile writes per signed-in account', async () => {
    const outbox = createLocalSyncOutbox(new MemoryStore());
    const older = await outbox.enqueueProfileSave('lan@example.com', 'profile-1', profile);
    const newer = await outbox.enqueueProfileSave('lan@example.com', 'profile-1', {
      ...profile,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await outbox.enqueueProfileSave('other@example.com', 'profile-1', profile);

    const pending = await outbox.listProfileSaves('LAN@example.com');
    expect(pending).toEqual(
      [older, newer].sort((left, right) =>
        left.queuedAt - right.queuedAt || left.id.localeCompare(right.id),
      ),
    );
    expect(pending[0].profile.syncPending).toBe(true);
    expect(await outbox.listProfileSaves('other@example.com')).toHaveLength(1);
  });

  it('removes only an acknowledged operation', async () => {
    const outbox = createLocalSyncOutbox(new MemoryStore());
    const first = await outbox.enqueueProfileSave('lan@example.com', 'profile-1', profile);
    const second = await outbox.enqueueProfileSave('lan@example.com', 'profile-1', profile);

    await outbox.complete('lan@example.com', first.id);

    expect((await outbox.listProfileSaves('lan@example.com')).map((item) => item.id))
      .toEqual([second.id]);
  });

  it('discards pending member and profile writes when that member is deleted', async () => {
    const outbox = createLocalSyncOutbox(new MemoryStore());
    await outbox.enqueueMemberSave('lan@example.com', 'workspace-1', member, profile, true);
    await outbox.enqueueProfileSave('lan@example.com', 'profile-1', profile);
    await outbox.enqueueMemberSave('lan@example.com', 'workspace-2', {
      ...member,
      id: 'member-2',
    }, profile, true);

    expect(await outbox.discardMemberOperations('lan@example.com', 'member-1', 'workspace-1'))
      .toBe(2);
    expect(await outbox.listMemberSaves('lan@example.com')).toHaveLength(1);
    expect(await outbox.listProfileSaves('lan@example.com')).toHaveLength(0);
  });

  it('clears queued operations and upload payloads for all accounts', async () => {
    const store = new MemoryStore();
    const outbox = createLocalSyncOutbox(store);
    await outbox.enqueueProfileSave('lan@example.com', 'profile-1', profile);
    const queuedUpload = {
      id: 'upload-1',
      kind: 'raw_upload',
      accountEmail: 'other@example.com',
      workspaceRootId: 'workspace-1',
      member,
      fileName: 'record.pdf',
      mimeType: 'application/pdf',
      fileSize: 10,
      payloadPath: 'health_sync_outbox_v1/other%40example.com/upload-1.bin',
      queuedAt: 1,
    };
    await store.writeBase64(queuedUpload.payloadPath, 'c2Vuc2l0aXZl');
    await store.writeText(
      'health_sync_outbox_v1/other%40example.com/upload-1.json',
      JSON.stringify(queuedUpload),
    );

    await outbox.clearAll();

    expect(await outbox.listProfileSaves('lan@example.com')).toHaveLength(0);
    expect(await outbox.listUploads('other@example.com')).toHaveLength(0);
    expect(store.has(queuedUpload.payloadPath)).toBe(false);
  });

  it('does not silently discard malformed queued data', async () => {
    const store = new MemoryStore();
    const outbox = createLocalSyncOutbox(store);
    await store.writeText('health_sync_outbox_v1/lan%40example.com/broken.json', '{}');

    await expect(outbox.listProfileSaves('lan@example.com'))
      .rejects.toThrow('không hợp lệ; dữ liệu được giữ nguyên');
  });
});
