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

const ACCESS_COLLECTION = 'workspaceAccess';
const LEGACY_FAMILIES_COLLECTION = 'families';
const LEGACY_USER_LINKS_COLLECTION = 'userFamilyLinks';
const LEGACY_INVITATIONS_COLLECTION = 'invitations';

export type WorkspaceAccessRole = 'ADMIN' | 'EDITOR' | 'VIEWER' | 'Owner' | 'Editor' | 'Viewer';

export interface HealthWorkspaceAssignment {
  rootFolderId: string;
  familyFileId: string;
  adminEmail: string;
  memberEmail: string;
  role: WorkspaceAccessRole;
  updatedAt: number;
  source?: 'family_member';
  migrationComplete?: boolean;
}

export interface HealthAssignedFolder {
  folderId: string;
  status: 'active';
  adminEmail: string;
  memberEmail: string;
  familyFileId: string;
  updatedAt: number;
}

interface WorkspaceAccessRecord {
  email: string;
  rootFolderId: string;
  familyFileId: string;
  adminEmail: string;
  adminUid: string;
  role: WorkspaceAccessRole;
  status: 'active' | 'unlinked' | 'revoked';
  schemaVersion: 2;
  updatedAt: number;
  createdAt?: number;
  migrationComplete?: boolean;
  source?: 'family_member';
}

interface LegacyFamilyRegistry {
  familyId: string;
  rootFolderId: string;
  familyFileId: string;
  adminEmail: string;
  adminUid: string;
  status: 'active' | 'unlinked';
  updatedAt: number;
}

interface LegacyInvitation {
  familyId: string;
  adminEmail: string;
  role: WorkspaceAccessRole;
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

function toAssignment(record: WorkspaceAccessRecord): HealthWorkspaceAssignment | null {
  if (record.status !== 'active') return null;
  if (!record.rootFolderId || !record.familyFileId || !record.adminEmail || !record.email) {
    throw new Error(`Bản ghi quyền truy cập của ${record.email || 'email không xác định'} thiếu thông tin Workspace.`);
  }
  return {
    rootFolderId: record.rootFolderId,
    familyFileId: record.familyFileId,
    adminEmail: normalizeEmail(record.adminEmail),
    memberEmail: normalizeEmail(record.email),
    role: normalizeRole(record.role),
    updatedAt: record.updatedAt,
    source: record.source,
    ...(record.migrationComplete !== undefined
      ? { migrationComplete: record.migrationComplete }
      : {}),
  };
}

function toAssignedFolder(assignment: HealthWorkspaceAssignment): HealthAssignedFolder {
  return {
    folderId: assignment.rootFolderId,
    status: 'active',
    adminEmail: assignment.adminEmail,
    memberEmail: assignment.memberEmail,
    familyFileId: assignment.familyFileId,
    updatedAt: assignment.updatedAt,
  };
}

async function readWorkspaceAccess(email: string): Promise<WorkspaceAccessRecord | null> {
  const snapshot = await getDoc(doc(db, ACCESS_COLLECTION, normalizeEmail(email)));
  return snapshot.exists() ? snapshot.data() as WorkspaceAccessRecord : null;
}

async function getLegacyFamilyById(familyId: string): Promise<LegacyFamilyRegistry | null> {
  const snapshot = await getDoc(doc(db, LEGACY_FAMILIES_COLLECTION, familyId));
  return snapshot.exists() ? snapshot.data() as LegacyFamilyRegistry : null;
}

async function readLegacyAssignedFolder(email: string): Promise<HealthAssignedFolder | null> {
  const cleanEmail = normalizeEmail(email);
  const uid = auth.currentUser?.uid;

  if (uid) {
    const links = await getDocs(query(
      collection(db, LEGACY_USER_LINKS_COLLECTION, uid, 'families'),
      where('status', '==', 'active'),
    ));
    for (const link of links.docs) {
      const familyId = String(link.data().familyId || link.id);
      const family = await getLegacyFamilyById(familyId);
      if (family?.status === 'active') {
        return {
          folderId: family.rootFolderId,
          status: 'active',
          adminEmail: normalizeEmail(family.adminEmail),
          memberEmail: cleanEmail,
          familyFileId: family.familyFileId,
          updatedAt: family.updatedAt,
        };
      }
    }
  }

  const invitationSnapshot = await getDoc(doc(db, LEGACY_INVITATIONS_COLLECTION, cleanEmail));
  if (!invitationSnapshot.exists()) return null;
  const invitation = invitationSnapshot.data() as LegacyInvitation;
  const family = await getLegacyFamilyById(invitation.familyId);
  if (!family || family.status !== 'active') return null;

  return {
    folderId: family.rootFolderId,
    status: 'active',
    adminEmail: normalizeEmail(family.adminEmail),
    memberEmail: cleanEmail,
    familyFileId: family.familyFileId,
    updatedAt: family.updatedAt,
  };
}

async function readLegacyWorkspaceAssignment(email: string): Promise<HealthWorkspaceAssignment | null> {
  const folder = await readLegacyAssignedFolder(email);
  if (!folder) return null;

  const cleanEmail = normalizeEmail(email);
  const invitationSnapshot = await getDoc(doc(db, LEGACY_INVITATIONS_COLLECTION, cleanEmail));
  const invitation = invitationSnapshot.exists()
    ? invitationSnapshot.data() as LegacyInvitation
    : null;
  const isAdmin = normalizeEmail(folder.adminEmail) === cleanEmail;

  return {
    rootFolderId: folder.folderId,
    familyFileId: folder.familyFileId,
    adminEmail: folder.adminEmail,
    memberEmail: cleanEmail,
    role: invitation ? normalizeRole(invitation.role) : isAdmin ? 'ADMIN' : 'EDITOR',
    updatedAt: folder.updatedAt,
    source: isAdmin || !invitation ? 'family_member' : undefined,
  };
}

/**
 * Register the Admin's email-keyed access record for direct, cross-device lookup.
 * The old collections are read-only fallbacks for workspaces not yet migrated.
 */
export async function registerHealthWorkspaceRelay(
  familyId: string,
  familyFileId: string,
  adminEmail: string,
): Promise<void> {
  const uid = authenticatedUid();
  const cleanEmail = normalizeEmail(adminEmail);
  if (cleanEmail !== authenticatedEmail()) {
    throw new Error('Email Admin không khớp với tài khoản Google đang đăng nhập.');
  }

  const accessRef = doc(db, ACCESS_COLLECTION, cleanEmail);
  const existingSnapshot = await getDoc(accessRef);
  const existing = existingSnapshot.exists()
    ? existingSnapshot.data() as WorkspaceAccessRecord
    : null;
  if (existing && existing.adminUid !== uid) {
    throw new Error('Email này đã được đăng ký bởi một Admin Workspace khác.');
  }

  const now = Date.now();
  const sameWorkspace = existing?.rootFolderId === familyId && existing.familyFileId === familyFileId;
  const record: WorkspaceAccessRecord = {
    email: cleanEmail,
    rootFolderId: familyId,
    familyFileId,
    adminEmail: cleanEmail,
    adminUid: uid,
    role: 'ADMIN',
    status: 'active',
    schemaVersion: 2,
    createdAt: sameWorkspace ? existing?.createdAt || now : now,
    updatedAt: now,
    migrationComplete: sameWorkspace && existing?.status === 'active' && existing.migrationComplete === true,
    source: 'family_member',
  };
  await setDoc(accessRef, record, { merge: true });
}

export async function publishHealthWorkspaceAssignments(
  familyId: string,
  familyFileId: string,
  adminEmail: string,
  members: Array<{
    email: string;
    role: WorkspaceAccessRole;
    source?: 'family_member';
  }>,
): Promise<void> {
  const adminUid = authenticatedUid();
  const cleanAdminEmail = normalizeEmail(adminEmail);
  if (cleanAdminEmail !== authenticatedEmail()) {
    throw new Error('Chỉ Admin đang đăng nhập mới được cập nhật danh sách thành viên.');
  }

  const adminRef = doc(db, ACCESS_COLLECTION, cleanAdminEmail);
  const adminSnapshot = await getDoc(adminRef);
  if (
    !adminSnapshot.exists() ||
    adminSnapshot.data()?.adminUid !== adminUid ||
    adminSnapshot.data()?.status !== 'active'
  ) {
    throw new Error('Workspace chưa có bản ghi Admin hợp lệ. Hãy đồng bộ lại Workspace trước.');
  }

  const now = Date.now();
  const batch = writeBatch(db);
  batch.set(adminRef, {
    rootFolderId: familyId,
    familyFileId,
    adminEmail: cleanAdminEmail,
    adminUid,
    role: 'ADMIN',
    status: 'active',
    schemaVersion: 2,
    updatedAt: now,
    migrationComplete: true,
  }, { merge: true });

  const normalizedMembers = members
    .map(member => ({ ...member, email: normalizeEmail(member.email) }))
    .filter(member => member.email && member.email !== cleanAdminEmail);
  for (const member of normalizedMembers) {
    batch.set(doc(db, ACCESS_COLLECTION, member.email), {
      email: member.email,
      rootFolderId: familyId,
      familyFileId,
      adminEmail: cleanAdminEmail,
      adminUid,
      role: normalizeRole(member.role),
      status: 'active',
      schemaVersion: 2,
      updatedAt: now,
      ...(member.source ? { source: member.source } : {}),
    }, { merge: true });
  }
  await batch.commit();
}

export async function readHealthAssignedFolder(email: string): Promise<HealthAssignedFolder | null> {
  const record = await readWorkspaceAccess(email);
  if (record) {
    const assignment = toAssignment(record);
    return assignment ? toAssignedFolder(assignment) : null;
  }
  return readLegacyAssignedFolder(email);
}

export async function readHealthWorkspaceAssignment(email: string): Promise<HealthWorkspaceAssignment | null> {
  const record = await readWorkspaceAccess(email);
  if (record) return toAssignment(record);
  return readLegacyWorkspaceAssignment(email);
}

export async function findAdminWorkspaceRelay(email: string): Promise<{ rootFolderId: string; familyFileId: string } | null> {
  const assignment = await readHealthWorkspaceAssignment(email);
  return assignment
    ? { rootFolderId: assignment.rootFolderId, familyFileId: assignment.familyFileId }
    : null;
}

export async function listHealthWorkspaceAssignments(familyId: string): Promise<HealthWorkspaceAssignment[]> {
  const uid = authenticatedUid();
  const accessSnapshot = await getDocs(query(
    collection(db, ACCESS_COLLECTION),
    where('adminUid', '==', uid),
  ));
  const records = new Map<string, HealthWorkspaceAssignment>();
  const activeAccessRecords = accessSnapshot.docs
    .map(snapshot => snapshot.data() as WorkspaceAccessRecord)
    .filter(record => record.status === 'active' && record.rootFolderId === familyId);
  for (const record of activeAccessRecords) {
    const assignment = toAssignment(record);
    if (assignment) records.set(assignment.memberEmail, assignment);
  }

  const adminRecord = activeAccessRecords.find(record =>
    record.email === normalizeEmail(record.adminEmail) && record.role === 'ADMIN',
  );
  if (adminRecord?.migrationComplete) return [...records.values()];

  const legacyInvitations = await getDocs(query(
    collection(db, LEGACY_INVITATIONS_COLLECTION),
    where('familyId', '==', familyId),
  ));
  for (const snapshot of legacyInvitations.docs) {
    const invitation = snapshot.data() as LegacyInvitation;
    const email = normalizeEmail(snapshot.id);
    if (!email || records.has(email) || email === normalizeEmail(invitation.adminEmail)) continue;
    records.set(email, {
      rootFolderId: familyId,
      familyFileId: '',
      adminEmail: normalizeEmail(invitation.adminEmail),
      memberEmail: email,
      role: normalizeRole(invitation.role),
      updatedAt: invitation.updatedAt || 0,
    });
  }
  return [...records.values()];
}

async function assertWorkspaceAdmin(familyId: string): Promise<void> {
  const uid = authenticatedUid();
  const adminEmail = authenticatedEmail();
  const adminRecord = await readWorkspaceAccess(adminEmail);
  if (
    adminRecord &&
    adminRecord.adminUid === uid &&
    adminRecord.rootFolderId === familyId &&
    adminRecord.role === 'ADMIN'
  ) return;

  const legacyFamily = await getLegacyFamilyById(familyId);
  if (legacyFamily?.adminUid === uid) return;
  throw new Error('Chỉ Admin của Workspace mới được thay đổi quyền truy cập.');
}

export async function removeHealthWorkspaceAssignment(familyId: string, memberEmail: string): Promise<void> {
  await assertWorkspaceAdmin(familyId);
  const cleanEmail = normalizeEmail(memberEmail);
  if (cleanEmail === authenticatedEmail()) {
    throw new Error('Không thể thu hồi quyền của Admin đang quản lý Workspace.');
  }

  const ownedAccessRecords = await getDocs(query(
    collection(db, ACCESS_COLLECTION),
    where('adminUid', '==', authenticatedUid()),
  ));
  const accessRecord = ownedAccessRecords.docs.find(snapshot => {
    const data = snapshot.data() as WorkspaceAccessRecord;
    return data.email === cleanEmail && data.rootFolderId === familyId;
  });
  const batch = writeBatch(db);
  if (accessRecord) batch.delete(accessRecord.ref);
  batch.delete(doc(db, LEGACY_INVITATIONS_COLLECTION, cleanEmail));
  await batch.commit();
}

export async function unregisterHealthWorkspace(familyId: string): Promise<void> {
  await assertWorkspaceAdmin(familyId);
  const uid = authenticatedUid();
  const accessSnapshot = await getDocs(query(
    collection(db, ACCESS_COLLECTION),
    where('adminUid', '==', uid),
  ));
  const batch = writeBatch(db);
  const now = Date.now();
  for (const snapshot of accessSnapshot.docs) {
    const record = snapshot.data() as WorkspaceAccessRecord;
    if (record.rootFolderId === familyId) {
      batch.update(snapshot.ref, { status: 'unlinked', updatedAt: now });
    }
  }

  const legacyInvitations = await getDocs(query(
    collection(db, LEGACY_INVITATIONS_COLLECTION),
    where('familyId', '==', familyId),
  ));
  for (const invitation of legacyInvitations.docs) batch.delete(invitation.ref);
  await batch.commit();
}

export function subscribeHealthWorkspaceAssignments(
  email: string,
  onAssignmentChange: (assignment: HealthWorkspaceAssignment | null) => void,
  onError?: (error: Error) => void,
): () => void {
  const cleanEmail = normalizeEmail(email);
  const accessRef = doc(db, ACCESS_COLLECTION, cleanEmail);
  const legacyInviteRef = doc(db, LEGACY_INVITATIONS_COLLECTION, cleanEmail);
  let hasCurrentRecord = false;
  let disposed = false;

  const reportError = (error: unknown) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    console.error('[WorkspaceAccess] Subscription error:', normalizedError);
    onError?.(normalizedError);
  };

  const unsubscribeAccess = onSnapshot(accessRef, snapshot => {
    hasCurrentRecord = snapshot.exists();
    if (snapshot.exists()) {
      try {
        onAssignmentChange(toAssignment(snapshot.data() as WorkspaceAccessRecord));
      } catch (error) {
        reportError(error);
      }
      return;
    }
    void readLegacyWorkspaceAssignment(cleanEmail)
      .then(assignment => {
        if (!disposed && !hasCurrentRecord) onAssignmentChange(assignment);
      })
      .catch(reportError);
  }, reportError);

  const unsubscribeLegacy = onSnapshot(legacyInviteRef, snapshot => {
    if (hasCurrentRecord) return;
    if (!snapshot.exists()) {
      onAssignmentChange(null);
      return;
    }
    void readLegacyWorkspaceAssignment(cleanEmail)
      .then(assignment => {
        if (!disposed && !hasCurrentRecord) onAssignmentChange(assignment);
      })
      .catch(reportError);
  }, reportError);

  return () => {
    disposed = true;
    unsubscribeAccess();
    unsubscribeLegacy();
  };
}
