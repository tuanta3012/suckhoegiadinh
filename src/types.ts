/**
 * Types and interfaces for Family Health Manager
 */

export interface FamilyMember {
  id: string;
  name: string;
  gender?: 'male' | 'female' | 'other';
  birthDate?: string;
  role?: 'father' | 'mother' | 'child' | 'other' | string;
  driveFolderId: string;
  profileFileId: string;
  avatarUrl?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface HealthMetric {
  name: string;
  value: number;
  unit: string;
}

export interface Medication {
  name: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
}

export interface HealthEvent {
  id: string;
  sourceFileId: string;
  sourceFileName: string;
  type: 'medical_report' | 'prescription' | 'test_result' | 'vaccination' | 'discharge' | 'other';
  title: string;
  date: string;
  facility?: string;
  diagnoses: string[];
  medications: Medication[];
  metrics: HealthMetric[];
  advice?: string;
  nextFollowUp?: string;
  notes?: string;
  patientName?: string;
  patientBirthDate?: string;
  patientGender?: 'male' | 'female' | 'other' | string;
  extractedData?: Record<string, JsonValue>;
  recordedAt: string;
}

export interface HealthSource {
  driveFileId: string;
  fileName: string;
  mimeType: string;
  uploadedAt: string;
  status: 'pending' | 'processed';
  digitizedAt?: string;
  rawDeletedAt?: string;
  fileSize?: number;
  fileHash?: string;
}

export interface HealthSummary {
  latestEventDate?: string;
  latestDiagnoses: string[];
  latestMetrics: Record<string, HealthMetric & { date: string }>;
  nextFollowUp?: string;
  narrative?: string;
}

export interface HealthProfile {
  schemaVersion: 1;
  member: FamilyMember;
  timeline: HealthEvent[];
  sources: HealthSource[];
  summary: HealthSummary;
  createdAt: string;
  updatedAt: string;
}

export interface HealthFamily {
  schemaVersion: 1;
  adminEmail?: string;
  rawFilesFolderId: string;
  profilesFolderId: string;
  members: FamilyMember[];
  createdAt: string;
  updatedAt: string;
}

export type UserRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

export interface WorkspaceMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  addedAt: string;
}

export interface AppSettings {
  sharedFolderId?: string;
  members?: FamilyMember[];
  notificationsEnabled?: boolean;
  enableBiometricLogin?: boolean;
}

export function canEditData(role?: string | null): boolean {
  return role === 'ADMIN' || role === 'EDITOR';
}
export interface AuthUser {
  email: string;
  name: string;
  photoURL?: string;
  role: UserRole;
  title: string;
  isOffline?: boolean;
}
