import { getGoogleAccessToken, getValidGoogleAccessToken, trySilentRefresh } from './googleDriveService';
import type { FamilyMember, HealthFamily, HealthProfile } from '../types';
import { canDeleteRawSource, mergeHealthProfiles, parseHealthProfile } from './healthProfile';
import { registerHealthWorkspaceRelay } from './workspaceShareRelay';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_MIME = 'application/json';
const FILE_FIELDS = 'id,name,mimeType,createdTime,modifiedTime,webViewLink,size';

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

async function authenticatedDriveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidGoogleAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (response.status !== 401) return response;

  const refreshedToken = await trySilentRefresh(true);
  if (!refreshedToken) {
    throw new Error('Google Drive từ chối phiên hiện tại. Hãy đăng nhập lại để cấp quyền Drive.');
  }
  headers.set('Authorization', `Bearer ${refreshedToken}`);
  return fetch(url, { ...init, headers });
}

async function driveRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedDriveFetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      ...init.headers,
    },
  });
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

function driveQuery(parentId: string, name: string, mimeType?: string): string {
  const clauses = [`'${parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents`, `name = '${name.replace(/'/g, "\\'")}'`, 'trashed = false'];
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  return clauses.join(' and ');
}

async function listFiles(parentId: string, name?: string, mimeType?: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: name ? driveQuery(parentId, name, mimeType) : `'${parentId}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '1000',
      orderBy: 'name',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await driveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(
      `${DRIVE_API}/files?${params.toString()}`,
    );
    files.push(...(result.files || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

async function listFolderContentsRecursively(folderId: string, visited = new Set<string>()): Promise<DriveFile[]> {
  if (visited.has(folderId)) return [];
  visited.add(folderId);
  const children = await listFiles(folderId);
  const descendants: DriveFile[] = [];
  for (const child of children) {
    if (child.mimeType === FOLDER_MIME) {
      descendants.push(...await listFolderContentsRecursively(child.id, visited));
    } else {
      descendants.push(child);
    }
  }
  return [...descendants, ...children.filter((child) => child.mimeType === FOLDER_MIME)];
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
  for (const folderName of LEGACY_WORKSPACE_FOLDER_NAMES) {
    const existingFolders = await listFiles('root', folderName, FOLDER_MIME);
    for (const folder of existingFolders) {
      const manifestFiles = await listFiles(folder.id, 'family.json', JSON_MIME);
      if (manifestFiles.length > 0) {
        if (folder.name !== WORKSPACE_FOLDER_NAME) {
          void renameDriveFolder(folder.id, WORKSPACE_FOLDER_NAME).catch((error) => {
            console.warn('[Google Drive] Không thể chuẩn hóa tên Workspace cũ.', error);
          });
        }
        return openHealthWorkspace(folder.id);
      }
    }
  }
  return null;
}

export async function createHealthWorkspace(adminEmail: string): Promise<HealthDriveWorkspace> {
  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  if (!cleanAdminEmail) throw new Error('Cần đăng nhập trước khi tạo Workspace gia đình.');

  // Kiểm tra xem đã có thư mục nào được tạo trước đó chưa (tránh trùng lặp / phục hồi gián đoạn)
  const existingFolders: DriveFile[] = [];
  for (const folderName of LEGACY_WORKSPACE_FOLDER_NAMES) {
    const found = await listFiles('root', folderName, FOLDER_MIME);
    existingFolders.push(...found);
  }

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
    if (!raw) raw = await createFolder('raw_files', existingRoot.id);
    if (!profiles) profiles = await createFolder('profiles', existingRoot.id);

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
    return {
      rootFolderId: existingRoot.id,
      familyFileId: manifest.id,
      family,
      relayRegistrationError,
    };
  }

  // Khởi tạo thư mục hoàn toàn mới với tên "Suc khoe gia dinh"
  const root = await createFolder(WORKSPACE_FOLDER_NAME);
  const raw = await createFolder('raw_files', root.id);
  const profiles = await createFolder('profiles', root.id);
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
  return { rootFolderId: root.id, familyFileId: manifest.id, family, relayRegistrationError };
}

export async function openHealthWorkspace(rootFolderId: string): Promise<HealthDriveWorkspace> {
  const root = await driveRequest<DriveFile>(`${DRIVE_API}/files/${encodeURIComponent(rootFolderId)}?fields=${FILE_FIELDS}`);
  if (root.mimeType !== FOLDER_MIME) throw new Error('ID được nhập không phải là thư mục Google Drive.');
  const manifestFiles = await listFiles(rootFolderId, 'family.json', JSON_MIME);
  if (!manifestFiles.length) throw new Error('Không tìm thấy family.json trong thư mục. Hãy kiểm tra thư mục hoặc tạo không gian mới.');
  const familyResponse = await driveRequest<HealthFamily>(
    `${DRIVE_API}/files/${encodeURIComponent(manifestFiles[0].id)}?alt=media`,
  );
  if (familyResponse.schemaVersion !== 1 || !Array.isArray(familyResponse.members)) {
    throw new Error('Tệp family.json không hợp lệ hoặc không được hỗ trợ.');
  }
  return { rootFolderId, familyFileId: manifestFiles[0].id, family: familyResponse };
}

export async function saveHealthFamily(workspace: HealthDriveWorkspace, family: HealthFamily): Promise<HealthDriveWorkspace> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(workspace.familyFileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken()}` },
    });
    if (!response.ok) throw new Error(`Không thể tải family.json mới nhất (HTTP ${response.status}).`);
    const latest = await response.json() as HealthFamily;
    if (latest.schemaVersion !== 1 || !Array.isArray(latest.members)) {
      throw new Error('family.json không hợp lệ; không thể cập nhật danh sách thành viên.');
    }

    const members = new Map(latest.members.map((member) => [member.id, member]));
    for (const member of family.members) {
      if (!members.has(member.id)) members.set(member.id, member);
    }
    const next: HealthFamily = {
      ...latest,
      ...family,
      members: [...members.values()],
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

export async function deleteDriveFamilyMember(
  workspace: HealthDriveWorkspace,
  memberId: string,
): Promise<{ workspace: HealthDriveWorkspace }> {
  const member = workspace.family.members.find((item) => item.id === memberId);
  if (!member) throw new Error('Không tìm thấy thành viên cần xóa trong Workspace hiện tại.');
  if (!member.driveFolderId || !member.profileFileId) {
    throw new Error('Thành viên thiếu ID thư mục hoặc hồ sơ Drive; không thể xóa an toàn.');
  }

  const filesToDelete = await listFolderContentsRecursively(member.driveFolderId);
  const fileIds = [...new Set([
    member.profileFileId,
    ...filesToDelete.map((file) => file.id),
    member.driveFolderId,
  ])];
  const deletionErrors: string[] = [];
  for (const fileId of fileIds) {
    try {
      await deleteDriveFile(fileId);
    } catch (error) {
      deletionErrors.push(error instanceof Error ? error.message : 'Lỗi không xác định.');
    }
  }
  if (deletionErrors.length > 0) {
    throw new Error(
      `Chưa xóa được toàn bộ dữ liệu của ${member.name}; thành viên vẫn được giữ trong danh sách để có thể thử lại. ${deletionErrors.slice(0, 3).join('; ')}`,
    );
  }

  const familyWithoutMember: HealthFamily = {
    ...workspace.family,
    members: workspace.family.members.filter((item) => item.id !== memberId),
  };
  const updatedWorkspace = await removeFamilyMemberFromManifest(workspace, familyWithoutMember, memberId);

  return { workspace: updatedWorkspace };
}

export async function factoryResetWorkspaceFolder(
  workspace: HealthDriveWorkspace,
  adminEmail: string
): Promise<HealthDriveWorkspace> {
  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  const deletionErrors: string[] = [];

  for (const member of workspace.family.members) {
    const memberErrors: string[] = [];
    if (member.driveFolderId) {
      let files: DriveFile[] = [];
      try {
        files = await listFolderContentsRecursively(member.driveFolderId);
      } catch (error) {
        memberErrors.push(`${member.name}: không thể liệt kê tài liệu (${error instanceof Error ? error.message : 'lỗi không xác định'})`);
      }
      for (const file of files) {
        try {
          await deleteDriveFile(file.id);
        } catch (error) {
          memberErrors.push(`${file.name}: ${error instanceof Error ? error.message : 'không thể xóa'}`);
        }
      }
      if (memberErrors.length === 0) {
        try {
          await deleteDriveFile(member.driveFolderId);
        } catch (error) {
          memberErrors.push(`${member.name}: ${error instanceof Error ? error.message : 'không thể xóa thư mục'}`);
        }
      }
    }
    if (member.profileFileId) {
      try {
        await deleteDriveFile(member.profileFileId);
      } catch (error) {
        memberErrors.push(`${member.name} (hồ sơ): ${error instanceof Error ? error.message : 'không thể xóa'}`);
      }
    }
    deletionErrors.push(...memberErrors);
  }

  if (deletionErrors.length > 0) {
    const examples = deletionErrors.slice(0, 5).join('; ');
    const remaining = deletionErrors.length - Math.min(deletionErrors.length, 5);
    throw new Error(
      `Chưa thể hoàn tất khởi tạo lại vì còn ${deletionErrors.length} lỗi xóa trên Drive: ${examples}${remaining ? `; và ${remaining} lỗi khác` : ''}. Danh sách thành viên được giữ nguyên; hãy kiểm tra Drive rồi thử lại.`,
    );
  }

  const now = new Date().toISOString();
  const resetFamily: HealthFamily = {
    schemaVersion: 1,
    adminEmail: cleanAdminEmail,
    rawFilesFolderId: workspace.family.rawFilesFolderId,
    profilesFolderId: workspace.family.profilesFolderId,
    members: [],
    createdAt: workspace.family.createdAt || now,
    updatedAt: now,
  };

  const response = await authenticatedDriveFetch(`${DRIVE_API}/files/${encodeURIComponent(workspace.familyFileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken()}` },
  });
  const etag = response.ok ? response.headers.get('etag') || undefined : undefined;

  const file = await replaceContent(
    workspace.familyFileId,
    'family.json',
    JSON_MIME,
    new Blob([JSON.stringify(resetFamily, null, 2)]),
    etag
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
  return driveRequest<HealthProfile>(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
}

export async function saveHealthProfile(fileId: string, profile: HealthProfile): Promise<HealthProfile> {
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

export async function uploadRawHealthFile(
  member: FamilyMember,
  file: File,
): Promise<DriveFile> {
  return uploadContent(file.name, file.type || 'application/octet-stream', file, member.driveFolderId);
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
      deleted++;
    }
  }
  return { deleted, retained };
}
