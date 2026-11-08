/**
 * Types and interfaces for Family Health Manager
 */

export interface FamilyMember {
  id: string;
  name: string;
  email?: string;
  gender?: 'male' | 'female' | 'other';
  birthDate?: string;
  role?: 'father' | 'mother' | 'child' | 'other' | string;
  driveFolderId: string;
  profileFileId: string;
  avatarUrl?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface PhysicalExam {
  height_cm?: number;
  weight_kg?: number;
  bmi?: number;
  bp_mmHg?: string;
  pulse_bpm?: number;
  classification?: string;
}

export interface HealthMetric {
  name: string;
  standardKey?: string;
  value: number | string;
  unit: string;
  refRange?: string;
  status?: 'normal' | 'optimal' | 'warning_high' | 'warning_low' | 'critical_high' | 'critical_low' | string;
}

export interface Medication {
  name: string;
  dosage?: string;
  quantity?: string;
  frequency?: string;
  timing?: string;
  duration?: string;
  instructions?: string;
}

export interface ImagingResult {
  modality: string;
  findings: string;
  conclusion: string;
}

export interface VaccinationRecord {
  vaccineName: string;
  targetDisease?: string;
  doseNumber?: string | number;
  lotNumber?: string;
  manufacturer?: string;
  injectionSite?: string;
  administeredDate: string;
  nextDoseDate?: string | null;
  reactionNotes?: string;
}

export interface HospitalizationRecord {
  admissionDate?: string;
  dischargeDate?: string;
  department?: string;
  treatmentSummary?: string;
  surgicalNotes?: string;
}

export interface HealthEvent {
  id: string;
  sourceFileId: string;
  sourceFileName: string;
  type: 'medical_report' | 'prescription' | 'test_result' | 'vaccination' | 'discharge' | 'comprehensive_exam' | 'other';
  title: string;
  date: string;
  facility?: string;
  doctorName?: string;
  customCategory?: string;
  physicalExam?: PhysicalExam;
  diagnoses: string[];
  medications: Medication[];
  metrics: HealthMetric[];
  imagingResults?: ImagingResult[];
  vaccinations?: VaccinationRecord[];
  hospitalization?: HospitalizationRecord;
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
  subjectStatus?: 'unresolved';
  digitizedAt?: string;
  rawDeletedAt?: string;
  relocatedToMemberId?: string;
  fileSize?: number;
  fileHash?: string;
  totalPages?: number;
  processedPages?: number;
}

export interface HealthSummary {
  latestEventDate?: string;
  latestDiagnoses: string[];
  latestMetrics: Record<string, HealthMetric & { date: string }>;
  nextFollowUp?: string;
  narrative?: string;
}

export interface MedicalHistory {
  surgeries: Array<{
    procedure: string;
    year?: string;
    hospital?: string;
    notes?: string;
  }>;
  chronicConditions: Array<{
    condition: string;
    diagnosedYear?: string;
    status?: 'stable_benign' | 'monitored' | 'progressing' | 'resolved' | string;
    details?: string;
  }>;
}

export interface CrossParameterCorrelation {
  parameters: string[];
  findings: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface VelocityTrendItem {
  metricName: string;
  trendDirection: 'increasing' | 'decreasing' | 'stable' | 'fluctuating';
  velocityDescription: string;
  riskProjection: string;
}

export interface ChronicDiseaseSurveillanceItem {
  conditionName: string;
  status: 'stable_benign' | 'monitored' | 'progressing' | 'resolved';
  comparisonOverTime: string;
  recommendation: string;
}

export interface ActionableHealthRoadmap {
  criticalAlerts: string[];
  specialistReferrals: Array<{
    specialty: string;
    reason: string;
  }>;
  timeBoundPlan: {
    next3Months: string[];
    next6Months: string[];
    next12Months: string[];
  };
}

export interface AiDeepAnalysisResult {
  analyzedAt: string;
  healthScore: number;
  overallAssessment: string;
  crossCorrelations: CrossParameterCorrelation[];
  velocityTrends: VelocityTrendItem[];
  chronicSurveillance: ChronicDiseaseSurveillanceItem[];
  roadmap: ActionableHealthRoadmap;
}

export interface AiAnalysisBlock {
  lastAnalyzedDate?: string;
  overviewSummary?: string;
  criticalAlerts?: string[];
  chronicConditionsTracking?: string[];
  actionRoadmap?: {
    specialistConsultation?: string[];
    dietaryModifications?: string[];
    followUpSchedule?: string;
  };
}

export interface HealthProfile {
  schemaVersion: 1 | 2;
  member: FamilyMember;
  medicalHistory?: MedicalHistory;
  timeline: HealthEvent[];
  sources: HealthSource[];
  summary: HealthSummary;
  aiDeepAnalysis?: AiDeepAnalysisResult;
  aiAnalysis?: AiAnalysisBlock;
  createdAt: string;
  updatedAt: string;
  syncPending?: boolean;
}

export interface HealthFamily {
  schemaVersion: 1;
  adminEmail?: string;
  rawFilesFolderId: string;
  profilesFolderId: string;
  members: FamilyMember[];
  deletedMembers?: Array<{
    memberId: string;
    deletedAt: string;
    deletedBy?: string;
  }>;
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
