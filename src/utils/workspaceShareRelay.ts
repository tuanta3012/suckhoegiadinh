import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  deleteDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { getSignedInGoogleEmail } from './googleDriveService';
import { firestoreAuth as auth, firestoreDb as db } from './firebaseFirestore';

const FAMILIES_COLLECTION = 'families';
const USER_LINKS_COLLECTION = 'userFamilyLinks';
const INVITATIONS_COLLECTION = 'invitations';

export type WorkspaceAccessRole = 'ADMIN' | 'EDITOR' | 'VIEWER' | 'Owner' | 'Editor' | 'Viewer';

export interface HealthFamilyRegistry {
  familyId: string;
  rootFolderId: string;
  familyFileId: string;
  profilesFolderId?: string;
  rawFilesFolderId?: string;
  adminEmail: string;
  adminUid: string;
  status: 'active' | 'unlinked';
  schemaVersion: number;
  updatedAt: number;
  createdAt: number;
}

export interface HealthFamilyMember {
  memberId: string;
  uid?: string;
  email: string;
  role: WorkspaceAccessRole;
  status: 'active' | 'revoked';
  profileFileId?: string;
  rawFolderId?: string;
  updatedAt: number;
}

export interface UserFamilyLink {
  familyId: string;
  status: 'active' | 'unlinked';
  updatedAt: number;
}

export interface Invitation {
  familyId: string;
  adminEmail: string;
  role: WorkspaceAccessRole;
  updatedAt: number;
}

// For compatibility with old code
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
    throw new Error('Cần đăng nhập Google để thực hiện thao tác này.');
  }
  return normalizeEmail(email);
}

function authenticatedUid(): string {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Cần xác thực Firebase để thực hiện thao tác này.');
  }
  return uid;
}

function normalizeRole(value: unknown): WorkspaceAccessRole {
  if (value === 'ADMIN' || value === 'Admin' || value === 'Owner') return 'ADMIN';
  if (value === 'VIEWER' || value === 'Viewer') return 'VIEWER';
  return 'EDITOR';
}

/**
 * Đăng ký thông tin gia đình lên Firestore (Registry)
 */
export async function registerHealthWorkspaceRelay(
  familyId: string,
  familyFileId: string,
  adminEmail: string,
  extra?: { profilesFolderId?: string; rawFilesFolderId?: string },
): Promise<void> {
  const uid = authenticatedUid();
  const cleanEmail = normalizeEmail(adminEmail);
  const now = Date.now();

  const familyRef = doc(db, FAMILIES_COLLECTION, familyId);
  const familyData: HealthFamilyRegistry = {
    familyId,
    rootFolderId: familyId,
    familyFileId,
    profilesFolderId: extra?.profilesFolderId,
    rawFilesFolderId: extra?.rawFilesFolderId,
    adminEmail: cleanEmail,
    adminUid: uid,
    status: 'active',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };

  const batch = writeBatch(db);
  batch.set(familyRef, familyData, { merge: true });

  const memberRef = doc(db, FAMILIES_COLLECTION, familyId, 'members', uid);
  const memberData: HealthFamilyMember = {
    memberId: 'admin_member',
    uid,
    email: cleanEmail,
    role: 'ADMIN',
    status: 'active',
    updatedAt: now,
  };
  batch.set(memberRef, memberData, { merge: true });

  const linkRef = doc(db, USER_LINKS_COLLECTION, uid, 'families', familyId);
  const linkData: UserFamilyLink = {
    familyId,
    status: 'active',
    updatedAt: now,
  };
  batch.set(linkRef, linkData, { merge: true });

  await batch.commit();
}

export async function publishHealthWorkspaceAssignments(
  familyId: string,
  familyFileId: string,
  adminEmail: string,
  members: Array<{
    email: string;
    role: WorkspaceAccessRole;
    memberId: string;
    profileFileId?: string;
    rawFolderId?: string;
  }>,
): Promise<void> {
  const adminUid = authenticatedUid();
  const now = Date.now();

  const familySnap = await getDoc(doc(db, FAMILIES_COLLECTION, familyId));
  if (familySnap.exists() && familySnap.data()?.adminUid !== adminUid) {
    throw new Error('Chỉ Admin mới có quyền cập nhật danh sách thành viên.');
  }

  const batch = writeBatch(db);
  for (const member of members) {
    const cleanEmail = normalizeEmail(member.email);
    if (cleanEmail === normalizeEmail(adminEmail)) continue;

    const inviteRef = doc(db, INVITATIONS_COLLECTION, cleanEmail);
    const inviteData: Invitation = {
      familyId,
      adminEmail: normalizeEmail(adminEmail),
      role: normalizeRole(member.role),
      updatedAt: now,
    };
    batch.set(inviteRef, inviteData, { merge: true });
  }
  await batch.commit();
}

async function getFamilyById(familyId: string): Promise<HealthFamilyRegistry | null> {
  const snap = await getDoc(doc(db, FAMILIES_COLLECTION, familyId));
  return snap.exists() ? (snap.data() as HealthFamilyRegistry) : null;
}

export async function readHealthAssignedFolder(email: string): Promise<HealthAssignedFolder | null> {
  const cleanEmail = normalizeEmail(email);
  const uid = auth.currentUser?.uid;
  
  if (uid) {
    const q = query(collection(db, USER_LINKS_COLLECTION, uid, 'families'), where('status', '==', 'active'));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const familyId = snap.docs[0].data().familyId;
      const family = await getFamilyById(familyId);
      if (family) {
        return {
          folderId: family.rootFolderId,
          status: 'active',
          adminEmail: family.adminEmail,
          memberEmail: cleanEmail,
          familyFileId: family.familyFileId,
          updatedAt: family.updatedAt,
        };
      }
    }
  }

  const inviteSnap = await getDoc(doc(db, INVITATIONS_COLLECTION, cleanEmail));
  if (inviteSnap.exists()) {
    const invite = inviteSnap.data() as Invitation;
    const family = await getFamilyById(invite.familyId);
    if (family) {
      return {
        folderId: family.rootFolderId,
        status: 'active',
        adminEmail: family.adminEmail,
        memberEmail: cleanEmail,
        familyFileId: family.familyFileId,
        updatedAt: family.updatedAt,
      };
    }
  }
  return null;
}

export async function readHealthWorkspaceAssignment(email: string): Promise<HealthWorkspaceAssignment | null> {
  const folder = await readHealthAssignedFolder(email);
  if (!folder) return null;

  const inviteSnap = await getDoc(doc(db, INVITATIONS_COLLECTION, normalizeEmail(email)));
  const role = inviteSnap.exists() ? normalizeRole(inviteSnap.data().role) : 'EDITOR';

  return {
    rootFolderId: folder.folderId,
    familyFileId: folder.familyFileId,
    adminEmail: folder.adminEmail,
    memberEmail: folder.memberEmail,
    role,
    updatedAt: folder.updatedAt,
    source: 'family_member',
  };
}

export async function findAdminWorkspaceRelay(email: string): Promise<{ rootFolderId: string; familyFileId: string } | null> {
  const folder = await readHealthAssignedFolder(email);
  if (folder) return { rootFolderId: folder.folderId, familyFileId: folder.familyFileId };
  return null;
}

export async function listHealthWorkspaceAssignments(familyId: string): Promise<HealthWorkspaceAssignment[]> {
  try {
    const q = collection(db, FAMILIES_COLLECTION, familyId, 'members');
    const snapshot = await getDocs(q);
    const familySnap = await getDoc(doc(db, FAMILIES_COLLECTION, familyId));
    if (!familySnap.exists()) return [];
    
    const family = familySnap.data() as HealthFamilyRegistry;

    return snapshot.docs.map(d => {
      const m = d.data() as HealthFamilyMember;
      return {
        rootFolderId: family.rootFolderId,
        familyFileId: family.familyFileId,
        adminEmail: family.adminEmail,
        memberEmail: m.email,
        role: normalizeRole(m.role),
        updatedAt: m.updatedAt,
        source: 'family_member',
      };
    });
  } catch (error) {
    console.warn('[WorkspaceRelay] Lỗi khi liệt kê thành viên:', error);
    return [];
  }
}

export async function removeHealthWorkspaceAssignment(familyId: string, memberEmail: string): Promise<void> {
  const adminUid = authenticatedUid();
  const familySnap = await getDoc(doc(db, FAMILIES_COLLECTION, familyId));
  if (familySnap.exists() && familySnap.data()?.adminUid !== adminUid) {
    throw new Error('Chỉ Admin mới có quyền thu hồi lời mời.');
  }

  const cleanEmail = normalizeEmail(memberEmail);
  const batch = writeBatch(db);
  batch.delete(doc(db, INVITATIONS_COLLECTION, cleanEmail));
  
  // Also try to find member in subcollection
  const q = query(collection(db, FAMILIES_COLLECTION, familyId, 'members'), where('email', '==', cleanEmail));
  const snap = await getDocs(q);
  snap.forEach(d => {
    batch.delete(d.ref);
    // Also unlink the user
    const memberUid = d.id;
    batch.set(doc(db, USER_LINKS_COLLECTION, memberUid, 'families', familyId), { status: 'unlinked', updatedAt: Date.now() }, { merge: true });
  });

  await batch.commit();
}

export async function unregisterHealthWorkspace(familyId: string): Promise<void> {
  const uid = authenticatedUid();
  const familySnap = await getDoc(doc(db, FAMILIES_COLLECTION, familyId));
  if (familySnap.exists() && familySnap.data()?.adminUid !== uid) {
    throw new Error('Chỉ Admin mới có quyền hủy đăng ký kho dữ liệu.');
  }

  const batch = writeBatch(db);
  batch.update(doc(db, FAMILIES_COLLECTION, familyId), { status: 'unlinked', updatedAt: Date.now() });
  batch.update(doc(db, USER_LINKS_COLLECTION, uid, 'families', familyId), { status: 'unlinked', updatedAt: Date.now() });
  await batch.commit();
}

export function subscribeHealthWorkspaceAssignments(
  email: string,
  onAssignmentChange: (assignment: HealthWorkspaceAssignment | null) => void,
  _onError?: (error: Error) => void,
): () => void {
  const cleanEmail = normalizeEmail(email);
  const inviteRef = doc(db, INVITATIONS_COLLECTION, cleanEmail);
  
  return onSnapshot(inviteRef, async (snap) => {
    if (!snap.exists()) {
      onAssignmentChange(null);
      return;
    }
    const invite = snap.data() as Invitation;
    const assignment = await readHealthWorkspaceAssignment(cleanEmail);
    onAssignmentChange(assignment);
  }, (err) => {
    console.error('[WorkspaceRelay] Subscription error:', err);
  });
}
