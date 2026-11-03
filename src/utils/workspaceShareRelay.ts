import { getApps, getApp, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const databaseId = firebaseConfig.firestoreDatabaseId;
const db = (!databaseId || databaseId === '(default)') ? getFirestore(app) : getFirestore(app, databaseId);
const RELAY_COLLECTION = 'health_workspace_relays';
const MEMBER_COLLECTION = 'members';
const INVITE_COLLECTION = 'health_workspace_invites';

export type WorkspaceAccessRole = 'EDITOR' | 'VIEWER';

export interface HealthWorkspaceAssignment {
  rootFolderId: string;
  familyFileId: string;
  adminEmail: string;
  memberEmail: string;
  role: WorkspaceAccessRole;
  updatedAt: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function authenticatedEmail(): string {
  const email = auth.currentUser?.email;
  if (!email || auth.currentUser?.emailVerified === false) {
    throw new Error('Cần đăng nhập Google bằng email đã xác minh để chia sẻ Workspace.');
  }
  return normalizeEmail(email);
}

function isWorkspaceRole(value: unknown): value is WorkspaceAccessRole {
  return value === 'EDITOR' || value === 'VIEWER';
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
      throw new Error('ID family.json trên Drive khác với đăng ký Workspace hiện có.');
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
  members: Array<{ email: string; role: WorkspaceAccessRole }>,
): Promise<void> {
  const cleanAdminEmail = normalizeEmail(adminEmail);
  if (authenticatedEmail() !== cleanAdminEmail) {
    throw new Error('Chỉ Admin đã đăng nhập mới được chia sẻ Workspace.');
  }
  await registerHealthWorkspaceRelay(rootFolderId, familyFileId, cleanAdminEmail);

  const uniqueMembers = new Map<string, WorkspaceAccessRole>();
  for (const member of members) {
    const email = normalizeEmail(member.email);
    if (!email || email === cleanAdminEmail || !isWorkspaceRole(member.role)) {
      throw new Error('Danh sách thành viên chia sẻ có email hoặc quyền không hợp lệ.');
    }
    uniqueMembers.set(email, member.role);
  }
  if (uniqueMembers.size > 250) {
    throw new Error('Workspace vượt quá giới hạn 250 tài khoản được chia sẻ.');
  }

  const batch = writeBatch(db);
  for (const [memberEmail, role] of uniqueMembers) {
    const assignment: HealthWorkspaceAssignment = {
      rootFolderId,
      familyFileId,
      adminEmail: cleanAdminEmail,
      memberEmail,
      role,
      updatedAt: Date.now(),
    };
    batch.set(memberAssignmentRef(rootFolderId, memberEmail), assignment);
    batch.set(memberInviteRef(rootFolderId, memberEmail), assignment);
  }
  await batch.commit();
}

export async function readHealthWorkspaceAssignment(
  memberEmail: string,
): Promise<HealthWorkspaceAssignment | null> {
  const cleanEmail = normalizeEmail(memberEmail);
  if (!cleanEmail || authenticatedEmail() !== cleanEmail) {
    throw new Error('Tài khoản Firebase hiện tại không khớp email thành viên đang đăng nhập.');
  }

  const invites = await getDocs(collection(db, INVITE_COLLECTION, cleanEmail, 'workspaces'));
  const matchingAssignments: HealthWorkspaceAssignment[] = invites.docs.map((invite) => {
    const data = invite.data();
    if (
      data.rootFolderId !== invite.id ||
      typeof data.familyFileId !== 'string' ||
      !data.familyFileId ||
      typeof data.adminEmail !== 'string' ||
      normalizeEmail(data.adminEmail) !== data.adminEmail ||
      data.memberEmail !== cleanEmail ||
      !isWorkspaceRole(data.role) ||
      typeof data.updatedAt !== 'number'
    ) {
      throw new Error('Bản ghi chuyển tiếp Workspace trên Firestore không hợp lệ.');
    }
    return data as HealthWorkspaceAssignment;
  });
  if (matchingAssignments.length > 1) {
    throw new Error('Tài khoản này được mời vào nhiều Workspace. Hãy nhập Folder ID để chọn đúng gia đình.');
  }
  return matchingAssignments[0] || null;
}

export async function listHealthWorkspaceAssignments(
  rootFolderId: string,
): Promise<HealthWorkspaceAssignment[]> {
  const workspaceRef = doc(db, RELAY_COLLECTION, rootFolderId);
  const workspace = await getDoc(workspaceRef);
  const adminEmail = authenticatedEmail();
  if (!workspace.exists() || workspace.data().adminEmail !== adminEmail) {
    throw new Error('Chỉ Admin của Workspace mới được xem danh sách chia sẻ.');
  }

  const members = await getDocs(collection(workspaceRef, MEMBER_COLLECTION));
  return members.docs.map((snapshot) => {
    const data = snapshot.data();
    if (
      data.rootFolderId !== rootFolderId ||
      typeof data.familyFileId !== 'string' ||
      data.adminEmail !== adminEmail ||
      data.memberEmail !== snapshot.id ||
      !isWorkspaceRole(data.role) ||
      typeof data.updatedAt !== 'number'
    ) {
      throw new Error('Danh sách chia sẻ có bản ghi không hợp lệ.');
    }
    return data as HealthWorkspaceAssignment;
  });
}

export async function removeHealthWorkspaceAssignment(
  rootFolderId: string,
  memberEmail: string,
): Promise<void> {
  const cleanEmail = normalizeEmail(memberEmail);
  const currentEmail = authenticatedEmail();
  const workspace = await getDoc(doc(db, RELAY_COLLECTION, rootFolderId));
  if (!workspace.exists()) throw new Error('Không tìm thấy Workspace chia sẻ trên Firestore.');
  const isAdmin = workspace.data().adminEmail === currentEmail;
  if (!isAdmin && cleanEmail !== currentEmail) {
    throw new Error('Không có quyền thu hồi lời mời này.');
  }
  const batch = writeBatch(db);
  batch.delete(memberAssignmentRef(rootFolderId, cleanEmail));
  batch.delete(memberInviteRef(rootFolderId, cleanEmail));
  await batch.commit();
}
