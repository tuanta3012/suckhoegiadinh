/**
 * Types and interfaces for Family Health Manager
 */

export interface FamilyMember {
  id: string;
  name: string;
  role: 'father' | 'mother' | 'child' | 'other';
  driveFolderId: string; // ID of the personal folder in Shared Drive
  avatarUrl?: string;
  birthDate?: string; // YYYY-MM-DD
}

export interface HealthRecord {
  id: string;
  memberId: string; // Links to FamilyMember
  type: 'medical_report' | 'prescription' | 'test_result' | 'other';
  title: string;
  date: string; // Document date (YYYY-MM-DD)
  driveFileId: string;
  driveFileUrl: string;
  tags?: string[];
  summary?: string; // AI generated summary
  createdAt: string;
  updatedAt: string;
}

export type UserRole = 'ADMIN' | 'VIEWER';

export interface WorkspaceMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  addedAt: string;
}

export interface AppSettings {
  sharedFolderId?: string; // ID of the "Suc khoe gia dinh" folder
  members?: FamilyMember[];
  notificationsEnabled?: boolean;
  enableBiometricLogin?: boolean;
}

export function canEditData(role?: string | null): boolean {
  return true;
}
export interface AuthUser {
  email: string;
  name: string;
  photoURL?: string;
  role: UserRole;
  title: string;
  isOffline?: boolean;
}
