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
import { findAdminWorkspaceRelay, registerHealthWorkspaceRelay, unregisterHealthWorkspace } from './workspaceShareRelay';
import { localSyncOutbox, supportsDurableOfflineQueue } from './localSyncOutbox';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_MIME = 'application/json';
const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,webViewLink,size';
const LOCAL_WORKSPACE_ID = 'local_offline_workspace';

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
}

export interface HealthDriveWorkspace {
  rootFolderId: string;
  familyFileId: string;
  family: HealthFamily;
  relayRegistrationError?: string;
}

function accessToken(): string {
  return getGoogleAccessToken() || '';
}

function isLocalProfileFileId(fileId: string): boolean {
  return /^(?:local_profile_|profile_local_)/.test(fileId);
}

async function performDriveFetch(
  url: string,
  init: RequestInit,
  headers: Headers,
  nativeJsonResponse: boolean,
): Promise<Response> {
  const canUseNativeHttp = Capacitor.isNativePlatform() &&
    (nativeJsonResponse || !url.includes('alt=media')) &&
    (init.body === undefined || typeof init.body === 'string');
  if (!canUseNativeHttp) return fetch(url, { ...init, headers });

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
  return new Response(responseBody, {
    status: nativeResponse.status,
    headers: nativeResponse.headers,
  });
}

async function authenticatedDriveFetch(
  url: string,
  init: RequestInit = {},
  nativeJsonResponse = false,
): Promise<Response> {
  const token = await getValidGoogleAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await performDriveFetch(url, init, headers, nativeJsonResponse);
  if (response.status !== 401) return response;

  const refreshedToken = await trySilentRefresh(true);
  if (!refreshedToken) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('google-drive-auth-expired'));
    }
    throw new Error('Google Drive từ chối phiên hiện tại. Hãy đăng nhập lại để cấp quyền Drive.');
  }
  headers.set('Authorization', `Bearer ${refreshedToken}`);
  return performDriveFetch(url, init, headers, nativeJsonResponse);
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
  const metadata: Record<string, string | string[]> = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  return driveRequest<DriveFile>(`${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
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
  const metadata = JSON.stringify({ name, mimeType, parents: [parentId] });
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
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
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
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
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
    `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    },
  );
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
        return await openHealthWorkspace(rootFolderId, familyFileId);
      }
    } catch (e) {
      localStorage.removeItem(cacheKey);
    }
  }

  // 2. Kiểm tra Firestore Shadow Index (Nếu đổi thiết bị)
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
    console.warn('[Discovery] Không thể tra cứu Firestore Index:', error);
  }

  // 3. Fallback: Quét Drive (Chậm nhất, chỉ chạy 1 lần duy nhất)
  try {
    const foldersToInspect = await listFiles('root', LEGACY_WORKSPACE_FOLDER_NAMES, FOLDER_MIME);
    if (foldersToInspect.length === 0) return null;

    // 3. Fast-path inspection: Look for family.json directly in root candidates
    const inspectionResults = await Promise.all(
      foldersToInspect.map(async (folder) => {
        try {
          const manifestFiles = await listFiles(folder.id, 'family.json', JSON_MIME);
          return manifestFiles.length > 0
            ? { folder, manifestId: manifestFiles[0].id }
            : null;
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
      const opened = await openHealthWorkspace(folder.id, manifestId);
      
      // Đăng ký lại vào Firestore & localStorage để lần sau tìm nhanh hơn
      if (userEmail && opened.family.adminEmail === userEmail.trim().toLowerCase()) {
        const payload = { rootFolderId: opened.rootFolderId, familyFileId: opened.familyFileId };
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(cacheKey, JSON.stringify(payload));
        }
        void registerHealthWorkspaceRelay(opened.rootFolderId, opened.familyFileId, userEmail).catch(() => {});
      }
      
      return opened;
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

export async function createHealthWorkspace(adminEmail: string, adminName?: string | null): Promise<HealthDriveWorkspace> {
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

    const manifestFiles = await listFiles(existingRoot.id, 'family.json', JSON_MIME);
    if (manifestFiles.length > 0) {
      return openHealthWorkspace(existingRoot.id);
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
  // Tối ưu: Lấy metadata và nội dung song song nếu đã biết manifest ID
  const cachedManifestFileId = knownManifestFileId || getCachedWorkspaceFileId(rootFolderId);
  const manifestIdPromise = cachedManifestFileId
    ? Promise.resolve(cachedManifestFileId)
    : listFiles(rootFolderId, 'family.json', JSON_MIME).then(files => files[0]?.id);

  const [root, manifestFileId] = await Promise.all([
    driveRequest<DriveFile>(`${DRIVE_API}/files/${encodeURIComponent(rootFolderId)}?fields=${FILE_FIELDS}`),
    manifestIdPromise
  ]);

  if (root.mimeType !== FOLDER_MIME) throw new Error('ID được nhập không phải là thư mục Google Drive.');
  if (!manifestFileId) throw new Error('Không tìm thấy family.json trong thư mục. Hãy kiểm tra thư mục hoặc tạo không gian mới.');

  const familyResponse = await driveRequest<HealthFamily>(
    `${DRIVE_API}/files/${encodeURIComponent(manifestFileId)}?alt=media`,
    {},
    true,
  );
  if (familyResponse.schemaVersion !== 1 || !Array.isArray(familyResponse.members)) {
    throw new Error('Tệp family.json không hợp lệ hoặc không được hỗ trợ.');
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
    const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(workspace.familyFileId)}?alt=media`, {
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
  return saveHealthFamily(workspace, family);
}

export async function updateDriveFamilyMember(
  workspace: HealthDriveWorkspace,
  memberId: string,
  updates: Partial<FamilyMember>,
): Promise<HealthDriveWorkspace> {
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
  const profileData = await loadHealthProfile(updatedMember.profileFileId);
  const profile = parseHealthProfile(profileData, existingMember);
  const updatedProfile = { ...profile, member: updatedMember };
  await saveHealthProfile(updatedMember.profileFileId, updatedProfile);
  try {
    return await saveHealthFamily(workspace, { ...workspace.family, members });
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
}

export async function deleteDriveFamilyMember(
  workspace: HealthDriveWorkspace,
  memberId: string,
): Promise<{ workspace: HealthDriveWorkspace }> {
  const member = workspace.family.members.find((item) => item.id === memberId);
  if (!member) throw new Error('Không tìm thấy thành viên cần xóa trong Workspace hiện tại.');
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
  if (!member.driveFolderId || !member.profileFileId) {
    throw new Error('Thành viên thiếu ID thư mục hoặc hồ sơ Drive; không thể xóa an toàn.');
  }

  const fileIds = [member.profileFileId, member.driveFolderId].filter(Boolean);
  await deleteDriveFilesBatch(fileIds);

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

  return { workspace: updatedWorkspace };
}

export async function deleteHealthWorkspaceFolder(rootFolderId: string): Promise<void> {
  if (!rootFolderId.trim()) throw new Error('Thiếu mã thư mục Workspace cần xóa.');
  
  // 1. Xóa cache cục bộ ngay lập tức (Tốc độ Sheets)
  const userEmail = getSignedInGoogleEmail();
  if (userEmail) {
    void clearWorkspaceCache(userEmail);
  }
  
  // 2. Ẩn thư mục trên Drive bằng cách đổi tên (Instant)
  // Việc đổi tên giúp bước "Quét Drive" (Discovery) không bao giờ tìm lại được folder này nữa
  const renamePromise = renameDriveFolder(rootFolderId, `DELETED_${Date.now()}_${rootFolderId}`).catch(() => {});

  // 3. Xóa đăng ký Firestore Registry (Fast)
  const unregisterPromise = unregisterHealthWorkspace(rootFolderId).catch((error) => {
    console.warn('[Discovery] Không thể xóa Index Firestore cho Workspace đã xóa:', error);
  });

  // Đợi đồng bộ cache và registry; việc xóa toàn bộ dữ liệu Drive vẫn chạy nền.
  await Promise.all([renamePromise, unregisterPromise]);

  // 4. Xóa dữ liệu con rồi mới xóa thư mục gốc; không chặn phản hồi UI.
  void (async () => {
    try {
      const descendants = await listFolderContentsRecursively(rootFolderId);
      await deleteDriveFilesBatch(descendants.map((file) => file.id));
      await deleteDriveFile(rootFolderId);
    } catch (error) {
      console.warn('[Drive Deletion] Không thể xóa toàn bộ Workspace trên Drive.', error);
    }
  })();
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
      `${DRIVE_API}/files/${encodeURIComponent(workspace.familyFileId)}?alt=media`
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
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
    true,
  );
}

async function saveHealthProfileRemote(fileId: string, profile: HealthProfile): Promise<HealthProfile> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
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
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=parents`,
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
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    { method: 'PATCH' },
  );
}

export async function downloadDriveFile(fileId: string): Promise<Blob> {
  const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  if (!response.ok) throw new Error(`Không thể tải tài liệu gốc (HTTP ${response.status}).`);
  return response.blob();
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const response = await authenticatedDriveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE' },
  );
  if (response.ok || response.status === 404) return;
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  throw new Error(body?.error?.message || `Google Drive trả về lỗi ${response.status} khi xóa tệp.`);
}

export async function revokeDriveFolderAccess(folderId: string, memberEmail: string): Promise<void> {
  const normalizedEmail = memberEmail.trim().toLowerCase();
  if (!folderId.trim() || !normalizedEmail) {
    throw new Error('Thiếu mã thư mục hoặc email để thu hồi quyền Google Drive.');
  }

  const permissions: Array<{
    id?: string;
    emailAddress?: string;
    type?: string;
    role?: string;
    deleted?: boolean;
  }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      fields: 'nextPageToken,permissions(id,emailAddress,type,role,deleted)',
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await driveRequest<{
      permissions?: typeof permissions;
      nextPageToken?: string;
    }>(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions?${params.toString()}`,
    );
    permissions.push(...(result.permissions || []));
    pageToken = result.nextPageToken;
  } while (pageToken);

  const matchingPermissions = permissions.filter((permission) =>
    permission.id &&
    permission.type === 'user' &&
    permission.role !== 'owner' &&
    !permission.deleted &&
    permission.emailAddress?.trim().toLowerCase() === normalizedEmail,
  );
  for (const permission of matchingPermissions) {
    const response = await authenticatedDriveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(folderId)}/permissions/${encodeURIComponent(permission.id!)}`,
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
