import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { getSignedInGoogleEmail } from './googleDriveService';
import { firestoreAuth as auth, firestoreDb as db } from './firebaseFirestore';
const RELAY_COLLECTION = 'health_workspace_relays';
const MEMBER_COLLECTION = 'members';
const INVITE_COLLECTION = 'health_workspace_invites';
const ASSIGNED_FOLDER_COLLECTION = 'health_assigned_folders';

export type WorkspaceAccessRole = 'EDITOR' | 'VIEWER';

export interface HealthWorkspaceAssignment {
  rootFolderId: string;
  familyFileId: string;
  adminEmail: string;
  memberEmail: string;
  role: WorkspaceAccessRole;
  updatedAt: number;
  source?: 'family_member';
}

export interface HealthAssignedFolder {
  folderId: string;
  status: 'active';
  adminEmail: string;
  memberEmail: string;
  familyFileId: string;
  updatedAt: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function authenticatedEmail(): string {
  const email = auth.currentUser?.email || getSignedInGoogleEmail();
  if (!email) {
    throw new Error('Cần đăng nhập Google để chia sẻ Workspace.');
  }
  return normalizeEmail(email);
}

function isWorkspaceRole(value: unknown): value is WorkspaceAccessRole {
  return value === 'EDITOR' || value === 'VIEWER';
}

function isFirestorePermissionDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'permission-denied'
  );
}

function memberAssignmentRef(rootFolderId: string, memberEmail: string) {
  return doc(db, RELAY_COLLECTION, rootFolderId, MEMBER_COLLECTION, normalizeEmail(memberEmail));
}

function memberInviteRef(rootFolderId: string, memberEmail: string) {
  return doc(
    db,
    INVITE_COLLECTION,
    normalizeEmail(memberEmail),
    'workspaces',
    rootFolderId,
  );
}

function assignedFolderRef(memberEmail: string) {
  return doc(db, ASSIGNED_FOLDER_COLLECTION, normalizeEmail(memberEmail));
}

export async function findAdminWorkspaceRelay(
  adminEmail: string,
): Promise<{ rootFolderId: string; familyFileId: string } | null> {
  const cleanEmail = normalizeEmail(adminEmail);
  if (!cleanEmail) return null;

  try {
    const q = query(
      collection(db, RELAY_COLLECTION),
      where('adminEmail', '==', cleanEmail)
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    const docs = snapshot.docs.map(d => d.data());
    docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const latest = docs[0];

    return {
      rootFolderId: latest.rootFolderId,
      familyFileId: latest.familyFileId,
    };
  } catch (error) {
    console.error('[WorkspaceRelay] Lỗi khi tìm Workspace qua email Admin:', error);
    return null;
  }
}

export async function registerHealthWorkspaceRelay(
  rootFolderId: string,
  familyFileId: string,
  adminEmail: string,
): Promise<void> {
  const cleanAdminEmail = normalizeEmail(adminEmail);
  if (!rootFolderId.trim() || !familyFileId.trim() || !cleanAdminEmail) {
    throw new Error('Thiếu thông tin để đăng ký Workspace trên Firestore.');
  }
  if (authenticatedEmail() !== cleanAdminEmail) {
    throw new Error('Chỉ tài khoản Admin của Workspace mới được đăng ký chuyển tiếp.');
  }

  const workspaceRef = doc(db, RELAY_COLLECTION, rootFolderId);
  const existing = await getDoc(workspaceRef);
  if (existing.exists()) {
    const data = existing.data();
    if (data.adminEmail !== cleanAdminEmail || data.rootFolderId !== rootFolderId) {
      throw new Error('Workspace trên Firestore đã được đăng ký bởi tài khoản Admin khác.');
    }
    if (data.familyFileId !== familyFileId) {
      await setDoc(
        workspaceRef,
        {
          familyFileId,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    }
    return;
  }

  await setDoc(workspaceRef, {
    rootFolderId,
    familyFileId,
    adminEmail: cleanAdminEmail,
    updatedAt: Date.now(),
  });
}

export async function publishHealthWorkspaceAssignments(
  rootFolderId: string,
  familyFileId: string,
  adminEmail: string,
  members: Array<{
    email: string;
    role: WorkspaceAccessRole;
    source?: 'family_member';
  }>,
): Promise<void> {
  const cleanAdminEmail = normalizeEmail(adminEmail);
  if (authenticatedEmail() !== cleanAdminEmail) {
    throw new Error('Chỉ Admin đã đăng nhập mới được chia sẻ Workspace.');
  }
  await registerHealthWorkspaceRelay(rootFolderId, familyFileId, cleanAdminEmail);

  const uniqueMembers = new Map<string, { role: WorkspaceAccessRole; source?: 'family_member' }>();
  for (const member of members) {
    const email = normalizeEmail(member.email);
    if (!email || email === cleanAdminEmail) {
      continue;
    }
    if (!isWorkspaceRole(member.role)) {
      throw new Error('Danh sách thành viên chia sẻ có quyền không hợp lệ.');
    }
    uniqueMembers.set(email, {
      role: member.role,
      source: member.source,
    });
  }
  if (uniqueMembers.size > 250) {
    throw new Error('Workspace vượt quá giới hạn 250 tài khoản được chia sẻ.');
  }
  const assignedMemberEmails = [...uniqueMembers]
    .filter(([, assignment]) => assignment.source === 'family_member')
    .map(([email]) => email);

  const existingAssignments = await listHealthWorkspaceAssignments(rootFolderId);
  const existingByEmail = new Map(existingAssignments.map((assignment) => [assignment.memberEmail, assignment]));
  const now = Date.now();
  const writes: HealthWorkspaceAssignment[] = [];
  for (const [memberEmail, { role, source }] of uniqueMembers) {
    const existing = existingByEmail.get(memberEmail);
    if (
      existing &&
      existing.familyFileId === familyFileId &&
      existing.adminEmail === cleanAdminEmail &&
      existing.role === role &&
      existing.source === source
    ) {
      continue;
    }
    writes.push({
      rootFolderId,
      familyFileId,
      adminEmail: cleanAdminEmail,
      memberEmail,
      role,
      updatedAt: now,
      ...(source ? { source } : {}),
    });
  }

  for (let offset = 0; offset < writes.length; offset += 200) {
    const batch = writeBatch(db);
    for (const assignment of writes.slice(offset, offset + 200)) {
      batch.set(memberAssignmentRef(rootFolderId, assignment.memberEmail), assignment);
      batch.set(memberInviteRef(rootFolderId, assignment.memberEmail), assignment);
    }
    await batch.commit();
  }

  for (let offset = 0; offset < assignedMemberEmails.length; offset += 200) {
    const batch = writeBatch(db);
    for (const memberEmail of assignedMemberEmails.slice(offset, offset + 200)) {
      batch.set(assignedFolderRef(memberEmail), {
        folderId: rootFolderId,
        status: 'active',
        adminEmail: cleanAdminEmail,
        memberEmail,
        familyFileId,
        updatedAt: now,
      } satisfies HealthAssignedFolder);
    }
    await batch.commit();
  }

}

export async function readHealthAssignedFolder(
  memberEmail: string,
): Promise<HealthAssignedFolder | null> {
  const cleanEmail = normalizeEmail(memberEmail);
  if (!cleanEmail) return null;
  
  try {
    const currentEmail = authenticatedEmail();
    if (currentEmail !== cleanEmail) return null;
  } catch (error) {
    // Không có phiên đăng nhập hợp lệ
    return null;
  }

  let snapshot;
  try {
    snapshot = await getDoc(assignedFolderRef(cleanEmail));
  } catch (error) {
    if (isFirestorePermissionDenied(error)) {
      console.warn('[WorkspaceRelay] Firestore từ chối đọc health_assigned_folders:', cleanEmail);
      return null;
    }
    throw new Error('Không thể tải thông tin liên kết thư mục từ Firestore.');
  }
  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (
    data.status !== 'active' ||
    typeof data.folderId !== 'string' ||
    !data.folderId.trim() ||
    typeof data.adminEmail !== 'string' ||
    !data.adminEmail.trim() ||
    typeof data.memberEmail !== 'string' ||
    normalizeEmail(data.memberEmail) !== cleanEmail ||
    typeof data.familyFileId !== 'string' ||
    !data.familyFileId.trim() ||
    typeof data.updatedAt !== 'number'
  ) {
    console.warn('[WorkspaceRelay] Bản ghi health_assigned_folders không hợp lệ:', cleanEmail);
    return null;
  }
  return data as HealthAssignedFolder;
}

export async function readHealthWorkspaceAssignment(
  memberEmail: string,
): Promise<HealthWorkspaceAssignment | null> {
  const cleanEmail = normalizeEmail(memberEmail);
  if (!cleanEmail) return null;

  try {
    const currentEmail = authenticatedEmail();
    if (currentEmail !== cleanEmail) {
      console.info('[WorkspaceRelay] Email đăng nhập khác email Firebase Auth hiện tại.');
      return null;
    }
  } catch (error) {
    console.info('[WorkspaceRelay] Chưa có phiên Firebase Auth hợp lệ:', error);
    return null;
  }

  const folderAssignment = await readHealthAssignedFolder(cleanEmail);
  if (folderAssignment) {
    return {
      rootFolderId: folderAssignment.folderId,
      familyFileId: folderAssignment.familyFileId,
      adminEmail: folderAssignment.adminEmail,
      memberEmail: folderAssignment.memberEmail,
      role: 'EDITOR',
      updatedAt: folderAssignment.updatedAt,
      source: 'family_member',
    };
  }

  let invites;
  try {
    invites = await getDocs(collection(db, INVITE_COLLECTION, cleanEmail, 'workspaces'));
  } catch (error) {
    if (isFirestorePermissionDenied(error)) return null;
    throw new Error('Không thể tải lời mời Workspace. Hãy kiểm tra kết nối rồi thử lại.');
  }

  if (!invites || invites.empty) {
    return null;
  }

  const matchingAssignments: HealthWorkspaceAssignment[] = [];
  for (const invite of invites.docs) {
    const data = invite.data();
    if (
      data &&
      typeof data.rootFolderId === 'string' &&
      data.rootFolderId === invite.id &&
      typeof data.familyFileId === 'string' &&
      data.familyFileId &&
      typeof data.adminEmail === 'string' &&
      data.memberEmail === cleanEmail &&
      isWorkspaceRole(data.role) &&
      typeof data.updatedAt === 'number'
    ) {
      matchingAssignments.push(data as HealthWorkspaceAssignment);
    }
  }

  if (matchingAssignments.length === 0) {
    return null;
  }

  if (matchingAssignments.length > 1) {
    throw new Error('Tài khoản có nhiều lời mời Workspace. Hãy mở Workspace bằng liên kết hoặc thư mục Drive cụ thể.');
  }
  return matchingAssignments[0] || null;
}

export async function listHealthWorkspaceAssignments(
  rootFolderId: string,
): Promise<HealthWorkspaceAssignment[]> {
  try {
    const workspaceRef = doc(db, RELAY_COLLECTION, rootFolderId);
    const workspace = await getDoc(workspaceRef);
    const currentEmail = authenticatedEmail();
    if (!workspace.exists()) {
      return [];
    }
    const data = workspace.data();
    if (!data.adminEmail || normalizeEmail(data.adminEmail) !== currentEmail) {
      return [];
    }

    const members = await getDocs(collection(workspaceRef, MEMBER_COLLECTION));
    return members.docs.map((snapshot) => {
      const memberData = snapshot.data();
      if (
        memberData.rootFolderId !== rootFolderId ||
        typeof memberData.familyFileId !== 'string' ||
        normalizeEmail(memberData.adminEmail) !== currentEmail ||
        memberData.memberEmail !== snapshot.id ||
        !isWorkspaceRole(memberData.role) ||
        (memberData.source !== undefined && memberData.source !== 'family_member') ||
        typeof memberData.updatedAt !== 'number'
      ) {
        return null;
      }
      return memberData as HealthWorkspaceAssignment;
    }).filter(Boolean) as HealthWorkspaceAssignment[];
  } catch (error) {
    if (isFirestorePermissionDenied(error)) {
      return [];
    }
    console.warn('[WorkspaceRelay] Lỗi khi liệt kê phân quyền Workspace:', error);
    return [];
  }
}

export async function removeHealthWorkspaceAssignment(
  rootFolderId: string,
  memberEmail: string,
): Promise<void> {
  const cleanEmail = normalizeEmail(memberEmail);
  const currentEmail = authenticatedEmail();
  const workspace = await getDoc(doc(db, RELAY_COLLECTION, rootFolderId));
  if (!workspace.exists()) return;
  const isAdmin = normalizeEmail(workspace.data().adminEmail) === currentEmail;
  if (!isAdmin && cleanEmail !== currentEmail) {
    throw new Error('Không có quyền thu hồi lời mời này.');
  }
  const batch = writeBatch(db);
  batch.delete(memberAssignmentRef(rootFolderId, cleanEmail));
  batch.delete(memberInviteRef(rootFolderId, cleanEmail));
  batch.delete(assignedFolderRef(cleanEmail));
  await batch.commit();
}
export async function unregisterHealthWorkspace(
  rootFolderId: string,
): Promise<void> {
  const currentEmail = authenticatedEmail();
  const workspaceRef = doc(db, RELAY_COLLECTION, rootFolderId);
  const snapshot = await getDoc(workspaceRef);
  
  if (!snapshot.exists()) return;
  
  const data = snapshot.data();
  if (normalizeEmail(data.adminEmail) !== currentEmail) {
    throw new Error('Chỉ tài khoản Admin mới có quyền xóa đăng ký Workspace.');
  }

  const membersSnapshot = await getDocs(collection(workspaceRef, MEMBER_COLLECTION));
  const memberEmails = membersSnapshot.docs.map((memberDoc) => memberDoc.id);
  for (let offset = 0; offset < memberEmails.length; offset += 200) {
    const batch = writeBatch(db);
    for (const memberEmail of memberEmails.slice(offset, offset + 200)) {
      batch.delete(memberAssignmentRef(rootFolderId, memberEmail));
      batch.delete(memberInviteRef(rootFolderId, memberEmail));
    }
    await batch.commit();
  }

  const batch = writeBatch(db);
  batch.delete(workspaceRef);
  await batch.commit();
}

export function subscribeHealthWorkspaceAssignments(
  memberEmail: string,
  onAssignmentChange: (assignment: HealthWorkspaceAssignment | null) => void,
  onError?: (error: Error) => void,
): () => void {
  const cleanEmail = normalizeEmail(memberEmail);
  if (!cleanEmail) {
    onAssignmentChange(null);
    return () => {};
  }

  const invitesRef = collection(db, INVITE_COLLECTION, cleanEmail, 'workspaces');
  return onSnapshot(
    invitesRef,
    (snapshot) => {
      if (snapshot.empty) {
        onAssignmentChange(null);
        return;
      }
      const matching: HealthWorkspaceAssignment[] = [];
      for (const inviteDoc of snapshot.docs) {
        const data = inviteDoc.data();
        if (
          data &&
          typeof data.rootFolderId === 'string' &&
          data.rootFolderId === inviteDoc.id &&
          typeof data.familyFileId === 'string' &&
          data.familyFileId &&
          typeof data.adminEmail === 'string' &&
          data.memberEmail === cleanEmail &&
          isWorkspaceRole(data.role) &&
          typeof data.updatedAt === 'number'
        ) {
          matching.push(data as HealthWorkspaceAssignment);
        }
      }
      if (matching.length > 1) {
        onError?.(new Error('Tài khoản có nhiều lời mời Workspace. Hãy nhờ quản trị viên thu hồi các lời mời trùng.'));
        return;
      }
      onAssignmentChange(matching[0] || null);
    },
    (error) => {
      console.warn('[WorkspaceRelay] Lỗi khi lắng nghe thay đổi phân quyền Firestore:', error);
      onError?.(new Error('Không thể theo dõi lời mời Workspace trên Firestore.'));
    },
  );
}
