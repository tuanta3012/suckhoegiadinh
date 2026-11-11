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

const ASSIGNED_SHARES_COLLECTION = 'assigned_shares';

export type WorkspaceAccessRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

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
  return value === 'ADMIN' || value === 'EDITOR' || value === 'VIEWER' || value === 'Admin' || value === 'Editor' || value === 'Viewer';
}

function normalizeRole(value: unknown): WorkspaceAccessRole {
  if (value === 'ADMIN' || value === 'Admin') return 'ADMIN';
  if (value === 'VIEWER' || value === 'Viewer') return 'VIEWER';
  return 'EDITOR';
}

function isFirestorePermissionDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'permission-denied'
  );
}

function assignedShareRef(memberEmail: string) {
  return doc(db, ASSIGNED_SHARES_COLLECTION, normalizeEmail(memberEmail));
}

export async function findAdminWorkspaceRelay(
  adminEmail: string,
): Promise<{ rootFolderId: string; familyFileId: string } | null> {
  const cleanEmail = normalizeEmail(adminEmail);
  if (!cleanEmail) return null;

  try {
    const adminDocRef = assignedShareRef(cleanEmail);
    const snapshot = await getDoc(adminDocRef);
    if (snapshot.exists()) {
      const data = snapshot.data();
      if (data.adminEmail === cleanEmail && (data.assignedFileId || data.rootFolderId) && data.familyFileId) {
        return {
          rootFolderId: data.assignedFileId || data.rootFolderId,
          familyFileId: data.familyFileId,
        };
      }
    }

    const q = query(
      collection(db, ASSIGNED_SHARES_COLLECTION),
      where('adminEmail', '==', cleanEmail)
    );
    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) return null;

    const docs = querySnapshot.docs.map(d => d.data());
    docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const latest = docs[0];

    const rootId = latest.assignedFileId || latest.rootFolderId;
    if (!rootId || !latest.familyFileId) return null;

    return {
      rootFolderId: rootId,
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

  const shareRef = assignedShareRef(cleanAdminEmail);
  const existing = await getDoc(shareRef);
  const now = Date.now();

  if (existing.exists()) {
    const data = existing.data();
    const existingRoot = data.assignedFileId || data.rootFolderId;
    if (data.adminEmail !== cleanAdminEmail || existingRoot !== rootFolderId) {
      throw new Error('Workspace trên Firestore đã được đăng ký bởi tài khoản Admin khác.');
    }
    if (data.familyFileId !== familyFileId || data.role !== 'ADMIN' || data.assignedFileName !== 'Suc khoe gia dinh') {
      await setDoc(
        shareRef,
        {
          familyFileId,
          role: 'ADMIN',
          assignedFileName: 'Suc khoe gia dinh',
          updatedAt: now,
        },
        { merge: true },
      );
    }
    return;
  }

  await setDoc(shareRef, {
    assignedFileId: rootFolderId,
    assignedFileName: 'Suc khoe gia dinh',
    familyFileId,
    adminEmail: cleanAdminEmail,
    memberEmail: cleanAdminEmail,
    role: 'ADMIN',
    status: 'active',
    updatedAt: now,
    createdAt: now,
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
      role: normalizeRole(member.role),
      source: member.source,
    });
  }
  if (uniqueMembers.size > 250) {
    throw new Error('Workspace vượt quá giới hạn 250 tài khoản được chia sẻ.');
  }

  const now = Date.now();
  const writes: Array<{ email: string; payload: Record<string, unknown> }> = [];

  for (const [memberEmail, { role, source }] of uniqueMembers) {
    writes.push({
      email: memberEmail,
      payload: {
        assignedFileId: rootFolderId,
        assignedFileName: 'Suc khoe gia dinh',
        familyFileId,
        adminEmail: cleanAdminEmail,
        memberEmail,
        role,
        status: 'active',
        updatedAt: now,
        createdAt: now,
        ...(source ? { source } : {}),
      },
    });
  }

  for (let offset = 0; offset < writes.length; offset += 200) {
    const batch = writeBatch(db);
    for (const item of writes.slice(offset, offset + 200)) {
      batch.set(assignedShareRef(item.email), item.payload, { merge: true });
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
    return null;
  }

  let snapshot;
  try {
    snapshot = await getDoc(assignedShareRef(cleanEmail));
  } catch (error) {
    if (isFirestorePermissionDenied(error)) {
      console.warn('[WorkspaceRelay] Firestore từ chối đọc assigned_shares:', cleanEmail);
      return null;
    }
    throw new Error('Không thể tải thông tin liên kết thư mục từ Firestore.');
  }
  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  const folderId = data.assignedFileId || data.folderId || data.rootFolderId;
  if (
    data.status !== 'active' ||
    typeof folderId !== 'string' ||
    !folderId.trim() ||
    typeof data.adminEmail !== 'string' ||
    !data.adminEmail.trim() ||
    typeof data.memberEmail !== 'string' ||
    normalizeEmail(data.memberEmail) !== cleanEmail ||
    typeof data.familyFileId !== 'string' ||
    !data.familyFileId.trim() ||
    typeof data.updatedAt !== 'number'
  ) {
    console.warn('[WorkspaceRelay] Bản ghi assigned_shares không hợp lệ:', cleanEmail);
    return null;
  }

  return {
    folderId,
    status: 'active',
    adminEmail: data.adminEmail,
    memberEmail: data.memberEmail,
    familyFileId: data.familyFileId,
    updatedAt: data.updatedAt,
  };
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
  if (!folderAssignment) return null;

  const snapshot = await getDoc(assignedShareRef(cleanEmail));
  const data = snapshot.exists() ? snapshot.data() : null;

  return {
    rootFolderId: folderAssignment.folderId,
    familyFileId: folderAssignment.familyFileId,
    adminEmail: folderAssignment.adminEmail,
    memberEmail: folderAssignment.memberEmail,
    role: data ? normalizeRole(data.role) : 'EDITOR',
    updatedAt: folderAssignment.updatedAt,
    source: data?.source === 'family_member' ? 'family_member' : undefined,
  };
}

export async function listHealthWorkspaceAssignments(
  rootFolderId: string,
): Promise<HealthWorkspaceAssignment[]> {
  try {
    const currentEmail = authenticatedEmail();
    const q = query(
      collection(db, ASSIGNED_SHARES_COLLECTION),
      where('adminEmail', '==', currentEmail)
    );
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];

    return snapshot.docs
      .map((docSnap) => {
        const data = docSnap.data();
        const docRootId = data.assignedFileId || data.rootFolderId || data.folderId;
        if (
          docRootId !== rootFolderId ||
          typeof data.familyFileId !== 'string' ||
          normalizeEmail(data.adminEmail) !== currentEmail ||
          !isWorkspaceRole(data.role) ||
          typeof data.updatedAt !== 'number'
        ) {
          return null;
        }

        return {
          rootFolderId: docRootId,
          familyFileId: data.familyFileId,
          adminEmail: data.adminEmail,
          memberEmail: data.memberEmail || docSnap.id,
          role: normalizeRole(data.role),
          updatedAt: data.updatedAt,
          source: data.source === 'family_member' ? 'family_member' : undefined,
        } satisfies HealthWorkspaceAssignment;
      })
      .filter(Boolean) as HealthWorkspaceAssignment[];
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
  const shareRef = assignedShareRef(cleanEmail);
  const snapshot = await getDoc(shareRef);
  if (!snapshot.exists()) return;

  const data = snapshot.data();
  const isAdmin = normalizeEmail(data.adminEmail) === currentEmail;
  if (!isAdmin && cleanEmail !== currentEmail) {
    throw new Error('Không có quyền thu hồi lời mời này.');
  }

  const batch = writeBatch(db);
  batch.delete(shareRef);
  await batch.commit();
}

export async function unregisterHealthWorkspace(
  rootFolderId: string,
): Promise<void> {
  const currentEmail = authenticatedEmail();
  const q = query(
    collection(db, ASSIGNED_SHARES_COLLECTION),
    where('adminEmail', '==', currentEmail)
  );
  const snapshot = await getDocs(q);
  if (snapshot.empty) return;

  const matchingDocs = snapshot.docs.filter((docSnap) => {
    const data = docSnap.data();
    const docRootId = data.assignedFileId || data.rootFolderId || data.folderId;
    return docRootId === rootFolderId;
  });

  for (let offset = 0; offset < matchingDocs.length; offset += 200) {
    const batch = writeBatch(db);
    for (const docSnap of matchingDocs.slice(offset, offset + 200)) {
      batch.delete(docSnap.ref);
    }
    await batch.commit();
  }
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

  const shareRef = assignedShareRef(cleanEmail);
  return onSnapshot(
    shareRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onAssignmentChange(null);
        return;
      }
      const data = snapshot.data();
      const rootId = data.assignedFileId || data.rootFolderId || data.folderId;
      if (
        data &&
        data.status === 'active' &&
        typeof rootId === 'string' &&
        rootId &&
        typeof data.familyFileId === 'string' &&
        data.familyFileId &&
        typeof data.adminEmail === 'string' &&
        normalizeEmail(data.memberEmail || snapshot.id) === cleanEmail &&
        isWorkspaceRole(data.role) &&
        typeof data.updatedAt === 'number'
      ) {
        onAssignmentChange({
          rootFolderId: rootId,
          familyFileId: data.familyFileId,
          adminEmail: data.adminEmail,
          memberEmail: cleanEmail,
          role: normalizeRole(data.role),
          updatedAt: data.updatedAt,
          source: data.source === 'family_member' ? 'family_member' : undefined,
        });
      } else {
        onAssignmentChange(null);
      }
    },
    (error) => {
      console.warn('[WorkspaceRelay] Lỗi khi lắng nghe thay đổi phân quyền Firestore:', error);
      onError?.(new Error('Không thể theo dõi lời mời Workspace trên Firestore.'));
    },
  );
}
