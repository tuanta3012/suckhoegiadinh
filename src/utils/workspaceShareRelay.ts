import { getApps, getApp, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { deleteDoc, doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { WorkspaceMember } from '../types';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const databaseId = firebaseConfig.firestoreDatabaseId;
const db = (!databaseId || databaseId === '(default)') ? getFirestore(app) : getFirestore(app, databaseId);
const COLLECTION = 'assigned_shares';

export interface AssignedWorkspaceFile {
  assignedFileId: string;
  assignedFileName: string;
  adminEmail: string;
  memberEmail: string;
  role: 'EDITOR' | 'VIEWER';
  status: 'active';
  updatedAt: number;
}

export function workspaceRelayDocumentId(email: string): string {
  return email.trim().toLowerCase();
}

async function getAuthenticatedEmail(): Promise<string> {
  if (auth.currentUser?.email) {
    return auth.currentUser.email.trim().toLowerCase();
  }
  try {
    if (typeof (auth as any).authStateReady === 'function') {
      await (auth as any).authStateReady();
    }
  } catch {
    // ignore
  }
  const email = auth.currentUser?.email?.trim().toLowerCase();
  if (!email) {
    throw new Error('Cần phiên Firebase đã xác thực để dùng chuyển tiếp liên kết Workspace.');
  }
  return email;
}

export async function publishWorkspaceFileToMembers(
  fileId: string,
  fileName: string,
  adminEmail: string,
  members: WorkspaceMember[]
): Promise<void> {
  const cleanAdminEmail = adminEmail.trim().toLowerCase();
  if (!fileId || !cleanAdminEmail) {
    throw new Error('Thiếu file ID hoặc email Admin để phát hành chuyển tiếp liên kết.');
  }
  const authedEmail = await getAuthenticatedEmail();
  if (authedEmail !== cleanAdminEmail) {
    throw new Error('Chỉ Admin đã đăng nhập mới được phát hành chuyển tiếp liên kết.');
  }

  const recipients = members.filter((member) => {
    const email = member.email?.trim().toLowerCase();
    return (
      Boolean(email) &&
      email !== cleanAdminEmail &&
      ['EDITOR', 'VIEWER'].includes(String(member.role).toUpperCase())
    );
  });

  await Promise.all(
    recipients.map((member) => {
      const memberEmail = member.email.trim().toLowerCase();
      const role = String(member.role).toUpperCase() as AssignedWorkspaceFile['role'];
      const record: AssignedWorkspaceFile = {
        assignedFileId: fileId,
        assignedFileName: fileName.trim() || 'Sổ tiết kiệm',
        adminEmail: cleanAdminEmail,
        memberEmail,
        role,
        status: 'active',
        updatedAt: Date.now(),
      };
      return setDoc(doc(db, COLLECTION, workspaceRelayDocumentId(memberEmail)), record);
    })
  );
}

export async function readWorkspaceFileAssignment(
  memberEmail: string
): Promise<AssignedWorkspaceFile | null> {
  const cleanEmail = memberEmail.trim().toLowerCase();
  if (!cleanEmail) return null;
  const authedEmail = await getAuthenticatedEmail();
  if (authedEmail !== cleanEmail) {
    throw new Error('Tài khoản Firebase hiện tại không khớp email thành viên đang đăng nhập.');
  }

  const snapshot = await getDoc(doc(db, COLLECTION, workspaceRelayDocumentId(cleanEmail)));
  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (
    typeof data.assignedFileId !== 'string' ||
    !data.assignedFileId.trim() ||
    typeof data.adminEmail !== 'string' ||
    data.adminEmail.trim().toLowerCase() !== data.adminEmail ||
    data.memberEmail !== cleanEmail ||
    data.status !== 'active' ||
    !['EDITOR', 'VIEWER'].includes(String(data.role).toUpperCase())
  ) {
    throw new Error('Bản ghi chuyển tiếp Workspace trên Firestore không hợp lệ.');
  }

  return {
    assignedFileId: data.assignedFileId,
    assignedFileName:
      typeof data.assignedFileName === 'string' ? data.assignedFileName : 'Sổ tiết kiệm',
    adminEmail: data.adminEmail,
    memberEmail: data.memberEmail,
    role: String(data.role).toUpperCase() as AssignedWorkspaceFile['role'],
    status: 'active',
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
  };
}

export async function removeWorkspaceFileAssignment(memberEmail: string): Promise<void> {
  const cleanEmail = memberEmail.trim().toLowerCase();
  if (!cleanEmail) return;

  await deleteDoc(doc(db, COLLECTION, workspaceRelayDocumentId(cleanEmail)));
}
