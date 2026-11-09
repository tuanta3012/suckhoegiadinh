import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { FamilyMember, HealthProfile } from '../types';

interface OutboxFileStore {
  list(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, value: string): Promise<void>;
  writeBase64(path: string, value: string): Promise<void>;
  readBase64(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

export interface PendingProfileSave {
  id: string;
  kind: 'profile_save';
  accountEmail: string;
  profileFileId: string;
  profile: HealthProfile;
  queuedAt: number;
}

export interface PendingUpload {
  id: string;
  kind: 'raw_upload';
  accountEmail: string;
  workspaceRootId: string;
  member: FamilyMember;
  fileName: string;
  mimeType: string;
  fileSize: number;
  payloadPath: string;
  queuedAt: number;
  uploadedFile?: {
    id: string;
    name: string;
    mimeType: string;
    createdTime: string;
    size?: string;
  };
}

export interface PendingMemberSave {
  id: string;
  kind: 'member_save';
  accountEmail: string;
  workspaceRootId: string;
  member: FamilyMember;
  profile?: HealthProfile;
  isNew: boolean;
  queuedAt: number;
}

type PendingOperation = PendingProfileSave | PendingUpload | PendingMemberSave;

const OUTBOX_ROOT = 'health_sync_outbox_v1';

const filesystemStore: OutboxFileStore = {
  async list(path) {
    const result = await Filesystem.readdir({ path, directory: Directory.Data });
    return result.files.map((file) => file.name);
  },
  async readText(path) {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    if (typeof result.data !== 'string') {
      throw new Error('Không thể đọc nội dung hàng đợi đồng bộ.');
    }
    return result.data;
  },
  async writeText(path, value) {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: value,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  },
  async writeBase64(path, value) {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: value,
      recursive: true,
    });
  },
  async readBase64(path) {
    const result = await Filesystem.readFile({ path, directory: Directory.Data });
    if (typeof result.data !== 'string') {
      throw new Error('Không thể đọc tệp đang chờ tải lên.');
    }
    return result.data;
  },
  async remove(path) {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  },
  async removeDirectory(path) {
    await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true });
  },
};

function accountPath(accountEmail: string): string {
  const email = accountEmail.trim().toLowerCase();
  if (!email) throw new Error('Cần có tài khoản đăng nhập để lưu hàng đợi đồng bộ.');
  return `${OUTBOX_ROOT}/${encodeURIComponent(email)}`;
}

function operationPath(accountEmail: string, operationId: string): string {
  return `${accountPath(accountEmail)}/${operationId}.json`;
}

function payloadPath(accountEmail: string, operationId: string): string {
  return `${accountPath(accountEmail)}/${operationId}.bin`;
}

function isPendingOperation(value: unknown): value is PendingOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as Partial<PendingOperation>;
  if (
    typeof operation.id !== 'string' ||
    typeof operation.accountEmail !== 'string' ||
    typeof operation.queuedAt !== 'number'
  ) return false;

  if (operation.kind === 'profile_save') {
    return typeof operation.profileFileId === 'string' &&
      Boolean(operation.profile && typeof operation.profile === 'object');
  }
  if (operation.kind === 'raw_upload') {
    return typeof operation.workspaceRootId === 'string' &&
      typeof operation.fileName === 'string' &&
      typeof operation.mimeType === 'string' &&
      typeof operation.fileSize === 'number' &&
      typeof operation.payloadPath === 'string' &&
      Boolean(operation.member && typeof operation.member === 'object');
  }
  if (operation.kind === 'member_save') {
    return typeof operation.workspaceRootId === 'string' &&
      Boolean(operation.member && typeof operation.member === 'object') &&
      typeof operation.isNew === 'boolean' &&
      (operation.profile === undefined || typeof operation.profile === 'object');
  }
  return false;
}

function readBlobAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Không thể chuẩn bị tệp để lưu ngoại tuyến.'));
        return;
      }
      const separator = reader.result.indexOf(',');
      if (separator < 0) {
        reject(new Error('Định dạng dữ liệu tệp không hợp lệ.'));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Không thể đọc tệp đã chọn.'));
    reader.readAsDataURL(file);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const chunkSize = 32 * 1024;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const chunk = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) {
      bytes[index] = chunk.charCodeAt(index);
    }
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType });
}

export function createLocalSyncOutbox(store: OutboxFileStore = filesystemStore) {
  async function listOperations<T extends PendingOperation['kind']>(
    accountEmail: string,
    kind: T,
  ): Promise<Array<Extract<PendingOperation, { kind: T }>>> {
    const directory = accountPath(accountEmail);
    let names: string[];
    try {
      names = await store.list(directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/does not exist|not found|no such file|ENOENT/i.test(message)) return [];
      throw error;
    }

    const operations: Array<Extract<PendingOperation, { kind: T }>> = [];
    for (const name of names.filter((fileName) => fileName.endsWith('.json')).sort()) {
      const path = `${directory}/${name}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await store.readText(path));
      } catch (error) {
        throw new Error(`Không đọc được yêu cầu đồng bộ cục bộ ${name}.`, { cause: error });
      }
      if (!isPendingOperation(parsed)) {
        throw new Error(`Yêu cầu đồng bộ cục bộ ${name} không hợp lệ; dữ liệu được giữ nguyên.`);
      }
      if (
        parsed.accountEmail.trim().toLowerCase() === accountEmail.trim().toLowerCase() &&
        parsed.kind === kind
      ) {
        operations.push(parsed as Extract<PendingOperation, { kind: T }>);
      }
    }
    return operations.sort((left, right) => left.queuedAt - right.queuedAt || left.id.localeCompare(right.id));
  }

  return {
    async enqueueProfileSave(
      accountEmail: string,
      profileFileId: string,
      profile: HealthProfile,
    ): Promise<PendingProfileSave> {
      const operation: PendingProfileSave = {
        id: crypto.randomUUID(),
        kind: 'profile_save',
        accountEmail: accountEmail.trim().toLowerCase(),
        profileFileId,
        profile: { ...profile, syncPending: true },
        queuedAt: Date.now(),
      };
      await store.writeText(operationPath(accountEmail, operation.id), JSON.stringify(operation));
      return operation;
    },
    listProfileSaves(accountEmail: string) {
      return listOperations(accountEmail, 'profile_save');
    },
    async enqueueMemberSave(
      accountEmail: string,
      workspaceRootId: string,
      member: FamilyMember,
      profile: HealthProfile | undefined,
      isNew: boolean,
    ): Promise<PendingMemberSave> {
      const operation: PendingMemberSave = {
        id: crypto.randomUUID(),
        kind: 'member_save',
        accountEmail: accountEmail.trim().toLowerCase(),
        workspaceRootId,
        member,
        profile,
        isNew,
        queuedAt: Date.now(),
      };
      await store.writeText(operationPath(accountEmail, operation.id), JSON.stringify(operation));
      return operation;
    },
    listMemberSaves(accountEmail: string) {
      return listOperations(accountEmail, 'member_save');
    },
    async discardMemberSaves(
      accountEmail: string,
      memberId: string,
      workspaceRootId?: string,
    ): Promise<number> {
      const operations = await listOperations(accountEmail, 'member_save');
      const matching = operations.filter((operation) =>
        operation.member.id === memberId &&
        (!workspaceRootId || operation.workspaceRootId === workspaceRootId),
      );
      for (const operation of matching) {
        await store.remove(operationPath(accountEmail, operation.id));
      }
      return matching.length;
    },
    async discardProfileSaves(accountEmail: string, profileFileId: string): Promise<number> {
      const operations = await listOperations(accountEmail, 'profile_save');
      const matching = operations.filter((operation) => operation.profileFileId === profileFileId);
      for (const operation of matching) {
        await store.remove(operationPath(accountEmail, operation.id));
      }
      return matching.length;
    },
    async discardMemberOperations(
      accountEmail: string,
      memberId: string,
      workspaceRootId?: string,
      profileFileId?: string,
    ): Promise<number> {
      const operations: PendingOperation[] = [
        ...await listOperations(accountEmail, 'profile_save'),
        ...await listOperations(accountEmail, 'member_save'),
        ...await listOperations(accountEmail, 'raw_upload'),
      ];
      const matching = operations.filter((operation) => {
        const sameWorkspace = !workspaceRootId || !('workspaceRootId' in operation) ||
          operation.workspaceRootId === workspaceRootId;
        const sameMember = operation.kind === 'profile_save'
          ? (profileFileId
              ? operation.profileFileId === profileFileId
              : operation.profile.member.id === memberId)
          : operation.member.id === memberId;
        return sameWorkspace && sameMember;
      });
      for (const operation of matching) {
        await store.remove(operationPath(accountEmail, operation.id));
        if (operation.kind === 'raw_upload') {
          await store.remove(operation.payloadPath);
        }
      }
      return matching.length;
    },
    async enqueueUpload(
      accountEmail: string,
      workspaceRootId: string,
      member: FamilyMember,
      file: File,
    ): Promise<PendingUpload> {
      const id = crypto.randomUUID();
      const path = payloadPath(accountEmail, id);
      await store.writeBase64(path, await readBlobAsBase64(file));
      const operation: PendingUpload = {
        id,
        kind: 'raw_upload',
        accountEmail: accountEmail.trim().toLowerCase(),
        workspaceRootId,
        member,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        payloadPath: path,
        queuedAt: Date.now(),
      };
      try {
        await store.writeText(operationPath(accountEmail, id), JSON.stringify(operation));
      } catch (error) {
        await store.remove(path).catch(() => undefined);
        throw error;
      }
      return operation;
    },
    listUploads(accountEmail: string) {
      return listOperations(accountEmail, 'raw_upload');
    },
    async getUpload(accountEmail: string, operationId: string): Promise<PendingUpload | undefined> {
      try {
        const operation = JSON.parse(await store.readText(operationPath(accountEmail, operationId)));
        if (!isPendingOperation(operation)) {
          throw new Error('Yêu cầu tải tài liệu cục bộ không hợp lệ; dữ liệu được giữ nguyên.');
        }
        return operation.kind === 'raw_upload' ? operation : undefined;
      } catch (error) {
        if (error instanceof Error && error.message.includes('không hợp lệ; dữ liệu được giữ nguyên')) {
          throw error;
        }
        const message = error instanceof Error ? error.message : '';
        if (/does not exist|not found|no such file|ENOENT/i.test(message)) return undefined;
        throw error;
      }
    },
    async readUploadFile(operation: PendingUpload): Promise<File> {
      const payload = await store.readBase64(operation.payloadPath);
      return new File(
        [base64ToBlob(payload, operation.mimeType)],
        operation.fileName,
        { type: operation.mimeType, lastModified: operation.queuedAt },
      );
    },
    async setUploadedFile(
      operation: PendingUpload,
      uploadedFile: PendingUpload['uploadedFile'],
      workspaceRootId = operation.workspaceRootId,
    ): Promise<PendingUpload> {
      const updated = { ...operation, uploadedFile, workspaceRootId };
      await store.writeText(operationPath(operation.accountEmail, operation.id), JSON.stringify(updated));
      return updated;
    },
    async complete(accountEmail: string, operationId: string): Promise<void> {
      const operationPathname = operationPath(accountEmail, operationId);
      let operation: unknown;
      try {
        operation = JSON.parse(await store.readText(operationPathname));
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/does not exist|not found|no such file|ENOENT/i.test(message)) return;
        throw error;
      }
      await store.remove(operationPathname);
      if (isPendingOperation(operation) && operation.kind === 'raw_upload') {
        await store.remove(operation.payloadPath);
      }
    },
    async clearAll(): Promise<void> {
      try {
        await store.list(OUTBOX_ROOT);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/does not exist|not found|no such file|ENOENT/i.test(message)) return;
        throw error;
      }
      await store.removeDirectory(OUTBOX_ROOT);
    },
  };
}

export const localSyncOutbox = createLocalSyncOutbox();

export function supportsDurableOfflineQueue(): boolean {
  return Capacitor.isNativePlatform();
}

export function fileFromPendingUpload(operation: PendingUpload): Promise<File> {
  if (!supportsDurableOfflineQueue()) {
    return Promise.reject(new Error('Hàng đợi tải ngoại tuyến chỉ được bật trong ứng dụng di động.'));
  }
  return localSyncOutbox.readUploadFile(operation);
}

export async function fileFromLocalSource(sourceId: string, ownerKey: string): Promise<File> {
  const match = /^local_file_(.+)$/.exec(sourceId);
  if (!match) throw new Error('Mã tài liệu cục bộ không hợp lệ.');
  const operation = await localSyncOutbox.getUpload(ownerKey, match[1]);
  if (!operation) throw new Error('Không tìm thấy tài liệu gốc trong bộ nhớ của ứng dụng.');
  return localSyncOutbox.readUploadFile(operation);
}
