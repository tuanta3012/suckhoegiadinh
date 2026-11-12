import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  getGoogleAccessToken,
  getSignedInGoogleEmail,
  getValidGoogleAccessToken,
  trySilentRefresh,
} from './googleDriveService';
import type { FamilyMember, HealthFamily, HealthProfile } from '../types';
import {
  canDeleteRawSource,
  excludeDeletedFamilyMembers,
  mergeFamilyMemberTombstones,
  mergeFamilyMembers,
  mergeHealthProfiles,
  parseHealthProfile,
} from './healthProfile';
import {
  findAdminWorkspaceRelay,
  listHealthWorkspaceAssignments,
  publishHealthWorkspaceAssignments,
  readHealthAssignedFolder,
  readHealthWorkspaceAssignment,
  removeHealthWorkspaceAssignment,
  registerHealthWorkspaceRelay,
  unregisterHealthWorkspace,
  type HealthWorkspaceAssignment,
  type WorkspaceAccessRole,
} from './workspaceShareRelay';
import { localSyncOutbox, supportsDurableOfflineQueue } from './localSyncOutbox';
import { getLocalSavedGeminiKeys, saveLocalGeminiKeys } from './geminiSharedResources';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_MIME = 'application/json';
const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,webViewLink,size';
const LOCAL_WORKSPACE_ID = 'local_offline_workspace';
const AI_RESOURCES_FILE_NAME = 'ai-resources.json';
const HEALTH_APP_ID = 'com.suckhoegiadinh.app';
const workspaceAssignmentSyncQueues = new Map<string, Promise<void>>();

export interface SharedAiResources {
  keys: string[];
}

async function deleteDriveFilesBatch(fileIds: string[], concurrency = 5): Promise<void> {
  const ids = [...new Set(fileIds)].filter(Boolean);
  const failures: string[] = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((id) => deleteDriveFile(id)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const fileId = batch[index];
        failures.push(fileId);
        console.warn(`[Drive Deletion] Không thể xóa tệp ${fileId}:`, result.reason);
      }
    });
  }
  if (failures.length > 0) {
    throw new Error(`Không thể xóa ${failures.length}/${ids.length} tệp trên Google Drive.`);
  }
}

class DriveConflictError extends Error {}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export interface HealthDriveWorkspace {
  rootFolderId: string;
  familyFileId: string;
  family: HealthFamily;
  relayRegistrationError?: string;
}

export class WorkspaceSharingSyncError extends Error {
  constructor(message: string, readonly workspace: HealthDriveWorkspace) {
    super(message);
    this.name = 'WorkspaceSharingSyncError';
  }
}

function normalizedEmail(email?: string | null): string {
  return email?.trim().toLowerCase() || '';
}

function assertWorkspaceAdmin(workspace: HealthDriveWorkspace, action: string): void {
  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) return;
  const adminEmail = normalizedEmail(workspace.family.adminEmail);
  if (!adminEmail || normalizedEmail(getSignedInGoogleEmail()) !== adminEmail) {
    throw new Error(`Chỉ Admin của Workspace mới được ${action}.`);
  }
}

export async function syncHealthWorkspaceMemberAssignments(
  workspace: HealthDriveWorkspace,
  removedEmails: string[] = [],
): Promise<void> {
  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) return;
  const previous = workspaceAssignmentSyncQueues.get(workspace.rootFolderId);
  const current = (previous || Promise.resolve())
    .catch(() => {})
    .then(() => syncHealthWorkspaceMemberAssignmentsNow(workspace, removedEmails));
  workspaceAssignmentSyncQueues.set(workspace.rootFolderId, current);
  try {
    await current;
  } finally {
    if (workspaceAssignmentSyncQueues.get(workspace.rootFolderId) === current) {
      workspaceAssignmentSyncQueues.delete(workspace.rootFolderId);
    }
  }
}

async function syncHealthWorkspaceMemberAssignmentsNow(
  workspace: HealthDriveWorkspace,
  removedEmails: string[],
): Promise<void> {
  const adminEmail = normalizedEmail(workspace.family.adminEmail);
  if (!adminEmail) {
    throw new Error('Workspace chưa có email Admin để đồng bộ quyền chia sẻ.');
  }
  if (normalizedEmail(getSignedInGoogleEmail()) !== adminEmail) {
    throw new Error('Chỉ Admin của Workspace mới được đồng bộ quyền Drive và Firestore.');
  }

  const familyEmails = new Set(
    workspace.family.members
      .map((member) => normalizedEmail(member.email))
      .filter((email) => email && email !== adminEmail),
  );
  const explicitlyRemovedEmails = [...new Set(removedEmails.map(normalizedEmail))]
    .filter((email) => email && email !== adminEmail && !familyEmails.has(email));

  try {
    // Luôn đảm bảo thông tin Registry của gia đình (folder gốc) tồn tại trên Firestore
    try {
      await registerHealthWorkspaceRelay(
        workspace.rootFolderId,
        workspace.familyFileId,
        adminEmail,
        {
          profilesFolderId: workspace.family.profilesFolderId,
          rawFilesFolderId: workspace.family.rawFilesFolderId,
        }
      );
    } catch (relayErr) {
      console.error('[Sync] Lỗi đăng ký Registry:', relayErr);
      throw new Error(`Đăng ký Registry thất bại: ${relayErr instanceof Error ? relayErr.message : String(relayErr)}`);
    }

    const existing = await listHealthWorkspaceAssignments(workspace.rootFolderId);
    const staleEmails = [...new Set([
      ...explicitlyRemovedEmails,
      ...existing
        .filter((assignment) =>
          assignment.source === 'family_member' &&
          !familyEmails.has(normalizedEmail(assignment.memberEmail)),
        )
        .map((assignment) => normalizedEmail(assignment.memberEmail)),
    ])];
    const assignments = new Map(
      existing
        .filter((assignment) => !staleEmails.includes(normalizedEmail(assignment.memberEmail)))
        .map((assignment) => [normalizedEmail(assignment.memberEmail), {
          role: assignment.role,
          source: assignment.source,
        }]),
    );
    for (const email of familyEmails) {
      assignments.set(email, { role: 'EDITOR', source: 'family_member' });
    }

    const familyEmailList = [...familyEmails];
    for (let offset = 0; offset < familyEmailList.length; offset += 10) {
      const permissionResults = await Promise.allSettled(
        familyEmailList.slice(offset, offset + 10).map(async (email) => {
          await ensureDriveFolderAccess(workspace.rootFolderId, email, 'EDITOR');
        }),
      );
      const permissionFailures = permissionResults.flatMap((result, index) =>
        result.status === 'rejected'
          ? [`${familyEmailList[offset + index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : [],
      );
      if (permissionFailures.length > 0) {
        console.error('[Sync] Lỗi quyền Drive:', permissionFailures);
        throw new Error(`Chưa thể xác nhận quyền Drive cho: ${permissionFailures.join('; ')}`);
      }
    }

    const cleanupFailures: string[] = [];
    for (const email of staleEmails) {
      try {
        await revokeDriveFolderAccess(workspace.rootFolderId, email);
      } catch (revErr) {
        console.warn(`[Drive Revoke] Không thể thu hồi quyền Drive của ${email}:`, revErr);
        cleanupFailures.push(`${email}: ${revErr instanceof Error ? revErr.message : String(revErr)}`);
      }
      try {
        await removeHealthWorkspaceAssignment(workspace.rootFolderId, email);
      } catch (remErr) {
        console.warn(`[Firestore Remove] Không thể xóa phân quyền của ${email}:`, remErr);
        cleanupFailures.push(`${email}: ${remErr instanceof Error ? remErr.message : String(remErr)}`);
      }
    }

    try {
      await publishHealthWorkspaceAssignments(
        workspace.rootFolderId,
        workspace.familyFileId,
        adminEmail,
        [...assignments].map(([email, assignment]) => {
          const member = workspace.family.members.find(m => normalizedEmail(m.email) === email);
          return {
            email,
            role: assignment.role,
            memberId: member?.id || email,
            profileFileId: member?.profileFileId,
            rawFolderId: member?.driveFolderId,
          };
        }),
      );
    } catch (firestoreErr) {
      console.warn('[Firestore Relay] Không thể đồng bộ lời mời lên Firestore:', firestoreErr);
    }

    if (cleanupFailures.length > 0) {
      throw new Error(`Chưa thu hồi hoàn tất quyền của thành viên đã gỡ: ${cleanupFailures.join('; ')}`);
    }
  } catch (error) {
    if (error instanceof WorkspaceSharingSyncError) throw error;
    const reason = error instanceof Error ? error.message : 'Lỗi chưa xác định.';
    throw new WorkspaceSharingSyncError(
      `family.json đã được cập nhật, nhưng chưa hoàn tất đồng bộ quyền Drive/Firestore: ${reason}`,
      workspace,
    );
  }
}

function accessToken(): string {
  return getGoogleAccessToken() || '';
}

function isLocalProfileFileId(fileId: string): boolean {
  return /^(?:local_profile_|profile_local_)/.test(fileId);
}

function reportDriveHttpError(response: Response, ignoredErrorStatuses: number[] = []): void {
  if (typeof window === 'undefined') return;
  if (response.ok) {
    window.dispatchEvent(new CustomEvent('google-drive-request-succeeded'));
    return;
  }
  if (response.status === 401 || ignoredErrorStatuses.includes(response.status)) return;
  window.dispatchEvent(
    new CustomEvent('google-drive-request-error', {
      detail: { status: response.status },
    }),
  );
}

async function performDriveFetch(
  url: string,
  init: RequestInit,
  headers: Headers,
  nativeJsonResponse: boolean,
  ignoredErrorStatuses: number[] = [],
): Promise<Response> {
  const canUseNativeHttp = Capacitor.isNativePlatform() &&
    (nativeJsonResponse || !url.includes('alt=media')) &&
    (init.body === undefined || typeof init.body === 'string');
  if (!canUseNativeHttp) {
    const response = await fetch(url, { ...init, headers });
    reportDriveHttpError(response, ignoredErrorStatuses);
    return response;
  }

  const nativeResponse = await CapacitorHttp.request({
    url,
    method: init.method || 'GET',
    headers: Object.fromEntries(headers.entries()),
    data: typeof init.body === 'string' ? init.body : undefined,
    responseType: 'text',
    connectTimeout: 20000,
    readTimeout: 30000,
  });
  const body = typeof nativeResponse.data === 'string'
    ? nativeResponse.data
    : JSON.stringify(nativeResponse.data ?? '');
  const responseBody = [204, 205, 304].includes(nativeResponse.status) ? null : body;
  const response = new Response(responseBody, {
    status: nativeResponse.status,
    headers: nativeResponse.headers,
  });
  reportDriveHttpError(response, ignoredErrorStatuses);
  return response;
}

async function authenticatedDriveFetch(
  url: string,
  init: RequestInit = {},
  nativeJsonResponse = false,
  ignoredErrorStatuses: number[] = [],
): Promise<Response> {
  let token: string;
  try {
    token = await getValidGoogleAccessToken();
  } catch (error) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('google-drive-auth-expired'));
    }
    throw error;
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await performDriveFetch(url, init, headers, nativeJsonResponse, ignoredErrorStatuses);
  if (response.status !== 401) return response;

  const refreshedToken = await trySilentRefresh(true);
  if (!refreshedToken) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('google-drive-auth-expired'));
    }
    throw new Error('Google Drive từ chối phiên hiện tại. Hãy đăng nhập lại để cấp quyền Drive.');
  }
  headers.set('Authorization', `Bearer ${refreshedToken}`);
  return performDriveFetch(url, init, headers, nativeJsonResponse, ignoredErrorStatuses);
}

async function driveRequest<T>(
  url: string,
  init: RequestInit = {},
  nativeJsonResponse = false,
): Promise<T> {
  const response = await authenticatedDriveFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      ...init.headers,
    },
  }, nativeJsonResponse);
  if (!response.ok && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('google-drive-request-error', {
        detail: { status: response.status },
      }),
    );
  }
  if (response.status === 412) {
    throw new DriveConflictError('Hồ sơ vừa được thay đổi trên một thiết bị khác.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || `Google Drive trả về lỗi ${response.status}.`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function driveQuery(parentId?: string | null, name?: string | string[], mimeType?: string): string {
  const clauses: string[] = ['trashed = false'];
  if (parentId) {
    clauses.push(`'${parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents`);
  }
  if (name) {
    const names = Array.isArray(name) ? name : [name];
    clauses.push(
      names.length === 1
        ? `name = '${names[0].replace(/'/g, "\\'")}'`
        : `(${names.map((item) => `name = '${item.replace(/'/g, "\\'")}'`).join(' or ')})`,
    );
  }
  if (mimeType) {
    clauses.push(`mimeType = '${mimeType}'`);
  }
  return clauses.join(' and ');
}

async function listFiles(
  parentId?: string | null,
  name?: string | string[],
  mimeType?: string,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: driveQuery(parentId, name, mimeType),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (!name) {
      params.set('orderBy', 'name');
    }
    if (pageToken) params.set('pageToken', pageToken);
    const result = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(
      `${DRIVE_API}/files?${params.toString()}`,
    );
    files.push(...(result.files || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

async function listFolderContentsRecursively(folderId: string): Promise<DriveFile[]> {
  const visited = new Set([folderId]);
  const pendingFolders = [folderId];
  const descendants: DriveFile[] = [];

  while (pendingFolders.length > 0) {
    const batch = pendingFolders.splice(0, 5);
    const childrenByFolder = await Promise.all(batch.map((id) => listFiles(id)));
    for (const children of childrenByFolder) {
      descendants.push(...children);
      for (const child of children) {
        if (child.mimeType === FOLDER_MIME && !visited.has(child.id)) {
          visited.add(child.id);
          pendingFolders.push(child.id);
        }
      }
    }
  }
  return descendants;
}

function cacheWorkspaceForAdmin(workspace: HealthDriveWorkspace): void {
  const userEmail = getSignedInGoogleEmail();
  if (!userEmail || workspace.family.adminEmail?.trim().toLowerCase() !== userEmail) return;
  try {
    const cacheKey = `health_ws_cache_${encodeURIComponent(userEmail)}`;
    localStorage.setItem(cacheKey, JSON.stringify({
      rootFolderId: workspace.rootFolderId,
      familyFileId: workspace.familyFileId,
    }));
  } catch (error) {
    console.warn('[Discovery] Không thể lưu cache Workspace cục bộ.', error);
  }
}

function getCachedWorkspaceFileId(rootFolderId: string): string | undefined {
  const userEmail = getSignedInGoogleEmail();
  if (!userEmail || typeof localStorage === 'undefined') return undefined;
  try {
    const cached = JSON.parse(
      localStorage.getItem(`health_ws_cache_${encodeURIComponent(userEmail)}`) || 'null',
    ) as { rootFolderId?: string; familyFileId?: string } | null;
    return cached?.rootFolderId === rootFolderId ? cached.familyFileId : undefined;
  } catch (error) {
    console.warn('[Discovery] Không thể đọc cache Workspace cục bộ.', error);
    return undefined;
  }
}

async function createFolder(name: string, parentId?: string): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: FOLDER_MIME,
    appProperties: { app: 'com.suckhoegiadinh.app' },
  };
  if (parentId) metadata.parents = [parentId];
  return driveRequest<DriveFile>(`${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
}

async function uploadContent(
  name: string,
  mimeType: string,
  content: Blob,
  parentId: string,
): Promise<DriveFile> {
  const boundary = `family-health-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name,
    mimeType,
    parents: [parentId],
    appProperties: { app: 'com.suckhoegiadinh.app' },
  });
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  return driveRequest<DriveFile>(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
  );
}

async function replaceContent(
  fileId: string,
  name: string,
  mimeType: string,
  content: Blob,
  etag?: string,
): Promise<DriveFile> {
  const boundary = `family-health-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name });
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  return driveRequest<DriveFile>(
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body,
    },
  );
}

export const WORKSPACE_FOLDER_NAME = 'Suc khoe gia dinh';
export const LEGACY_WORKSPACE_FOLDER_NAMES = ['Suc khoe gia dinh', 'Sức khỏe Gia đình'];

export async function renameDriveFolder(folderId: string, newName: string): Promise<DriveFile> {
  return driveRequest<DriveFile>(
    `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    },
  );
}

export async function stampHealthWorkspaceFolder(folderId: string): Promise<void> {
  try {
    const file = await driveRequest<DriveFile>(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed,appProperties&supportsAllDrives=true`,
    );
    if (file.trashed || file.mimeType !== FOLDER_MIME) {
      return;
    }
    if (file.appProperties?.app_id === HEALTH_APP_ID) return;

    const appProperties = {
      ...file.appProperties,
      app_id: HEALTH_APP_ID,
    };
    await driveRequest<DriveFile>(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,appProperties&supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties }),
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const isNotFound = /file not found|404|not found/i.test(message);
    const isForbidden = /forbidden|403|permission/i.test(message);
    
    if (isNotFound) {
      console.warn('[Google Drive] Thư mục gốc không tồn tại hoặc chưa được chia sẻ (404).');
    } else if (isForbidden) {
      console.warn('[Google Drive] Không có quyền dán nhãn appProperties (403) - Bỏ qua bước này.');
    } else {
      console.warn('[Google Drive] Lỗi không xác định khi đóng dấu thư mục:', err);
    }
  }
}

async function openSharedHealthWorkspace(
  rootFolderId: string,
  familyFileId: string | undefined,
  signedInEmail: string,
  expectedAdminEmail?: string,
): Promise<HealthDriveWorkspace> {
  await stampHealthWorkspaceFolder(rootFolderId);
  const workspace = await openHealthWorkspace(rootFolderId, familyFileId);
  const normalizedMemberEmail = normalizedEmail(signedInEmail);
  const normalizedAdminEmail = normalizedEmail(workspace.family.adminEmail);
  if (
    expectedAdminEmail &&
    normalizedEmail(expectedAdminEmail) !== normalizedAdminEmail
  ) {
    throw new Error('Email quản trị trong family.json không khớp với lời mời Firestore.');
  }
  const isAdmin = normalizedMemberEmail && normalizedMemberEmail === normalizedAdminEmail;
  const isFamilyMember = workspace.family.members.some(
    (member) => normalizedEmail(member.email) === normalizedMemberEmail,
  );
  if (!isAdmin && !isFamilyMember) {
    throw new Error('Email đang đăng nhập không có trong danh sách thành viên family.json.');
  }
  return workspace;
}

export async function findExistingHealthWorkspace(): Promise<HealthDriveWorkspace | null> {
  const userEmail = getSignedInGoogleEmail();
  if (!userEmail) return null;

  const normalizedEmail = userEmail.trim().toLowerCase();
  const cacheKey = `health_ws_cache_${encodeURIComponent(normalizedEmail)}`;

  // 1. Siêu tốc: Kiểm tra localStorage trước (Tốc độ Sheets)
  const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
  if (cached) {
    try {
      const { rootFolderId, familyFileId } = JSON.parse(cached);
      if (rootFolderId && familyFileId) {
        return await openSharedHealthWorkspace(rootFolderId, familyFileId, userEmail);
      }
    } catch (e) {
      localStorage.removeItem(cacheKey);
    }
  }

  // 2. Firestore Handshake is preferred before scanning Drive.
  try {
    const assignedFolder = await readHealthAssignedFolder(userEmail);
    if (assignedFolder) {
      const opened = await openSharedHealthWorkspace(
        assignedFolder.folderId,
        assignedFolder.familyFileId,
        userEmail,
        assignedFolder.adminEmail,
      );
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(cacheKey, JSON.stringify({
          rootFolderId: opened.rootFolderId,
          familyFileId: opened.familyFileId,
        }));
      }
      return opened;
    }
  } catch (error) {
    console.warn('[Discovery] Firestore folder handshake chưa hoàn tất; giữ lời mời để thử lại:', error);
  }

  // 2. Kiểm tra Firestore Shadow Index (Nếu Admin đổi thiết bị)
  try {
    const indexed = await findAdminWorkspaceRelay(userEmail);
    if (indexed) {
      try {
        const opened = await openHealthWorkspace(indexed.rootFolderId, indexed.familyFileId);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(cacheKey, JSON.stringify(indexed));
        }
        return opened;
      } catch (e) {
        console.warn('[Discovery] Thư mục trong Firestore Index không còn tồn tại:', indexed.rootFolderId, e);
        // Xóa index đã lỗi khỏi Firestore & LocalStorage để lần sau không quét lại
        void unregisterHealthWorkspace(indexed.rootFolderId).catch(() => {});
        if (typeof localStorage !== 'undefined') localStorage.removeItem(cacheKey);
      }
    }
  } catch (error) {
    console.warn('[Discovery] Không thể tra cứu Firestore Admin Index:', error);
  }

  // 2.5. Kiểm tra Lời mời chia sẻ từ Admin dành cho Thành viên qua Firestore
  try {
    const memberAssignment = await readHealthWorkspaceAssignment(userEmail);
    if (memberAssignment) {
      try {
        const opened = await openAssignedHealthWorkspace(memberAssignment, userEmail);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(
            cacheKey,
            JSON.stringify({
              rootFolderId: memberAssignment.rootFolderId,
              familyFileId: memberAssignment.familyFileId,
            }),
          );
        }
        return opened;
      } catch (e) {
        console.warn(
          '[Discovery] Không thể mở kho dữ liệu từ lời mời chia sẻ Firestore:',
          memberAssignment.rootFolderId,
          e,
        );
      }
    }
  } catch (error) {
    console.warn('[Discovery] Lỗi tra cứu lời mời chia sẻ Firestore cho Thành viên:', error);
  }

  // 3. Auto-discover folders previously stamped by this app.
  try {
    const folders: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `mimeType = '${FOLDER_MIME}' and trashed = false and sharedWithMe = true and appProperties has { key='app_id' and value='${HEALTH_APP_ID}' }`,
        fields: `nextPageToken,files(${FILE_FIELDS},appProperties)`,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(
        `${DRIVE_API}/files?${params.toString()}`,
      );
      folders.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    const matched: HealthDriveWorkspace[] = [];
    for (const folder of folders) {
      try {
        matched.push(await openSharedHealthWorkspace(folder.id, undefined, userEmail));
      } catch (error) {
        console.warn(`[Discovery] Không thể mở thư mục đã đóng dấu ${folder.id}:`, error);
      }
    }
    if (matched.length > 1) {
      throw new Error('Tìm thấy nhiều thư mục Sức khỏe Gia đình đã đóng dấu. Hãy nhờ Admin kiểm tra các kho trùng.');
    }
    const discovered = matched[0];
    if (discovered) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(cacheKey, JSON.stringify({
          rootFolderId: discovered.rootFolderId,
          familyFileId: discovered.familyFileId,
        }));
      }
      return discovered;
    }
  } catch (error) {
    console.warn('[Discovery] Không thể quét thư mục đã đóng dấu:', error);
  }

  // 4. Fallback: Quét Drive (Chậm nhất, chỉ chạy khi Firestore không có thông tin và người dùng có thể là Admin)
  try {
    const foldersToInspect = await listFiles('root', LEGACY_WORKSPACE_FOLDER_NAMES, FOLDER_MIME);
    if (foldersToInspect.length === 0) return null;

    // Fast-path inspection: Look for family.json directly in root candidates & auto-deduplicate
    const inspectionResults = await Promise.all(
      foldersToInspect.map(async (folder) => {
        try {
          const manifest = await resolveSingleFamilyManifestFile(folder.id);
          return manifest ? { folder, manifestId: manifest.id } : null;
        } catch {
          return null;
        }
      })
    );

    const foundWithManifest = inspectionResults.find((r) => r !== null);
    if (foundWithManifest) {
      const { folder, manifestId } = foundWithManifest;
      if (folder.name !== WORKSPACE_FOLDER_NAME) {
        void renameDriveFolder(folder.id, WORKSPACE_FOLDER_NAME).catch((error) => {
          console.warn('[Google Drive] Could not normalize legacy folder name.', error);
        });
      }
      
      const opened = await openSharedHealthWorkspace(folder.id, manifestId, userEmail);
      
      // Đăng ký lại vào Firestore & localStorage nếu là Admin để lần sau tìm nhanh qua Registry
      if (userEmail && opened.family.adminEmail?.trim().toLowerCase() === userEmail.trim().toLowerCase()) {
        const payload = { rootFolderId: opened.rootFolderId, familyFileId: opened.familyFileId };
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(cacheKey, JSON.stringify(payload));
        }
        void registerHealthWorkspaceRelay(opened.rootFolderId, opened.familyFileId, userEmail).catch(() => {});
        return opened;
      }

      // Nếu không phải Admin và không có Registry, chúng ta không tự động mở để tránh nhầm lẫn
      console.warn('[Discovery] Tìm thấy thư mục Drive nhưng không có Registry Firestore và tài khoản không phải Admin.');
      return null;
    }
  } catch (error) {
    console.warn('[Discovery] Lỗi khi quét thư mục Drive:', error);
  }

  return null;
}

export async function clearWorkspaceCache(userEmail: string): Promise<void> {
  const normalizedEmail = userEmail.trim().toLowerCase();
  const cacheKey = `health_ws_cache_${encodeURIComponent(normalizedEmail)}`;
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(cacheKey);
  }
}

/**
 * Tự động tìm kiếm và khử trùng lặp file family.json trong thư mục Workspace.
 * Nếu phát hiện nhiều file family.json (do các luồng tạo song song hoặc Drive phân mảnh),
 * hàm sẽ đọc nội dung tất cả các file để chọn file có dữ liệu hợp lệ, số thành viên nhiều nhất
 * và cập nhật mới nhất, đồng thời tự động xóa bỏ triệt để các file trùng lặp thừa trên Drive.
 */
export async function resolveSingleFamilyManifestFile(rootFolderId: string): Promise<DriveFile | null> {
  // Tìm kiếm không giới hạn MIME type để tránh bỏ sót do Drive gán nhầm MIME hoặc phân mảnh index
  const files = await listFiles(rootFolderId, 'family.json');
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];

  console.warn(
    `[Google Drive Deduplication] Phát hiện ${files.length} file family.json trong thư mục ${rootFolderId}. Đang tự động kiểm tra và dọn dẹp trùng lặp...`,
  );

  interface ScoredFile {
    file: DriveFile;
    memberCount: number;
    isValidSchema: boolean;
    updatedAtMs: number;
  }

  const scoredFiles = await Promise.all(
    files.map(async (file): Promise<ScoredFile> => {
      const fileModifiedMs = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
      try {
        const content = await driveRequest<HealthFamily>(
          `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
          {},
          true,
        );
        if (content && content.schemaVersion === 1 && Array.isArray(content.members)) {
          const updatedAtMs = content.updatedAt
            ? new Date(content.updatedAt).getTime()
            : fileModifiedMs;
          return {
            file,
            memberCount: content.members.length,
            isValidSchema: true,
            updatedAtMs,
          };
        }
      } catch (err) {
        console.warn(`[Google Drive Deduplication] Không thể đọc nội dung file ${file.id}:`, err);
      }
      return {
        file,
        memberCount: -1,
        isValidSchema: false,
        updatedAtMs: fileModifiedMs,
      };
    }),
  );

  // Sắp xếp: ưu tiên schema hợp lệ, nhiều thành viên nhất, rồi đến thời gian cập nhật mới nhất
  scoredFiles.sort((a, b) => {
    if (a.isValidSchema !== b.isValidSchema) return a.isValidSchema ? -1 : 1;
    if (a.memberCount !== b.memberCount) return b.memberCount - a.memberCount;
    return b.updatedAtMs - a.updatedAtMs;
  });

  const canonical = scoredFiles[0].file;
  const duplicateIdsToDelete = scoredFiles.slice(1).map((s) => s.file.id);

  console.info(
    `[Google Drive Deduplication] Chọn file ${canonical.id} (chứa ${scoredFiles[0].memberCount} thành viên). Đang xóa ${duplicateIdsToDelete.length} file trùng lặp...`,
  );

  try {
    await deleteDriveFilesBatch(duplicateIdsToDelete);
    console.info(
      `[Google Drive Deduplication] Đã dọn dẹp thành công ${duplicateIdsToDelete.length} file family.json trùng lặp.`,
    );
  } catch (deleteError) {
    console.warn('[Google Drive Deduplication] Lỗi khi xóa các file trùng lặp thừa:', deleteError);
  }

  return canonical;
}

let createWorkspaceInFlight: Promise<HealthDriveWorkspace> | null = null;

export async function createHealthWorkspace(
  adminEmail: string,
  adminName?: string | null,
): Promise<HealthDriveWorkspace> {
  if (createWorkspaceInFlight) {
    console.info('[Google Drive] Đang có tiến trình tạo Workspace đang chạy, chờ tái sử dụng...');
    return createWorkspaceInFlight;
  }
  createWorkspaceInFlight = (async () => {
    try {
      return await internalCreateHealthWorkspace(adminEmail, adminName);
    } finally {
      createWorkspaceInFlight = null;
    }
  })();
  return createWorkspaceInFlight;
}

async function internalCreateHealthWorkspace(
  adminEmail: string,
  _adminName?: string | null,
): Promise<HealthDriveWorkspace> {
  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  if (!cleanAdminEmail) throw new Error('Cần đăng nhập trước khi tạo Workspace gia đình.');

  // Kiểm tra xem đã có thư mục nào được tạo trước đó chưa (tránh trùng lặp / phục hồi gián đoạn)
  const existingFolders = await listFiles('root', LEGACY_WORKSPACE_FOLDER_NAMES, FOLDER_MIME);

  if (existingFolders.length > 0) {
    const existingRoot = existingFolders[0];
    if (existingRoot.name !== WORKSPACE_FOLDER_NAME) {
      void renameDriveFolder(existingRoot.id, WORKSPACE_FOLDER_NAME).catch((error) => {
        console.warn('[Google Drive] Không thể chuẩn hóa tên Workspace cũ.', error);
      });
    }

    // Tự động kiểm tra và xử lý trùng lặp family.json nếu đã có
    const existingManifest = await resolveSingleFamilyManifestFile(existingRoot.id);
    if (existingManifest) {
      return openHealthWorkspace(existingRoot.id, existingManifest.id);
    }

    const existingChildren = await listFiles(existingRoot.id);
    let raw = existingChildren.find((c) => c.name === 'raw_files' && c.mimeType === FOLDER_MIME);
    let profiles = existingChildren.find((c) => c.name === 'profiles' && c.mimeType === FOLDER_MIME);
    const [createdRaw, createdProfiles] = await Promise.all([
      raw ? Promise.resolve(raw) : createFolder('raw_files', existingRoot.id),
      profiles ? Promise.resolve(profiles) : createFolder('profiles', existingRoot.id),
    ]);
    raw = createdRaw;
    profiles = createdProfiles;

    const now = new Date().toISOString();
    const family: HealthFamily = {
      schemaVersion: 1,
      adminEmail: cleanAdminEmail,
      rawFilesFolderId: raw.id,
      profilesFolderId: profiles.id,
      members: [],
      createdAt: now,
      updatedAt: now,
    };
    const manifest = await uploadContent(
      'family.json',
      JSON_MIME,
      new Blob([JSON.stringify(family, null, 2)]),
      existingRoot.id,
    );
    let relayRegistrationError: string | undefined;
    try {
      await registerHealthWorkspaceRelay(existingRoot.id, manifest.id, cleanAdminEmail);
    } catch (error) {
      relayRegistrationError =
        error instanceof Error ? error.message : 'Không đăng ký được Workspace trên Firestore.';
    }
    const workspace = {
      rootFolderId: existingRoot.id,
      familyFileId: manifest.id,
      family,
      relayRegistrationError,
    };
    cacheWorkspaceForAdmin(workspace);
    return workspace;
  }

  // Khởi tạo thư mục hoàn toàn mới với tên "Suc khoe gia dinh"
  const root = await createFolder(WORKSPACE_FOLDER_NAME);
  const [raw, profiles] = await Promise.all([
    createFolder('raw_files', root.id),
    createFolder('profiles', root.id),
  ]);
  const now = new Date().toISOString();
  const family: HealthFamily = {
    schemaVersion: 1,
    adminEmail: cleanAdminEmail,
    rawFilesFolderId: raw.id,
    profilesFolderId: profiles.id,
    members: [],
    createdAt: now,
    updatedAt: now,
  };
  const manifest = await uploadContent(
    'family.json',
    JSON_MIME,
    new Blob([JSON.stringify(family, null, 2)]),
    root.id,
  );
  let relayRegistrationError: string | undefined;
  try {
    await registerHealthWorkspaceRelay(root.id, manifest.id, cleanAdminEmail);
  } catch (error) {
    relayRegistrationError =
      error instanceof Error ? error.message : 'Không đăng ký được Workspace trên Firestore.';
  }
  const workspace = { rootFolderId: root.id, familyFileId: manifest.id, family, relayRegistrationError };
  cacheWorkspaceForAdmin(workspace);
  return workspace;
}

export async function openHealthWorkspace(
  rootFolderId: string,
  knownManifestFileId?: string,
): Promise<HealthDriveWorkspace> {
  let root: DriveFile;
  try {
    root = await driveRequest<DriveFile>(
      `${DRIVE_API}/files/${encodeURIComponent(rootFolderId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/file not found|404|not found/i.test(message)) {
      throw new Error(`Không tìm thấy kho dữ liệu (ID: ${rootFolderId}). Nếu đây là kho được chia sẻ, hãy nhờ Quản trị viên bấm "Đồng bộ quyền truy cập" trong mục Gia đình.`);
    }
    if (/forbidden|403|permission/i.test(message)) {
      throw new Error(`Bạn không có quyền truy cập kho dữ liệu này. Hãy nhờ Quản trị viên cấp lại quyền cho email của bạn.`);
    }
    throw error;
  }

  if (root.mimeType !== FOLDER_MIME) {
    throw new Error('ID được nhập không phải là thư mục Google Drive.');
  }

  // Tự động tìm và xử lý trùng lặp family.json nếu có
  let manifestFileId: string | undefined = knownManifestFileId;
  if (!manifestFileId) {
    const canonicalManifest = await resolveSingleFamilyManifestFile(rootFolderId);
    manifestFileId = canonicalManifest?.id || getCachedWorkspaceFileId(rootFolderId);
  } else {
    // Nếu knownManifestFileId được truyền vào, vẫn kích hoạt kiểm tra nền để dọn dẹp các bản trùng lặp thừa
    void resolveSingleFamilyManifestFile(rootFolderId).catch((err) => {
      console.warn('[Google Drive] Lỗi nền khi kiểm tra trùng lặp family.json:', err);
    });
  }

  if (!manifestFileId) {
    throw new Error('Không tìm thấy family.json trong thư mục. Hãy kiểm tra thư mục hoặc tạo không gian mới.');
  }

  const manifestMetadata = await driveRequest<DriveFile>(
    `${DRIVE_API}/files/${encodeURIComponent(manifestFileId)}?fields=id,name,mimeType,parents,trashed&supportsAllDrives=true`,
  );
  if (
    manifestMetadata.trashed ||
    manifestMetadata.name !== 'family.json' ||
    manifestMetadata.mimeType !== JSON_MIME ||
    !manifestMetadata.parents?.includes(rootFolderId)
  ) {
    throw new Error('Lời mời không trỏ tới family.json nằm trong đúng thư mục Workspace.');
  }

  const familyResponse = await driveRequest<HealthFamily>(
    `${DRIVE_API}/files/${encodeURIComponent(manifestFileId)}?alt=media&supportsAllDrives=true`,
    {},
    true,
  );
  if (familyResponse.schemaVersion !== 1 || !Array.isArray(familyResponse.members)) {
    throw new Error('Tệp family.json không hợp lệ hoặc không được hỗ trợ.');
  }
  const signedInEmail = normalizedEmail(getSignedInGoogleEmail());
  const adminEmail = normalizedEmail(familyResponse.adminEmail);
  if (
    adminEmail &&
    signedInEmail &&
    signedInEmail !== adminEmail &&
    !familyResponse.members.some((member) => normalizedEmail(member.email) === signedInEmail)
  ) {
    throw new Error('Email đang đăng nhập không còn trong danh sách thành viên Workspace.');
  }
  const deletedMembers = mergeFamilyMemberTombstones(familyResponse.deletedMembers);
  const workspace = {
    rootFolderId,
    familyFileId: manifestFileId,
    family: {
      ...familyResponse,
      deletedMembers,
      members: excludeDeletedFamilyMembers(familyResponse.members, deletedMembers),
    },
  };
  cacheWorkspaceForAdmin(workspace);

  // Chỉ đăng ký Workspace; danh sách bệnh nhân không phải danh sách người được chia sẻ.
  const currentEmail = getSignedInGoogleEmail();
  if (currentEmail && familyResponse.adminEmail && currentEmail.trim().toLowerCase() === familyResponse.adminEmail.trim().toLowerCase()) {
    const adminEmail = familyResponse.adminEmail.trim().toLowerCase();
    void registerHealthWorkspaceRelay(rootFolderId, manifestFileId, adminEmail).catch((err) => {
      console.warn('[Relay Sync] Lỗi tự động đăng ký Firestore khi mở Workspace:', err);
    });
  }

  return workspace;
}

export async function openAssignedHealthWorkspace(
  assignment: HealthWorkspaceAssignment,
  signedInEmail: string,
): Promise<HealthDriveWorkspace> {
  const memberEmail = signedInEmail.trim().toLowerCase();
  if (
    !memberEmail ||
    assignment.memberEmail.trim().toLowerCase() !== memberEmail ||
    !assignment.rootFolderId.trim() ||
    !assignment.adminEmail.trim() ||
    !assignment.familyFileId.trim()
  ) {
    throw new Error('Lời mời Workspace không khớp với tài khoản đang đăng nhập.');
  }
  const workspace = await openSharedHealthWorkspace(
    assignment.rootFolderId,
    assignment.familyFileId,
    memberEmail,
    assignment.adminEmail,
  );
  return workspace;
}

export async function saveHealthFamily(workspace: HealthDriveWorkspace, family: HealthFamily): Promise<HealthDriveWorkspace> {
  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) {
    return {
      ...workspace,
      family: { ...family, updatedAt: new Date().toISOString() },
    };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(workspace.familyFileId)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    if (!response.ok) throw new Error(`Không thể tải family.json mới nhất (HTTP ${response.status}).`);
    const latest = await response.json() as HealthFamily;
    if (latest.schemaVersion !== 1 || !Array.isArray(latest.members)) {
      throw new Error('family.json không hợp lệ; không thể cập nhật danh sách thành viên.');
    }

    const deletedMembers = mergeFamilyMemberTombstones(
      latest.deletedMembers,
      family.deletedMembers,
      workspace.family.deletedMembers,
    );
    const next: HealthFamily = {
      ...latest,
      ...family,
      deletedMembers,
      members: excludeDeletedFamilyMembers(
        mergeFamilyMembers(latest.members, family.members, workspace.family.members),
        deletedMembers,
      ),
      createdAt: latest.createdAt || family.createdAt,
      updatedAt: new Date().toISOString(),
    };
    try {
      const file = await replaceContent(
        workspace.familyFileId,
        'family.json',
        JSON_MIME,
        new Blob([JSON.stringify(next, null, 2)]),
        response.headers.get('etag') || undefined,
      );

      return { ...workspace, familyFileId: file.id, family: next };
    } catch (error) {
      if (!(error instanceof DriveConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error('Danh sách gia đình đang được sửa trên thiết bị khác. Hãy đồng bộ rồi thử lại.');
}

export async function addDriveFamilyMember(
  workspace: HealthDriveWorkspace,
  input: Omit<FamilyMember, 'driveFolderId' | 'profileFileId'>,
): Promise<HealthDriveWorkspace> {
  const normalizedName = input.name.trim();
  if (!normalizedName) throw new Error('Nhập tên thành viên trước khi lưu.');
  const duplicate = workspace.family.members.some(
    (member) => member.name.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
  );
  if (duplicate) throw new Error('Tên thành viên này đã có trong gia đình.');

  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) {
    const member: FamilyMember = {
      ...input,
      name: normalizedName,
      driveFolderId: `local_folder_${input.id}`,
      profileFileId: `local_profile_${input.id}`,
    };
    return saveHealthFamily(workspace, {
      ...workspace.family,
      members: [...workspace.family.members, member],
    });
  }

  const cleanAdminEmail = normalizedEmail(workspace.family.adminEmail);
  const currentEmail = normalizedEmail(getSignedInGoogleEmail());
  const memberEmail = normalizedEmail(input.email);
  const isWorkspaceAdmin = Boolean(cleanAdminEmail && currentEmail === cleanAdminEmail);
  if (memberEmail && isWorkspaceAdmin && memberEmail !== cleanAdminEmail) {
    await ensureDriveFolderAccess(workspace.rootFolderId, memberEmail, 'EDITOR');
  }

  const rawFolder = await createFolder(input.id, workspace.family.rawFilesFolderId);
  const profile = {
    schemaVersion: 1,
    member: { ...input, name: normalizedName, driveFolderId: rawFolder.id, profileFileId: '' },
    timeline: [],
    sources: [],
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies HealthProfile;
  if (!workspace.family.profilesFolderId) {
    throw new Error('Chưa khởi tạo thư mục hồ sơ trên Drive.');
  }
  const profileFile = await uploadContent(
    `${input.id}.json`,
    JSON_MIME,
    new Blob([JSON.stringify(profile, null, 2)]),
    workspace.family.profilesFolderId,
  );
  const member = { ...profile.member, profileFileId: profileFile.id };
  await replaceContent(
    profileFile.id,
    `${input.id}.json`,
    JSON_MIME,
    new Blob([JSON.stringify({ ...profile, member }, null, 2)]),
  );
  const family = { ...workspace.family, members: [...workspace.family.members, member] };
  const updatedWorkspace = await saveHealthFamily(workspace, family);
  if (isWorkspaceAdmin) {
    await syncHealthWorkspaceMemberAssignments(updatedWorkspace);
  }
  return updatedWorkspace;
}

export async function updateDriveFamilyMember(
  workspace: HealthDriveWorkspace,
  memberId: string,
  updates: Partial<FamilyMember>,
): Promise<HealthDriveWorkspace> {
  assertWorkspaceAdmin(workspace, 'chỉnh sửa thông tin thành viên');
  const existingMember = workspace.family.members.find((member) => member.id === memberId);
  if (!existingMember) throw new Error('Không tìm thấy thành viên cần cập nhật.');
  const members = workspace.family.members.map((m) =>
    m.id === memberId ? { ...m, ...updates, name: updates.name?.trim() || m.name } : m
  );
  const updatedMember = members.find((member) => member.id === memberId);
  if (!updatedMember) throw new Error('Không tìm thấy thành viên cần cập nhật.');
  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) {
    return saveHealthFamily(workspace, { ...workspace.family, members });
  }
  const cleanAdminEmail = normalizedEmail(workspace.family.adminEmail);
  const currentEmail = normalizedEmail(getSignedInGoogleEmail());
  const previousEmail = normalizedEmail(existingMember.email);
  const updatedEmail = normalizedEmail(updatedMember.email);
  if (
    updatedEmail &&
    updatedEmail !== cleanAdminEmail &&
    updatedEmail !== previousEmail &&
    currentEmail === cleanAdminEmail
  ) {
    await ensureDriveFolderAccess(workspace.rootFolderId, updatedEmail, 'EDITOR');
  }

  const profileData = await loadHealthProfile(updatedMember.profileFileId);
  const profile = parseHealthProfile(profileData, existingMember);
  const updatedProfile = { ...profile, member: updatedMember };
  await saveHealthProfile(updatedMember.profileFileId, updatedProfile);
  let updatedWorkspace: HealthDriveWorkspace;
  try {
    updatedWorkspace = await saveHealthFamily(workspace, { ...workspace.family, members });
  } catch (manifestError) {
    try {
      await saveHealthProfile(updatedMember.profileFileId, profile);
    } catch (rollbackError) {
      const manifestMessage = manifestError instanceof Error ? manifestError.message : 'Lỗi chưa xác định.';
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : 'Lỗi chưa xác định.';
      throw new Error(
        `Không thể đồng bộ cập nhật thành viên giữa family.json và hồ sơ Drive (${manifestMessage}). Cũng không thể khôi phục hồ sơ cũ (${rollbackMessage}). Hãy kiểm tra dữ liệu trên Drive trước khi tiếp tục.`,
      );
    }
    throw manifestError;
  }
  await syncHealthWorkspaceMemberAssignments(
    updatedWorkspace,
    previousEmail && previousEmail !== updatedEmail ? [previousEmail] : [],
  );
  return updatedWorkspace;
}

export async function recreateDriveMemberProfile(
  workspace: HealthDriveWorkspace,
  memberId: string,
): Promise<HealthDriveWorkspace> {
  const member = workspace.family.members.find((item) => item.id === memberId);
  if (!member) throw new Error('Không tìm thấy thành viên trong danh sách gia đình.');
  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) {
    return workspace;
  }

  // 1. Đảm bảo thư mục profiles tồn tại
  let profilesFolderId = workspace.family.profilesFolderId;
  if (!profilesFolderId) {
    const profiles = await createFolder('profiles', workspace.rootFolderId);
    profilesFolderId = profiles.id;
  }

  // 2. Đảm bảo thư mục lưu file gốc của thành viên tồn tại
  let rawFolderId = member.driveFolderId;
  if (!rawFolderId || isLocalProfileFileId(rawFolderId)) {
    let rawParentId = workspace.family.rawFilesFolderId;
    if (!rawParentId) {
      const raw = await createFolder('raw_files', workspace.rootFolderId);
      rawParentId = raw.id;
    }
    const createdFolder = await createFolder(member.id, rawParentId);
    rawFolderId = createdFolder.id;
  }

  // 3. Khởi tạo hồ sơ rỗng mới
  const now = new Date().toISOString();
  const profile: HealthProfile = {
    schemaVersion: 1,
    member: {
      ...member,
      driveFolderId: rawFolderId,
      profileFileId: '',
    },
    timeline: [],
    sources: [],
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: now,
    updatedAt: now,
  };

  const profileFile = await uploadContent(
    `${member.id}.json`,
    JSON_MIME,
    new Blob([JSON.stringify(profile, null, 2)]),
    profilesFolderId,
  );

  const updatedMember: FamilyMember = {
    ...member,
    driveFolderId: rawFolderId,
    profileFileId: profileFile.id,
  };

  await replaceContent(
    profileFile.id,
    `${member.id}.json`,
    JSON_MIME,
    new Blob([JSON.stringify({ ...profile, member: updatedMember }, null, 2)]),
  );

  const updatedFamily: HealthFamily = {
    ...workspace.family,
    profilesFolderId,
    members: workspace.family.members.map((m) => (m.id === memberId ? updatedMember : m)),
    updatedAt: now,
  };

  return await saveHealthFamily(workspace, updatedFamily);
}

export async function deleteDriveFamilyMember(
  workspace: HealthDriveWorkspace,
  memberId: string,
): Promise<{ workspace: HealthDriveWorkspace }> {
  assertWorkspaceAdmin(workspace, 'xóa thành viên');
  const member = workspace.family.members.find((item) => item.id === memberId);
  if (!member) throw new Error('Không tìm thấy thành viên cần xóa trong Workspace hiện tại.');
  const adminEmail = normalizedEmail(workspace.family.adminEmail);
  if (adminEmail && normalizedEmail(member.email) === adminEmail) {
    throw new Error('Không thể xóa hồ sơ của Admin Workspace.');
  }
  if (workspace.rootFolderId === LOCAL_WORKSPACE_ID) {
    return {
      workspace: {
        ...workspace,
        family: {
          ...workspace.family,
          members: workspace.family.members.filter((item) => item.id !== memberId),
          updatedAt: new Date().toISOString(),
        },
      },
    };
  }

  const familyWithoutMember: HealthFamily = {
    ...workspace.family,
    members: workspace.family.members.filter((item) => item.id !== memberId),
    deletedMembers: mergeFamilyMemberTombstones(
      workspace.family.deletedMembers,
      [{
        memberId,
        deletedAt: new Date().toISOString(),
        deletedBy: getSignedInGoogleEmail() || undefined,
      }],
    ),
  };
  const updatedWorkspace = await removeFamilyMemberFromManifest(workspace, familyWithoutMember, memberId);
  const memberEmail = normalizedEmail(member.email);
  let sharingError: unknown;
  try {
    await syncHealthWorkspaceMemberAssignments(
      updatedWorkspace,
      memberEmail ? [memberEmail] : [],
    );
  } catch (error) {
    sharingError = error;
  }
  const filesToDelete = [member.profileFileId, member.driveFolderId].filter(
    (id): id is string => Boolean(id) && !id.startsWith('local_'),
  );
  if (filesToDelete.length > 0) {
    try {
      await deleteDriveFilesBatch(filesToDelete);
    } catch (error) {
      const cleanupReason = error instanceof Error ? error.message : 'Lỗi chưa xác định.';
      const sharingReason = sharingError instanceof Error ? ` Đồng thời: ${sharingError.message}` : '';
      throw new WorkspaceSharingSyncError(
        `Thành viên đã bị gỡ khỏi family.json nhưng chưa xóa hết dữ liệu Drive: ${cleanupReason}.${sharingReason}`,
        updatedWorkspace,
      );
    }
  }
  if (sharingError) throw sharingError;

  return { workspace: updatedWorkspace };
}

export async function deleteHealthWorkspaceFolder(rootFolderId: string): Promise<void> {
  if (!rootFolderId.trim()) throw new Error('Thiếu mã thư mục Workspace cần xóa.');
  
  // 1. Xóa cache cục bộ ngay lập tức
  const userEmail = getSignedInGoogleEmail();
  if (userEmail) {
    void clearWorkspaceCache(userEmail);
  }
  
  // 2. Xóa đăng ký Firestore Registry
  const unregisterPromise = unregisterHealthWorkspace(rootFolderId).catch((error) => {
    console.warn('[Discovery] Không thể xóa Index Firestore cho Workspace đã xóa:', error);
  });

  // 3. Xóa dữ liệu con và thư mục gốc
  // Chúng ta thực hiện xóa thư mục gốc trực tiếp. Drive API v3 delete trên một thư mục
  // sẽ xóa toàn bộ nội dung bên trong nó một cách đệ quy.
  try {
    await deleteDriveFile(rootFolderId);
  } catch (error) {
    console.warn('[Drive Deletion] Không thể xóa thư mục gốc, thử xóa đệ quy thủ công...', error);
    // Fallback: Nếu xóa thư mục gốc lỗi, thử xóa từng phần
    try {
      const descendants = await listFolderContentsRecursively(rootFolderId);
      await deleteDriveFilesBatch(descendants.map((file) => file.id));
      await deleteDriveFile(rootFolderId);
    } catch (innerError) {
      console.warn('[Drive Deletion] Thất bại hoàn toàn khi xóa Workspace trên Drive.', innerError);
    }
  }

  await unregisterPromise;
}

export async function factoryResetWorkspaceFolder(
  workspace: HealthDriveWorkspace,
  adminEmail: string
): Promise<HealthDriveWorkspace> {
  // We'll keep this but the UI will now primarily use deleteHealthWorkspaceFolder
  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  const allRootChildren = await listFolderContentsRecursively(workspace.rootFolderId);
  await deleteDriveFilesBatch(allRootChildren.map((file) => file.id));

  const [raw, profiles] = await Promise.all([
    createFolder('raw_files', workspace.rootFolderId),
    createFolder('profiles', workspace.rootFolderId),
  ]);
  const now = new Date().toISOString();
  const resetFamily: HealthFamily = {
    schemaVersion: 1,
    adminEmail: cleanAdminEmail,
    rawFilesFolderId: raw.id,
    profilesFolderId: profiles.id,
    members: [],
    createdAt: workspace.family.createdAt || now,
    updatedAt: now,
  };

  const file = await uploadContent(
    'family.json',
    JSON_MIME,
    new Blob([JSON.stringify(resetFamily, null, 2)]),
    workspace.rootFolderId,
  );

  return {
    rootFolderId: workspace.rootFolderId,
    familyFileId: file.id,
    family: resetFamily,
  };
}


async function removeFamilyMemberFromManifest(
  workspace: HealthDriveWorkspace,
  family: HealthFamily,
  memberId: string,
): Promise<HealthDriveWorkspace> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authenticatedDriveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(workspace.familyFileId)}?alt=media&supportsAllDrives=true`
    );
    if (!response.ok) {
      throw new Error(`Không thể tải family.json trước khi gỡ thành viên (HTTP ${response.status}).`);
    }
    const latest = await response.json() as HealthFamily;
    if (latest.schemaVersion !== 1 || !Array.isArray(latest.members)) {
      throw new Error('family.json không hợp lệ; không thể gỡ thành viên.');
    }
    if (!latest.members.some((item) => item.id === memberId)) {
      return { ...workspace, family: latest };
    }

    const next: HealthFamily = {
      ...latest,
      ...family,
      members: latest.members.filter((item) => item.id !== memberId),
      createdAt: latest.createdAt || family.createdAt,
      updatedAt: new Date().toISOString(),
    };
    try {
      const file = await replaceContent(
        workspace.familyFileId,
        'family.json',
        JSON_MIME,
        new Blob([JSON.stringify(next, null, 2)]),
        response.headers.get('etag') || undefined,
      );
      return { ...workspace, familyFileId: file.id, family: next };
    } catch (error) {
      if (!(error instanceof DriveConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error('Danh sách gia đình đang được sửa trên thiết bị khác. Hãy đồng bộ rồi thử xóa lại.');
}

export async function loadHealthProfile(fileId: string): Promise<HealthProfile> {
  return driveRequest<HealthProfile>(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    {},
    true,
  );
}

async function saveHealthProfileRemote(fileId: string, profile: HealthProfile): Promise<HealthProfile> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    if (!response.ok) throw new Error(`Không thể tải hồ sơ mới nhất trước khi lưu (HTTP ${response.status}).`);
    const latest = parseHealthProfile(await response.json(), profile.member);
    const merged = mergeHealthProfiles(latest, profile);
    try {
      await replaceContent(
        fileId,
        `${profile.member.id}.json`,
        JSON_MIME,
        new Blob([JSON.stringify(merged, null, 2)]),
        response.headers.get('etag') || undefined,
      );
      return merged;
    } catch (error) {
      if (!(error instanceof DriveConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error('Hồ sơ đang được cập nhật trên thiết bị khác. Đồng bộ lại rồi thử lưu lần nữa.');
}

function shouldQueueProfileSave(error: unknown): boolean {
  return error instanceof DriveConflictError ||
    error instanceof TypeError ||
    (error instanceof Error &&
      /failed to fetch|networkerror|load failed|network request failed|phiên google drive đã hết hạn|đăng nhập lại để cấp quyền drive|xung đột đồng bộ/i.test(error.message));
}

export async function saveHealthProfile(fileId: string, profile: HealthProfile): Promise<HealthProfile> {
  if (isLocalProfileFileId(fileId)) {
    return { ...profile, member: { ...profile.member, profileFileId: fileId } };
  }
  const accountEmail = getSignedInGoogleEmail();
  let localProfile = profile;
  const queuedSaves = supportsDurableOfflineQueue() && accountEmail
    ? await localSyncOutbox.listProfileSaves(accountEmail)
    : [];
  try {
    for (const queued of queuedSaves) {
      if (queued.profileFileId === fileId) {
        localProfile = mergeHealthProfiles(queued.profile, localProfile);
      }
    }

    const saved = await saveHealthProfileRemote(fileId, localProfile);
    if (accountEmail) {
      for (const queued of queuedSaves) {
        if (queued.profileFileId === fileId) {
          await localSyncOutbox.complete(accountEmail, queued.id);
        }
      }
    }
    return { ...saved, syncPending: false };
  } catch (error) {
    if (
      !supportsDurableOfflineQueue() ||
      !accountEmail ||
      !shouldQueueProfileSave(error)
    ) {
      throw error;
    }
    await localSyncOutbox.enqueueProfileSave(accountEmail, fileId, localProfile);
    return { ...localProfile, syncPending: true };
  }
}

export async function flushPendingHealthProfileSaves(
  members: FamilyMember[],
  accountEmail: string,
): Promise<number> {
  if (!supportsDurableOfflineQueue() || !accountEmail.trim()) return 0;
  const memberByProfileId = new Map(members.map((member) => [member.profileFileId, member]));
  const pending = await localSyncOutbox.listProfileSaves(accountEmail);
  let flushed = 0;
  for (const operation of pending) {
    const savedMemberId = operation.profile.member.id;
    const savedMemberEmail = operation.profile.member.email?.trim().toLowerCase();
    const member = memberByProfileId.get(operation.profileFileId) ||
      (isLocalProfileFileId(operation.profileFileId)
        ? members.find((candidate) => candidate.id === savedMemberId)
        : undefined) ||
      (isLocalProfileFileId(operation.profileFileId) && savedMemberEmail
        ? members.find((candidate) => candidate.email?.trim().toLowerCase() === savedMemberEmail)
        : undefined);
    if (!member) {
      throw new Error(
        `Không tìm thấy thành viên đích cho thay đổi hồ sơ đang chờ (${operation.profile.member.name}); dữ liệu cục bộ được giữ nguyên.`,
      );
    }
    await saveHealthProfile(member.profileFileId, {
      ...operation.profile,
      member,
    });
    if (member.profileFileId !== operation.profileFileId) {
      await localSyncOutbox.complete(accountEmail, operation.id);
    }
    flushed += 1;
  }
  return flushed;
}

export async function uploadRawHealthFile(
  member: FamilyMember,
  file: File,
): Promise<DriveFile> {
  return uploadContent(file.name, file.type || 'application/octet-stream', file, member.driveFolderId);
}

export async function moveDriveFileToMember(
  fileId: string,
  destinationMember: FamilyMember,
): Promise<void> {
  if (fileId.startsWith('local_file_')) return;
  const metadata = await driveRequest<{ parents?: string[] }>(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=parents&supportsAllDrives=true`,
  );
  const currentParents = metadata.parents || [];
  if (currentParents.includes(destinationMember.driveFolderId)) return;
  if (currentParents.length === 0) {
    throw new Error('Không xác định được thư mục hiện tại của tài liệu trên Drive.');
  }

  const params = new URLSearchParams({
    addParents: destinationMember.driveFolderId,
    removeParents: currentParents.join(','),
    fields: FILE_FIELDS,
  });
  await driveRequest<DriveFile>(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}&supportsAllDrives=true`,
    { method: 'PATCH' },
  );
}

export async function downloadDriveFile(fileId: string): Promise<Blob> {
  const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  if (!response.ok) throw new Error(`Không thể tải tài liệu gốc (HTTP ${response.status}).`);
  return response.blob();
}

export async function loadSharedAiResources(folderId?: string | null): Promise<SharedAiResources> {
  if (!folderId || folderId === 'local_offline_workspace') {
    return { keys: getLocalSavedGeminiKeys() };
  }
  try {
    const files = await listFiles(folderId, AI_RESOURCES_FILE_NAME, JSON_MIME);
    if (files.length === 0) {
      // Nếu chưa có file trên Drive nhưng local đã có key lưu tạm, tự động tải lên Drive
      const localKeys = getLocalSavedGeminiKeys();
      if (localKeys.length > 0) {
        try {
          await saveSharedAiResources(folderId, localKeys);
        } catch (syncErr) {
          console.warn('[AI Resources] Không thể tự động đồng bộ key tạm lên Drive:', syncErr);
        }
        return { keys: localKeys };
      }
      return { keys: [] };
    }
    if (files.length > 1) {
      throw new Error('Có nhiều file ai-resources.json trong folder. Hãy nhờ quản trị viên giữ lại một file.');
    }
    const blob = await downloadDriveFile(files[0].id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await blob.text());
    } catch (error) {
      throw new Error('File Tài nguyên AI trên Drive bị lỗi định dạng JSON.', { cause: error });
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('keys' in parsed) ||
      !Array.isArray(parsed.keys) ||
      parsed.keys.some((key) => typeof key !== 'string')
    ) {
      throw new Error('File Tài nguyên AI trên Drive không có danh sách key hợp lệ.');
    }
    const driveKeys = Array.from(new Set(parsed.keys.map((key) => key.trim()).filter(Boolean)));
    // Lưu vào local cache để dùng khi offline
    saveLocalGeminiKeys(driveKeys);
    return { keys: driveKeys };
  } catch (error) {
    // Nếu có lỗi mạng hoặc chưa truy cập được Drive, fallback sang key lưu tạm ở local
    const localKeys = getLocalSavedGeminiKeys();
    if (localKeys.length > 0) {
      return { keys: localKeys };
    }
    throw error;
  }
}

export async function saveSharedAiResources(folderId: string | null | undefined, keys: string[]): Promise<void> {
  const cleanKeys = Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)));
  // Luôn luôn lưu vào local cache trước
  saveLocalGeminiKeys(cleanKeys);

  if (!folderId || folderId === 'local_offline_workspace') {
    return;
  }

  const files = await listFiles(folderId, AI_RESOURCES_FILE_NAME);
  const content = new Blob(
    [JSON.stringify({ schemaVersion: 1, keys: cleanKeys, updatedAt: new Date().toISOString() }, null, 2)],
    { type: JSON_MIME },
  );
  if (files.length > 0) {
    await replaceContent(files[0].id, AI_RESOURCES_FILE_NAME, JSON_MIME, content);
    if (files.length > 1) {
      void deleteDriveFilesBatch(files.slice(1).map((f) => f.id)).catch((err) => {
        console.warn('[Google Drive] Lỗi khi dọn dẹp các file ai-resources.json thừa:', err);
      });
    }
    return;
  }
  await uploadContent(AI_RESOURCES_FILE_NAME, JSON_MIME, content, folderId);
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const response = await authenticatedDriveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    { method: 'DELETE' },
    false,
    [404],
  );
  if (response.ok || response.status === 404) return;
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  throw new Error(body?.error?.message || `Google Drive trả về lỗi ${response.status} khi xóa tệp.`);
}

interface DriveFolderPermission {
  id?: string;
  emailAddress?: string;
  type?: string;
  role?: string;
  deleted?: boolean;
  permissionDetails?: Array<{ inherited?: boolean }>;
}

async function listFolderPermissions(folderId: string): Promise<DriveFolderPermission[]> {
  const permissions: DriveFolderPermission[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      fields: 'nextPageToken,permissions(id,emailAddress,type,role,deleted,permissionDetails(inherited))',
      pageSize: '100',
      supportsAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await driveRequest<{
      permissions?: DriveFolderPermission[];
      nextPageToken?: string;
    }>(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions?${params.toString()}`,
    );
    permissions.push(...(result.permissions || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return permissions;
}

function driveRoleRank(role: string | undefined): number {
  switch (role) {
    case 'reader':
    case 'commenter':
      return 1;
    case 'writer':
      return 2;
    case 'fileOrganizer':
    case 'organizer':
      return 3;
    case 'owner':
      return 4;
    default:
      return 0;
  }
}

export async function ensureDriveFolderAccess(
  folderId: string,
  memberEmail: string,
  role: WorkspaceAccessRole,
): Promise<void> {
  const normalizedEmail = memberEmail.trim().toLowerCase();
  if (!folderId.trim() || !normalizedEmail || (role !== 'EDITOR' && role !== 'VIEWER')) {
    throw new Error('Thiếu mã thư mục, email hoặc vai trò hợp lệ để cấp quyền Google Drive.');
  }
  const desiredRole = role === 'EDITOR' ? 'writer' : 'reader';
  const desiredRank = driveRoleRank(desiredRole);
  const permissions = await listFolderPermissions(folderId);
  const matching = permissions.filter((permission) =>
    permission.type === 'user' &&
    !permission.deleted &&
    permission.emailAddress?.trim().toLowerCase() === normalizedEmail,
  );
  const inherited = matching.filter((permission) =>
    permission.permissionDetails?.some((detail) => detail.inherited),
  );
  if (inherited.some((permission) => driveRoleRank(permission.role) > desiredRank)) {
    throw new Error(`Không thể đặt ${normalizedEmail} thành ${role}: quyền cao hơn đang được kế thừa từ folder cha.`);
  }

  const direct = matching.find((permission) =>
    !permission.permissionDetails?.some((detail) => detail.inherited),
  );
  let response: Response | undefined;
  if (direct?.role === 'owner') {
    throw new Error(`Không thể thay đổi quyền của ${normalizedEmail} vì tài khoản này là chủ sở hữu folder.`);
  }
  if (direct?.id) {
    if (direct.role !== desiredRole) {
      response = await authenticatedDriveFetch(
        `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions/${encodeURIComponent(direct.id)}?supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: desiredRole }),
        },
      );
    }
  } else if (inherited.length === 0 || !inherited.some((permission) => permission.role === desiredRole)) {
    response = await authenticatedDriveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: desiredRole, emailAddress: normalizedEmail }),
      },
    );
  }
  if (response && !response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(
      body?.error?.message ||
      `Không thể cấp quyền ${role} cho ${normalizedEmail} trên Google Drive (HTTP ${response.status}).`,
    );
  }

  const verified = (await listFolderPermissions(folderId)).filter((permission) =>
    permission.type === 'user' &&
    !permission.deleted &&
    permission.emailAddress?.trim().toLowerCase() === normalizedEmail,
  );
  const effectiveRank = verified.reduce((rank, permission) => Math.max(rank, driveRoleRank(permission.role)), 0);
  if (effectiveRank !== desiredRank) {
    throw new Error(`Google Drive chưa xác nhận chính xác quyền ${role} cho ${normalizedEmail}.`);
  }
}

export async function revokeDriveFolderAccess(folderId: string, memberEmail: string): Promise<void> {
  const normalizedEmail = memberEmail.trim().toLowerCase();
  if (!folderId.trim() || !normalizedEmail) {
    throw new Error('Thiếu mã thư mục hoặc email để thu hồi quyền Google Drive.');
  }

  const permissions = await listFolderPermissions(folderId);

  const matchingPermissions = permissions.filter((permission) =>
    permission.id &&
    permission.type === 'user' &&
    permission.role !== 'owner' &&
    !permission.deleted &&
    permission.emailAddress?.trim().toLowerCase() === normalizedEmail,
  );
  if (matchingPermissions.some((permission) => permission.permissionDetails?.some((detail) => detail.inherited))) {
    throw new Error(`Quyền của ${normalizedEmail} được kế thừa từ folder cha; hãy thu hồi quyền ở folder cha trước.`);
  }
  for (const permission of matchingPermissions) {
    const response = await authenticatedDriveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions/${encodeURIComponent(permission.id!)}?supportsAllDrives=true`,
      { method: 'DELETE' },
    );
    if (response.ok || response.status === 404) continue;
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(
      body?.error?.message ||
      `Không thể thu hồi quyền Drive của ${normalizedEmail} (HTTP ${response.status}).`,
    );
  }
}

export async function listRawFiles(member: FamilyMember): Promise<DriveFile[]> {
  return listFiles(member.driveFolderId);
}

export async function cleanupExpiredRawFiles(
  workspace: HealthDriveWorkspace,
  now = new Date(),
): Promise<{ deleted: number; retained: number }> {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 3);
  let deleted = 0;
  let retained = 0;

  for (const member of workspace.family.members) {
    const profileData = await loadHealthProfile(member.profileFileId);
    const profile = parseHealthProfile(profileData, member);
    const rawFiles = await listRawFiles(member);
    for (const file of rawFiles) {
      const createdTime = new Date(file.createdTime || '');
      if (!Number.isFinite(createdTime.getTime()) || createdTime >= cutoff) continue;
      if (!canDeleteRawSource(profile, file.id)) {
        retained++;
        continue;
      }

      await deleteDriveFile(file.id);
      profile.sources = profile.sources.map((source) =>
        source.driveFileId === file.id ? { ...source, rawDeletedAt: now.toISOString() } : source,
      );
      profile.updatedAt = now.toISOString();
      const saved = await saveHealthProfile(member.profileFileId, profile);
      Object.assign(profile, saved);
    }
  }
  return { deleted, retained };
}

export interface DriveDuplicateCleanupResult {
  deletedFilesCount: number;
  freedSpaceBytes: number;
  cleanedFilesDetails: Array<{ fileName: string; memberName: string; deletedId: string }>;
}

/**
 * Tự động quét và xóa sạch các tệp trùng lặp (duplicate files) trong thư mục raw_files của từng thành viên trên Google Drive
 */
export async function cleanupDuplicateRawFilesOnDrive(
  workspace: HealthDriveWorkspace,
): Promise<DriveDuplicateCleanupResult> {
  let deletedFilesCount = 0;
  let freedSpaceBytes = 0;
  const cleanedFilesDetails: Array<{ fileName: string; memberName: string; deletedId: string }> = [];

  for (const member of workspace.family.members) {
    try {
      const rawFiles = await listRawFiles(member);
      if (!rawFiles || rawFiles.length <= 1) continue;

      // Gom nhóm theo tên tệp đã chuẩn hóa
      const groups = new Map<string, DriveFile[]>();
      for (const file of rawFiles) {
        const normName = file.name.trim().toLowerCase();
        if (!groups.has(normName)) groups.set(normName, []);
        groups.get(normName)!.push(file);
      }

      const filesToDelete = new Set<DriveFile>();

      for (const files of groups.values()) {
        if (files.length > 1) {
          // Sắp xếp theo ngày tạo tăng dần (giữ lại tệp gốc cũ nhất)
          files.sort((a, b) => new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime());
          // Đánh dấu các tệp duplicate đến sau để xóa
          for (let i = 1; i < files.length; i++) {
            filesToDelete.add(files[i]);
          }
        }
      }

      // Xóa thực tế các tệp trùng lặp trên Google Drive
      for (const file of filesToDelete) {
        try {
          await deleteDriveFile(file.id);
          deletedFilesCount++;
          freedSpaceBytes += Number(file.size || 0);
          cleanedFilesDetails.push({
            fileName: file.name,
            memberName: member.name,
            deletedId: file.id,
          });
        } catch (delErr) {
          console.warn(`[Drive Duplicate Cleanup] Không thể xóa tệp trùng ${file.name} (${file.id}):`, delErr);
        }
      }
    } catch (err) {
      console.warn(`[Drive Duplicate Cleanup Error for ${member.name}]:`, err);
    }
  }

  return { deletedFilesCount, freedSpaceBytes, cleanedFilesDetails };
}
