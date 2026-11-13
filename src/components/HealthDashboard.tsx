import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bot,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cloud,
  Copy,
  ExternalLink,
  FileHeart,
  FileStack,
  Download,
  FileText,
  FileUp,
  FolderHeart,
  FolderSync,
  Heart,
  HeartPulse,
  History,
  Info,
  LayoutGrid,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Mail,
  MessageSquare,
  MoreVertical,
  Pencil,
  Pill,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Trash2,
  User,
  UserPlus,
  Users,
  ChevronRight,
  X,
} from 'lucide-react';
import { App as CapacitorApp } from '@capacitor/app';
import { CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { Camera as CapacitorCamera } from '@capacitor/camera';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppUpdateModal } from './AppUpdateModal';
import { AiResourcesModal } from './AiResourcesModal';
import { useAppUpdate } from '../hooks/useAppUpdate';
import { AppLogo } from './AppLogo';
import { AiDeepAnalysisCard } from './AiDeepAnalysisCard';
import { MemberEditModal, type EditableFamilyMember } from './MemberEditModal';
import { UnresolvedSubjectModal } from './UnresolvedSubjectModal';
const HealthMetricsChart = lazy(() => import('./HealthMetricsChart'));
import type {
  FamilyMember,
  HealthEvent,
  HealthProfile,
  HealthSource,
  JsonValue,
} from '../types';
import {
  addDriveFamilyMember,
  cleanupDuplicateRawFilesOnDrive,
  cleanupExpiredRawFiles,
  clearWorkspaceCache,
  createHealthWorkspace,
  deleteDriveFamilyMember,
  deleteHealthWorkspaceFolder,
  downloadDriveFile,
  ensureDriveFolderAccess,
  flushPendingHealthProfileSaves,
  factoryResetWorkspaceFolder,
  findExistingHealthWorkspace,
  loadSharedAiResources,
  syncHealthWorkspaceMemberAssignments,
  WorkspaceSharingSyncError,
  type HealthDriveWorkspace,
  openAssignedHealthWorkspace,
  openHealthWorkspace,
  loadHealthProfile,
  moveDriveFileToMember,
  recreateDriveMemberProfile,
  revokeDriveFolderAccess,
  saveHealthProfile,
  trashDriveFile,
  restoreTrashedDriveFile,
  updateDriveFamilyMember,
  uploadRawHealthFile,
  type DriveFile,
} from '../utils/healthDriveService';
import { getSignedInGoogleEmail } from '../utils/googleDriveService';
import {
  deleteLocalSource,
  fileFromLocalSource,
  fileFromPendingUpload,
  localSyncOutbox,
  supportsDurableOfflineQueue,
  type PendingProfileSave,
  type PendingUpload,
} from '../utils/localSyncOutbox';
import {
  completeMemberDeletion,
  queueMemberDeletion,
  readPendingMemberDeletions,
} from '../utils/pendingMemberDeletions';
import {
  getWorkspaceMemberRole,
  findMemberForEmail,
  isMemberForEmail,
  prioritizeMemberForEmail,
} from '../utils/memberOrdering';
import { getGoogleAccessToken, getValidGoogleAccessToken } from '../utils/googleDriveService';
import {
  cleanHospitalizationRecord,
  hasMeaningfulHospitalization,
  HEALTH_EVENT_TYPES,
} from '../utils/healthEventType';
import {
  addHealthSource,
  createHealthProfile,
  digitizeHealthSource,
  mergeHealthProfiles,
  parseHealthProfile,
  summarizeTimeline,
} from '../utils/healthProfile';
import {
  buildHealthMetricChartData,
  getHealthMetricDisplayName,
  getHealthMetricInfo,
  getHealthMetricRangeStatus,
  getHealthMetricStandardKey,
  partitionHealthMetricsForDisplay,
} from '../utils/healthMetricService';
import {
  analyzeComprehensiveHealth,
  extractHealthEvent,
  extractHealthEventWithProgress,
  refineAndOrganizeMemberData,
  streamHealthAssistant,
  summarizeHealthProfile,
  type ExtractionProgressUpdate,
} from '../utils/geminiService';
import type { HealthAssistantCitation } from '../utils/healthAssistantContext';
import { DigitizationProgressTrackerModal, type TrackerStep } from './DigitizationProgressTrackerModal';
import { getPdfPageCount } from '../utils/pdfPageBatches';
import { RawFilesManagerModal } from './RawFilesManagerModal';
import { WorkspaceAuditModal } from './WorkspaceAuditModal';
import {
  computeFileFingerprint,
  compareStructuredEventContainment,
  consolidateTimelineEvents,
  detectDuplicateFile,
  detectCrossMemberDuplicateFile,
  detectDuplicateEvent,
  cleanAndDeduplicateEventData,
  mergeHealthEvents,
  type FileDuplicateMatch,
  type EventDuplicateMatch,
} from '../utils/deduplicationService';
import { compareDocumentContainment, createDocumentContentIndex } from '../utils/documentContainment';
import {
  readOcrRecoveryJobs,
  removeOcrRecoveryJob,
  upsertOcrRecoveryJob,
  type OcrRecoveryJob,
} from '../utils/ocrRecoveryStorage';
import {
  parseRobustJson,
  sleep,
  sanitizeMetricName,
} from '../utils/healthRecordService';
import {
  listHealthWorkspaceAssignments,
  publishHealthWorkspaceAssignments,
  readHealthWorkspaceAssignment,
  removeHealthWorkspaceAssignment,
  subscribeHealthWorkspaceAssignments,
  unregisterHealthWorkspace,
  type HealthWorkspaceAssignment,
  type WorkspaceAccessRole,
} from '../utils/workspaceShareRelay';
import { useConfirmDialog } from '../context/ConfirmDialogContext';
import { digitizationLogger } from '../utils/digitizationLogger';
import { setSharedGeminiKeys, trackSharedGeminiKeysLoad } from '../utils/geminiSharedResources';
import { clearLegacyHealthDemoData } from '../utils/legacyHealthDemo';
import { compressImageIfNeeded } from '../utils/imageCompressor';
import { compressPdfIfNeeded } from '../utils/pdfCompressor';
import { auth } from '../utils/googleDriveService';
import { formatDateVN, formatDateTimeVN, normalizeVietnameseProperName } from '../utils/formatters';
import { DatePickerVN } from './DatePickerVN';
import {
  findMemberByOcrPatientName,
  hasSameNameMemberConflict,
  isOcrSubjectMatchedToMember,
  isRecognizablePatientName,
  sanitizeOcrPatientName,
} from '../utils/ocrSubjectRouting';
import {
  updateBatchNotificationProgress,
  updateBatchNotificationComplete,
  requestNotificationPermission,
  scheduleFollowUpNotifications,
  setupBackgroundAppResumeListener,
} from '../utils/backgroundNotificationService';
import { getFollowUpRemindersForSignedInMember } from '../utils/followUpReminders';
import {
  BackPriority,
  dispatchBackAction,
  evaluateHorizontalGesture,
  hasActiveBackHandlers,
  shouldIgnoreHorizontalSwipeStart,
  useBackHandler,
} from '../utils/backNavigation';
export type DashboardTab = 'overview' | 'timeline' | 'assistant' | 'family';
const DASHBOARD_TAB_ORDER: DashboardTab[] = ['overview', 'timeline', 'assistant', 'family'];
interface HealthDashboardProps {
  userEmail: string | null;
  userName?: string | null;
  appVersion: string;
  driveAuthorized: boolean;
  driveRequestFailed: boolean;
  onDriveWorkspaceReset: () => void;
  onConnectDrive: () => void;
  onLogout: () => void;
  showToast: (message: string, type?: 'success' | 'info' | 'error') => void;
}
interface QueueItemContext {
  runId: number;
  itemToken: string;
}
interface DigitizationDraft {
  source: DriveFile;
  extracted: Partial<HealthEvent>;
  contentIndexPages: string[];
  contentIndexComplete: boolean;
  sourceContributions?: NonNullable<HealthSource['sourceContributions']>;
  queueContext?: QueueItemContext;
}
interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
  citations?: HealthAssistantCitation[];
}
const PROFILE_ROOT_KEY = 'health_family_drive_root_id';
const LOCAL_WORKSPACE_KEY = 'health_offline_workspace_v2';
const LOCAL_PROFILES_KEY = 'health_offline_profiles_v2';
const APK_LOCAL_OWNER_KEY = 'apk-local-device';
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const UPDATE_SERVER_URL =
  'https://raw.githubusercontent.com/tuanta3012/suckhoegiadinh/refs/heads/main/version.json';
const EXTRACTION_NOTIFICATION_PHASES: Record<ExtractionProgressUpdate['stage'], string> = {
  preparing: 'Chuẩn bị',
  reading_document: 'Đọc tài liệu',
  waiting_for_model: 'Chờ Gemini',
  retrying_model: 'Thử lại AI',
  extracting_content: 'Nhận dạng',
  matching_patient: 'Ghép hồ sơ',
  completed: 'Lưu kết quả',
};
function isLocalProfileFileId(fileId: string): boolean {
  return /^(?:local_profile_|profile_local_)/.test(fileId);
}
function createDefaultLocalWorkspace(
  adminEmail: string | null,
): HealthDriveWorkspace {
  return {
    rootFolderId: 'local_offline_workspace',
    familyFileId: 'local_family_file',
    family: {
      schemaVersion: 1,
      rawFilesFolderId: 'local_raw_folder',
      profilesFolderId: 'local_profiles_folder',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      adminEmail: adminEmail || 'offline@user',
      members: [],
    },
  };
}
function offlineCacheKey(baseKey: string, userEmail: string | null): string {
  return `${baseKey}_${encodeURIComponent(userEmail?.trim().toLowerCase() || 'guest')}`;
}
function loadNativeOfflineState(userEmail: string | null): {
  workspace: HealthDriveWorkspace;
  profiles: Record<string, HealthProfile>;
} {
  const fallback = {
    workspace: createDefaultLocalWorkspace(userEmail),
    profiles: {} as Record<string, HealthProfile>,
  };
  if (fallback.workspace.rootFolderId === 'local_offline_workspace') {
    fallback.profiles = Object.fromEntries(
      fallback.workspace.family.members.map((member) => [member.id, createHealthProfile(member)]),
    );
  }
  if (!Capacitor.isNativePlatform() || typeof localStorage === 'undefined') return fallback;
  const workspaceKey = offlineCacheKey(LOCAL_WORKSPACE_KEY, userEmail);
  const profilesKey = offlineCacheKey(LOCAL_PROFILES_KEY, userEmail);
  let serializedWorkspace = localStorage.getItem(workspaceKey);
  let serializedProfiles = localStorage.getItem(profilesKey);
  let migratingLegacyCache = false;
  if (!serializedWorkspace) {
    const legacyWorkspace = localStorage.getItem(LOCAL_WORKSPACE_KEY);
    if (legacyWorkspace) {
      try {
        const parsed = JSON.parse(legacyWorkspace) as HealthDriveWorkspace;
        const expectedEmail = userEmail?.trim().toLowerCase() || 'offline@user';
        const cachedAdminEmail = parsed.family?.adminEmail?.trim().toLowerCase();
        if (cachedAdminEmail === expectedEmail) {
          serializedWorkspace = legacyWorkspace;
          serializedProfiles = localStorage.getItem(LOCAL_PROFILES_KEY);
          migratingLegacyCache = true;
        } else {
          localStorage.removeItem(LOCAL_WORKSPACE_KEY);
          localStorage.removeItem(LOCAL_PROFILES_KEY);
        }
      } catch {
        localStorage.removeItem(LOCAL_WORKSPACE_KEY);
        localStorage.removeItem(LOCAL_PROFILES_KEY);
      }
    }
  }
  if (!serializedWorkspace) return fallback;
  try {
    const parsedWorkspace = JSON.parse(serializedWorkspace) as HealthDriveWorkspace;
    if (
      !parsedWorkspace?.family ||
      typeof parsedWorkspace.rootFolderId !== 'string' ||
      !Array.isArray(parsedWorkspace.family.members)
    ) {
      return fallback;
    }
    const parsedProfiles = serializedProfiles ? JSON.parse(serializedProfiles) as Record<string, HealthProfile> : {};
    if (!parsedProfiles || typeof parsedProfiles !== 'object' || Array.isArray(parsedProfiles)) {
      throw new Error('Dữ liệu hồ sơ ngoại tuyến không hợp lệ.');
    }
    if (migratingLegacyCache) {
      localStorage.setItem(workspaceKey, serializedWorkspace);
      if (serializedProfiles) localStorage.setItem(profilesKey, serializedProfiles);
      localStorage.removeItem(LOCAL_WORKSPACE_KEY);
      localStorage.removeItem(LOCAL_PROFILES_KEY);
    }
    if (parsedWorkspace.rootFolderId !== 'local_offline_workspace' && userEmail) {
      localStorage.setItem(
        `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`,
        parsedWorkspace.rootFolderId,
      );
    }
    if (parsedWorkspace.rootFolderId === 'local_offline_workspace') {
      for (const member of parsedWorkspace.family.members) {
        parsedProfiles[member.id] ||= createHealthProfile(member);
      }
    }
    return { workspace: parsedWorkspace, profiles: parsedProfiles };
  } catch (error) {
    console.warn('[Offline cache] Could not restore native workspace data.', error);
    return fallback;
  }
}
function loadGuestLocalState(): {
  workspace: HealthDriveWorkspace;
  profiles: Record<string, HealthProfile>;
} | null {
  if (!Capacitor.isNativePlatform() || typeof localStorage === 'undefined') return null;
  try {
    const workspaceValue = localStorage.getItem(offlineCacheKey(LOCAL_WORKSPACE_KEY, null));
    if (!workspaceValue) return null;
    const workspace = JSON.parse(workspaceValue) as HealthDriveWorkspace;
    if (
      workspace.rootFolderId !== 'local_offline_workspace' ||
      !Array.isArray(workspace.family?.members)
    ) return null;
    const profilesValue = localStorage.getItem(offlineCacheKey(LOCAL_PROFILES_KEY, null));
    const profiles = profilesValue ? JSON.parse(profilesValue) as Record<string, HealthProfile> : {};
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
      throw new Error('Dữ liệu hồ sơ ngoại tuyến không hợp lệ.');
    }
    for (const member of workspace.family.members) {
      profiles[member.id] ||= createHealthProfile(member);
    }
    return { workspace, profiles };
  } catch (error) {
    console.warn('[Offline cache] Could not inspect guest data for Drive import.', error);
    return null;
  }
}
async function applyPendingMemberDeletions(
  loadedWorkspace: HealthDriveWorkspace,
): Promise<HealthDriveWorkspace> {
  if (loadedWorkspace.rootFolderId === 'local_offline_workspace') return loadedWorkspace;
  const pending = readPendingMemberDeletions(loadedWorkspace.rootFolderId);
  let updatedWorkspace = loadedWorkspace;
  for (const deletion of pending) {
    if (updatedWorkspace.family.members.some((member) => member.id === deletion.memberId)) {
      const result = await deleteDriveFamilyMember(updatedWorkspace, deletion.memberId);
      updatedWorkspace = result.workspace;
    }
    completeMemberDeletion(updatedWorkspace.rootFolderId, deletion.memberId);
  }
  return updatedWorkspace;
}
function isNetworkUnavailableError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'unavailable'
  ) {
    return true;
  }
  return error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(error.message);
}
const EVENT_TYPE_OPTIONS: Array<{
  value: HealthEvent['type'];
  label: string;
  color: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'comprehensive_exam', label: 'Khám tổng quát', color: 'emerald', icon: Stethoscope },
  { value: 'medical_report', label: 'Khám bệnh', color: 'emerald', icon: Stethoscope },
  { value: 'prescription', label: 'Đơn thuốc', color: 'blue', icon: Pill },
  { value: 'test_result', label: 'Xét nghiệm', color: 'purple', icon: Activity },
  { value: 'imaging', label: 'Chẩn đoán hình ảnh', color: 'indigo', icon: Activity },
  { value: 'vaccination', label: 'Tiêm chủng', color: 'teal', icon: HeartPulse },
  { value: 'discharge', label: 'Ra viện', color: 'indigo', icon: FileHeart },
  { value: 'other', label: 'Khác', color: 'slate', icon: FileText },
];
export function HealthDashboard({
  userEmail,
  userName,
  appVersion,
  driveAuthorized,
  driveRequestFailed,
  onDriveWorkspaceReset,
  onConnectDrive,
  onLogout,
  showToast,
}: HealthDashboardProps) {
  const [offlineStartup] = useState(() => loadNativeOfflineState(userEmail));
  const [activeTab, setActiveTabRaw] = useState<DashboardTab>('overview');
  const activeTabRef = useRef<DashboardTab>('overview');
  activeTabRef.current = activeTab;
  const tabHistoryRef = useRef<DashboardTab[]>([]);
  const [tabSlideClass, setTabSlideClass] = useState<string>('animate-in fade-in duration-150');
  const setActiveTab = useCallback(
    (nextTab: DashboardTab, options?: { fromBack?: boolean; direction?: 'left' | 'right' }) => {
      const prevTab = activeTabRef.current;
      if (prevTab === nextTab) return;

      const prevIdx = DASHBOARD_TAB_ORDER.indexOf(prevTab);
      const nextIdx = DASHBOARD_TAB_ORDER.indexOf(nextTab);
      const direction = options?.direction ?? (nextIdx >= prevIdx ? 'left' : 'right');
      setTabSlideClass(direction === 'left' ? 'tab-slide-from-right' : 'tab-slide-from-left');

      if (options?.fromBack) {
        if (nextTab === 'overview') {
          tabHistoryRef.current = [];
        }
      } else if (nextTab === 'overview') {
        tabHistoryRef.current = [];
      } else {
        const history = tabHistoryRef.current;
        if (history[history.length - 1] !== prevTab) {
          history.push(prevTab);
          if (history.length > 8) history.shift();
        }
      }

      activeTabRef.current = nextTab;
      setActiveTabRaw(nextTab);
    },
    [],
  );
  const [rootIdInput, setRootIdInput] = useState('');
  const [workspace, setWorkspace] = useState<HealthDriveWorkspace>(offlineStartup.workspace);
  const hasRemoteWorkspace = workspace.rootFolderId !== 'local_offline_workspace';
  const needsDriveAuthorization = !driveAuthorized || driveRequestFailed;
  const driveActionLabel = !userEmail
    ? 'Đăng nhập Google'
    : needsDriveAuthorization
      ? 'Cấp lại quyền Drive'
      : hasRemoteWorkspace
        ? 'Đồng bộ dữ liệu'
        : 'Tạo kho dữ liệu';
  const [profiles, setProfiles] = useState<Record<string, HealthProfile>>(offlineStartup.profiles);
  const [localImportAvailable, setLocalImportAvailable] = useState(false);
  const [isImportingLocalData, setIsImportingLocalData] = useState(false);
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [selectedMemberId, setSelectedMemberId] = useState<string>(
    findMemberForEmail(offlineStartup.workspace.family.members, userEmail)?.id ||
      offlineStartup.workspace.family.members[0]?.id ||
      '',
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [editingMember, setEditingMember] = useState<FamilyMember | null>(null);
  const [isSavingMember, setIsSavingMember] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberBirthDate, setNewMemberBirthDate] = useState('');
  const [newMemberGender, setNewMemberGender] = useState<'male' | 'female' | 'other'>('male');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [workspaceAssignments, setWorkspaceAssignments] = useState<HealthWorkspaceAssignment[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceAccessRole>('EDITOR');
  const [digitizationDraft, setDigitizationDraft] = useState<DigitizationDraft | null>(null);
  const [digitizationError, setDigitizationError] = useState('');
  const [identityResolutionDraft, setIdentityResolutionDraft] = useState<DigitizationDraft | null>(null);
  const [isCreatingSubjectMember, setIsCreatingSubjectMember] = useState(false);
  const [pendingSubjectMember, setPendingSubjectMember] = useState<FamilyMember | null>(null);
  const [trackerState, setTrackerState] = useState<{
    isOpen: boolean;
    file: File | null;
    memberId: string;
    step: TrackerStep;
    progressPercent: number;
    progressMessage: string;
    driveFile: DriveFile | null;
    modelUsed: string;
    partialExtracted: Partial<HealthEvent>;
    error: string | null;
    totalPages?: number;
    processedPages?: number;
    queueContext?: QueueItemContext;
  }>({
    isOpen: false,
    file: null,
    memberId: '',
    step: 'uploading_drive',
    progressPercent: 0,
    progressMessage: '',
    driveFile: null,
    modelUsed: 'gemini-3.5-flash-lite',
    partialExtracted: {},
    error: null,
    totalPages: undefined,
    processedPages: undefined,
    queueContext: undefined,
  });
  const [showUploadMemberPicker, setShowUploadMemberPicker] = useState(false);
  const [isCameraTriggerActive, setIsCameraTriggerActive] = useState(false);
  const [isFileTriggerActive, setIsFileTriggerActive] = useState(false);
  const [isQuickActionTriggerActive, setIsQuickActionTriggerActive] = useState(false);
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatRequestIdRef = useRef(0);
  const [selectedMetric, setSelectedMetric] = useState('');
  const [timelineFilter, setTimelineFilter] = useState<string>('all');
  const [expandedMetricEventIds, setExpandedMetricEventIds] = useState<Record<string, boolean>>({});
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const [showRawFilesModal, setShowRawFilesModal] = useState(false);
  const [showAiResourcesModal, setShowAiResourcesModal] = useState(false);
  const memberMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeTab !== 'assistant') return;
    const chatContainer = chatScrollRef.current;
    if (!chatContainer) return;
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
  }, [activeTab, chatMessages.length, isChatting]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (memberMenuRef.current && !memberMenuRef.current.contains(target)) {
        setShowMemberDropdown(false);
      }
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(target)) {
        setShowSettingsDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  const [showQuickActionModal, setShowQuickActionModal] = useState(false);

  const mainContentRef = useRef<HTMLElement | null>(null);
  const swipeTouchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
    ignoreTabSwipe: boolean;
  } | null>(null);
  const lastRootBackPressAtRef = useRef<number>(0);
  const lastBackHandledAtRef = useRef<number>(0);

  useBackHandler(
    showMemberDropdown,
    () => {
      setShowMemberDropdown(false);
      return true;
    },
    BackPriority.DROPDOWN,
  );
  useBackHandler(
    showSettingsDropdown,
    () => {
      setShowSettingsDropdown(false);
      return true;
    },
    BackPriority.DROPDOWN,
  );
  useBackHandler(
    showQuickActionModal,
    () => {
      setShowQuickActionModal(false);
      pickedMemberIdForBatchRef.current = undefined;
      return true;
    },
    BackPriority.SHEET,
  );
  useBackHandler(
    Boolean(workspace) && activeTab !== 'overview',
    () => {
      const prevTab = tabHistoryRef.current.pop();
      const targetTab = prevTab && prevTab !== activeTabRef.current ? prevTab : 'overview';
      setActiveTab(targetTab, { fromBack: true, direction: 'right' });
      return true;
    },
    BackPriority.TAB,
  );

  const handleBackNavigation = useCallback(() => {
    const now = Date.now();
    if (now - lastBackHandledAtRef.current < 180) return;
    lastBackHandledAtRef.current = now;

    if (dispatchBackAction()) {
      lastRootBackPressAtRef.current = 0;
      return;
    }

    if (Capacitor.isNativePlatform()) {
      const isBusy = isUploadingRef.current || Boolean(queueStatusRef.current);
      if (now - lastRootBackPressAtRef.current <= 2000) {
        lastRootBackPressAtRef.current = 0;
        if (isBusy) {
          void CapacitorApp.minimizeApp().catch(() => {});
        } else {
          void CapacitorApp.exitApp().catch(() => {});
        }
        return;
      }
      lastRootBackPressAtRef.current = now;
      showToast(
        isBusy
          ? 'Đang xử lý tài liệu — nhấn Back lần nữa để thu nhỏ'
          : 'Nhấn Back lần nữa để thoát ứng dụng',
        'info',
      );
    }
  }, [showToast]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (dispatchBackAction()) {
          event.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    let backListenerHandle: { remove: () => Promise<void> } | null = null;
    let disposed = false;

    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('backButton', () => {
        handleBackNavigation();
      })
        .then((handle) => {
          if (disposed) {
            void handle.remove();
          } else {
            backListenerHandle = handle;
          }
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      window.removeEventListener('keydown', handleKeyDown);
      if (backListenerHandle) {
        void backListenerHandle.remove();
      }
    };
  }, [handleBackNavigation]);
  const [showWorkspaceAuditModal, setShowWorkspaceAuditModal] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [queueStatus, setQueueStatus] = useState<{ current: number; total: number } | null>(null);
  const queueStatusRef = useRef<{ current: number; total: number } | null>(null);
  const batchFailureCountRef = useRef(0);
  const activeQueueRunIdRef = useRef<number | null>(null);
  const activeQueueItemTokenRef = useRef<string | null>(null);
  const completedQueueTokensRef = useRef<Set<string>>(new Set());
  const queueErrorAdvanceTimerRef = useRef<number | null>(null);
  const activeUploadOpRef = useRef<string | null>(null);
  const isUploadingRef = useRef(false);
  const [queueElapsedSeconds, setQueueElapsedSeconds] = useState(0);
  const queueStartedAtRef = useRef<number | null>(null);
  const updateQueueStatus = useCallback((next: { current: number; total: number } | null) => {
    queueStatusRef.current = next;
    setQueueStatus(next);
  }, []);
  const beginUploadOp = useCallback((opToken: string) => {
    activeUploadOpRef.current = opToken;
    isUploadingRef.current = true;
    setIsUploading(true);
  }, []);
  const endUploadOp = useCallback((opToken: string) => {
    if (activeUploadOpRef.current === opToken) {
      activeUploadOpRef.current = null;
      isUploadingRef.current = false;
      setIsUploading(false);
    }
  }, []);
  useEffect(() => {
    if (!queueStatus) {
      queueStartedAtRef.current = null;
      setQueueElapsedSeconds(0);
      return;
    }
    const startedAt = queueStartedAtRef.current ?? Date.now();
    queueStartedAtRef.current = startedAt;
    const updateElapsedTime = () => {
      setQueueElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    updateElapsedTime();
    const intervalId = window.setInterval(updateElapsedTime, 1000);
    return () => window.clearInterval(intervalId);
  }, [queueStatus]);
  const [pendingLocalUploadCount, setPendingLocalUploadCount] = useState(0);
  const [ocrRecoveryJobs, setOcrRecoveryJobs] = useState<OcrRecoveryJob[]>([]);
  const workspaceRef = useRef<HealthDriveWorkspace | null>(null);
  const isCreatingWorkspaceRef = useRef(false);
  const isResettingRef = useRef(false);
  const profilesRef = useRef<Record<string, HealthProfile>>({});
  const shouldRefreshCachedWorkspaceRef = useRef(
    Capacitor.isNativePlatform() &&
      offlineStartup.workspace.rootFolderId !== 'local_offline_workspace',
  );
  const selectedMemberIdRef = useRef<string>(selectedMemberId);
  const uploadQueueRef = useRef<File[]>([]);
  const pendingUploadIdsRef = useRef<Array<string | undefined>>([]);
  const processingPendingUploadIdsRef = useRef(new Set<string>());
  const pendingUploadDrainInFlightRef = useRef(false);
  const syncOnResumeInFlightRef = useRef(false);
  const pickedMemberIdForBatchRef = useRef<string | undefined>(undefined);
  const batchStagingMemberIdRef = useRef<string | undefined>(undefined);
  const authIdentityRef = useRef({ userEmail, driveAuthorized });
  authIdentityRef.current = { userEmail, driveAuthorized };
  const previousSelectedMemberIdRef = useRef(selectedMemberId);
  const previousWorkspaceRootRef = useRef(workspace?.rootFolderId);
  useEffect(() => {
    if (previousSelectedMemberIdRef.current !== selectedMemberId) {
      previousSelectedMemberIdRef.current = selectedMemberId;
      chatRequestIdRef.current += 1;
      setChatMessages([]);
      setChatInput('');
      setIsChatting(false);
      setSelectedMetric('');
      setTimelineFilter('all');
      setExpandedMetricEventIds({});
    }
  }, [selectedMemberId]);
  useEffect(() => {
    if (previousWorkspaceRootRef.current !== workspace?.rootFolderId) {
      previousWorkspaceRootRef.current = workspace?.rootFolderId;
      chatRequestIdRef.current += 1;
      setChatMessages([]);
      setChatInput('');
      setIsChatting(false);
      setSelectedMetric('');
      setTimelineFilter('all');
      setExpandedMetricEventIds({});
    }
  }, [workspace?.rootFolderId]);
  const normalizedUserEmail = userEmail?.trim().toLowerCase() || null;
  const [cacheOwnerEmail, setCacheOwnerEmail] = useState<string | null>(normalizedUserEmail);
  const previousUserEmailRef = useRef(normalizedUserEmail);
  const discoveryAttemptedRef = useRef(false);
  useEffect(() => {
    if (previousUserEmailRef.current === normalizedUserEmail) return;
    previousUserEmailRef.current = normalizedUserEmail;
    discoveryAttemptedRef.current = false;
    chatRequestIdRef.current += 1;
    const nextOfflineState = loadNativeOfflineState(userEmail);
    setWorkspace(nextOfflineState.workspace);
    shouldRefreshCachedWorkspaceRef.current =
      Capacitor.isNativePlatform() &&
      nextOfflineState.workspace.rootFolderId !== 'local_offline_workspace';
    setProfiles(nextOfflineState.profiles);
    profilesRef.current = nextOfflineState.profiles;
    setCacheOwnerEmail(normalizedUserEmail);
    setSelectedMemberId(
      findMemberForEmail(nextOfflineState.workspace.family.members, userEmail)?.id ||
        nextOfflineState.workspace.family.members[0]?.id ||
        '',
    );
    setProfileErrors({});
    setDigitizationDraft(null);
    setIdentityResolutionDraft(null);
    setPendingSubjectMember(null);
    setIsCreatingSubjectMember(false);
    setChatMessages([]);
    setIsChatting(false);
    setOcrRecoveryJobs([]);
    setWorkspaceAssignments([]);
    setEditingMember(null);
    setErrorMessage('');
  }, [normalizedUserEmail, userEmail]);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || cacheOwnerEmail !== normalizedUserEmail) return;
    try {
      localStorage.setItem(
        offlineCacheKey(LOCAL_WORKSPACE_KEY, userEmail),
        JSON.stringify(workspace),
      );
    } catch (error) {
      console.warn('[Offline cache] Could not persist native workspace.', error);
    }
  }, [cacheOwnerEmail, normalizedUserEmail, userEmail, workspace]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || cacheOwnerEmail !== normalizedUserEmail) return;
    const key = offlineCacheKey(LOCAL_PROFILES_KEY, userEmail);
    try {
      if (Object.keys(profiles).length > 0) {
        localStorage.setItem(key, JSON.stringify(profiles));
      } else {
        localStorage.removeItem(key);
      }
    } catch (error) {
      console.warn('[Offline cache] Could not persist native health profiles.', error);
    }
  }, [cacheOwnerEmail, normalizedUserEmail, profiles, userEmail]);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);
  useEffect(() => {
    selectedMemberIdRef.current = selectedMemberId;
  }, [selectedMemberId]);
  useEffect(() => {
    isUploadingRef.current = isUploading;
  }, [isUploading]);
  function persistOcrRecoveryJob(
    driveFileId: string,
    status: OcrRecoveryJob['status'],
    progressPercent: number,
    fileName?: string,
  ) {
    if (!workspace) return;
    try {
      setOcrRecoveryJobs(upsertOcrRecoveryJob(workspace.rootFolderId, {
        driveFileId,
        status,
        progressPercent,
        fileName,
        updatedAt: Date.now(),
      }));
    } catch (error) {
      console.error('[OCR recovery] Could not persist local recovery metadata.', error);
      showToast('Không lưu được trạng thái khôi phục OCR trên thiết bị này.', 'error');
    }
  }
  function forgetOcrRecoveryJob(driveFileId: string) {
    if (!workspace) return;
    try {
      setOcrRecoveryJobs(removeOcrRecoveryJob(workspace.rootFolderId, driveFileId));
    } catch (error) {
      console.error('[OCR recovery] Could not remove local recovery metadata.', error);
      showToast('Không thể xóa trạng thái khôi phục OCR khỏi thiết bị.', 'error');
    }
  }
  async function runFamilyDoctorSummaryAfterQueue() {
    const targetMemberId = selectedMemberIdRef.current || selectedMemberId;
    const targetMember = workspaceRef.current?.family.members.find(m => m.id === targetMemberId) || selectedMember;
    if (!targetMember) return;
    let currentProfile = profilesRef.current[targetMember.id] || profiles[targetMember.id];
    if (!currentProfile || !currentProfile.timeline || currentProfile.timeline.length === 0) return;
    const pipelineTimer = digitizationLogger.startTimer();
    digitizationLogger.log(
      'info',
      'auto_pipeline_start',
      `Bắt đầu chuỗi phân tích tự động (Chuẩn hóa danh pháp + Phân tích 4 lớp y khoa) sau hàng đợi cho ${targetMember.name} (${currentProfile.timeline.length} sự kiện)`,
      { memberId: targetMember.id, memberName: targetMember.name, timelineCount: currentProfile.timeline.length }
    );
    showToast(
      `Đang tự động chuẩn hóa danh pháp & phân tích y khoa 4 lớp cho ${targetMember.name}...`,
      'info',
    );
    setIsSummarizing(true);
    try {
      // 1. Tự động Chuẩn hóa, phân loại & gộp sự kiện trùng trong cùng đợt khám
      const { organizedTimeline } = await refineAndOrganizeMemberData(
        targetMember,
        currentProfile.timeline,
      );
      const { timeline: consolidatedTimeline } = consolidateTimelineEvents(organizedTimeline);

      const refinedProfile: HealthProfile = {
        ...currentProfile,
        timeline: consolidatedTimeline,
        summary: summarizeTimeline(consolidatedTimeline, currentProfile.summary.narrative),
      };
      // 2. Tự động Phân tích 4 Lớp Y Khoa Chuyên Sâu bằng gemini-4-hydrogen
      const narrative = await summarizeHealthProfile(targetMember, refinedProfile);
      const deepRes = await analyzeComprehensiveHealth(targetMember, refinedProfile, 'gemini-4-hydrogen');
      
      const updated: HealthProfile = {
        ...refinedProfile,
        summary: { ...refinedProfile.summary, narrative },
        aiDeepAnalysis: deepRes.result,
        aiAnalysis: deepRes.aiAnalysis,
        updatedAt: new Date().toISOString(),
      };
      
      const saveTimer = digitizationLogger.startTimer();
      const saved = await saveHealthProfile(targetMember.profileFileId, updated);
      const saveMs = saveTimer();
      profilesRef.current = { ...profilesRef.current, [targetMember.id]: saved };
      setProfiles((prev) => ({ ...prev, [targetMember.id]: saved }));
      const totalPipelineMs = pipelineTimer();
      digitizationLogger.log(
        'info',
        'auto_pipeline_complete',
        `Hoàn tất thành công toàn bộ chuỗi phân tích tự động cho ${targetMember.name} trong ${totalPipelineMs}ms (lưu Drive ${saveMs}ms)!`,
        { memberId: targetMember.id, totalPipelineMs, saveMs },
        totalPipelineMs
      );
      showToast(`Đã tự động chuẩn hóa & cập nhật phân tích 4 lớp AI lên trang chính của ${targetMember.name}!`, 'success');
    } catch (error) {
      const totalPipelineMs = pipelineTimer();
      digitizationLogger.log(
        'error',
        'auto_pipeline_error',
        `Lỗi chuỗi phân tích tự động cho ${targetMember.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
        { error: error instanceof Error ? error.message : 'Unknown' },
        totalPipelineMs
      );
      console.warn('[Auto Family Doctor Summary Warning]:', error);
      showToast(
        error instanceof Error ? error.message : 'Lỗi khi tự động phân tích chuyên sâu.',
        'error',
      );
    } finally {
      setIsSummarizing(false);
    }
  }
  function notifyBatchProgress(
    fileName: string,
    memberName: string | undefined,
    phase: string,
    progressPercent?: number,
  ) {
    const status = queueStatusRef.current;
    if (!status) return;
    void updateBatchNotificationProgress({
      current: status.current,
      total: status.total,
      fileName,
      memberName,
      phase,
      progressPercent,
    });
  }
  function processNextInQueue(expectedContext?: QueueItemContext) {
    if (!expectedContext) return;
    if (
      activeQueueRunIdRef.current !== expectedContext.runId ||
      activeQueueItemTokenRef.current !== expectedContext.itemToken ||
      completedQueueTokensRef.current.has(expectedContext.itemToken)
    ) {
      return;
    }
    completedQueueTokensRef.current.add(expectedContext.itemToken);
    if (queueErrorAdvanceTimerRef.current !== null) {
      window.clearTimeout(queueErrorAdvanceTimerRef.current);
      queueErrorAdvanceTimerRef.current = null;
    }
    activeQueueItemTokenRef.current = null;

    const queue = uploadQueueRef.current;
    const currentStatus = queueStatusRef.current;
    if (!currentStatus) return;

    if (queue.length > 0) {
      const nextFile = queue[0];
      const pendingUploadId = pendingUploadIdsRef.current.shift();
      if (pendingUploadId) processingPendingUploadIdsRef.current.add(pendingUploadId);
      const remaining = queue.slice(1);
      uploadQueueRef.current = remaining;
      setUploadQueue(remaining);
      const nextCurrent = currentStatus.current + 1;
      const nextStatus = { current: nextCurrent, total: currentStatus.total };
      updateQueueStatus(nextStatus);
      const nextItemToken = `${expectedContext.runId}:${nextCurrent}`;
      activeQueueItemTokenRef.current = nextItemToken;
      const nextQueueContext: QueueItemContext = {
        runId: expectedContext.runId,
        itemToken: nextItemToken,
      };
      digitizationLogger.log(
        'info',
        'queue_advance',
        `Hàng đợi chuyển sang tệp ${nextCurrent}/${currentStatus.total}: "${nextFile.name}" (${(nextFile.size / 1024).toFixed(0)} KB)`,
        { index: nextCurrent, total: currentStatus.total, fileName: nextFile.name, size: nextFile.size }
      );
      showToast(`Hàng đợi tải lên: Đang xử lý tệp ${nextCurrent}/${currentStatus.total} (${nextFile.name})...`, 'info');
      notifyBatchProgress(nextFile.name, selectedMember?.name, 'Chuẩn bị');
      void beginDigitization(nextFile, {
        memberId: batchStagingMemberIdRef.current,
        pendingUploadId,
        queueContext: nextQueueContext,
      });
    } else {
      const finalTotal = currentStatus.total || 1;
      const failedCount = batchFailureCountRef.current;
      const completedCount = Math.max(0, finalTotal - failedCount);
      uploadQueueRef.current = [];
      pendingUploadIdsRef.current = [];
      setUploadQueue([]);
      activeQueueRunIdRef.current = null;
      activeQueueItemTokenRef.current = null;
      completedQueueTokensRef.current.clear();
      activeUploadOpRef.current = null;
      isUploadingRef.current = false;
      setIsUploading(false);
      digitizationLogger.log(
        failedCount > 0 ? 'warn' : 'info',
        'queue_finish',
        failedCount > 0
          ? `Hoàn tất hàng đợi: ${completedCount}/${finalTotal} tệp xử lý xong, ${failedCount} tệp lỗi cần chạy lại.`
          : `Đã số hóa thành công toàn bộ ${finalTotal} tệp trong hàng đợi! Bạn có thể bấm "AI Y khoa Chuyên sâu" khi sẵn sàng tổng hợp.`,
        { totalFiles: finalTotal, completedFiles: completedCount, failedFiles: failedCount }
      );
      showToast(
        failedCount > 0
          ? `Đã xử lý ${completedCount}/${finalTotal} tệp. ${failedCount} tệp lỗi vẫn được giữ lại để chạy lại OCR.`
          : `Đã nhập dữ liệu xong ${finalTotal} tệp vào hồ sơ! Bấm nút "AI Y khoa Chuyên sâu" để cập nhật tổng kết.`,
        failedCount > 0 ? 'info' : 'success',
      );
      void updateBatchNotificationComplete({
        total: finalTotal,
        memberName: selectedMember?.name,
        failedCount,
      });
      batchFailureCountRef.current = 0;
      updateQueueStatus(null);
      pickedMemberIdForBatchRef.current = undefined;
      batchStagingMemberIdRef.current = undefined;
    }
  }
  async function stageFilesAndStart(
    files: File[],
    memberId?: string,
  ): Promise<void> {
    if (files.length === 0) return;
    if (
      queueStatusRef.current ||
      activeQueueRunIdRef.current !== null ||
      isUploadingRef.current
    ) {
      showToast('Đang có hàng đợi xử lý tài liệu chạy. Hãy đợi hoàn tất hoặc bấm "Dừng xử lý".', 'info');
      return;
    }
    if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      showToast('Mỗi tệp phải nhỏ hơn hoặc bằng 30 MB.', 'error');
      return;
    }
    const initialWorkspace = workspaceRef.current;
    if (!initialWorkspace) {
      showToast('Chưa có hồ sơ đích để lưu tài liệu.', 'error');
      return;
    }
    // Tự động thiết lập Drive nếu đã đăng nhập nhưng vẫn ở chế độ Cục bộ
    if (driveAuthorized && initialWorkspace.rootFolderId === 'local_offline_workspace') {
      await handleManualSync({ autoCreate: true });
    }
    // Refresh workspace reference after sync / auto-creation
    let activeWorkspace = workspaceRef.current || initialWorkspace;
    // Nếu vẫn là local và không hỗ trợ hàng đợi ngoại tuyến, báo lỗi ngay
    if (activeWorkspace.rootFolderId === 'local_offline_workspace' && !supportsDurableOfflineQueue()) {
      showToast('Hãy kết nối Google Drive để tải tài liệu lên (Trình duyệt này không hỗ trợ hàng đợi ngoại tuyến).', 'error');
      return;
    }
    const isLocalOnlyWorkspace =
      activeWorkspace.rootFolderId === 'local_offline_workspace' &&
      supportsDurableOfflineQueue();
    let targetMember =
      activeWorkspace.family.members.find((member) => member.id === memberId) ||
      findMemberForEmail(activeWorkspace.family.members, userEmail) ||
      activeWorkspace.family.members[0];
    digitizationLogger.log(
      'info',
      'batch_start',
      `Tiếp nhận ${files.length} tệp tài liệu: ${files.map((f) => `"${f.name}" [${(f.size / 1024).toFixed(0)}KB]`).join(', ')}. Chế độ: ${memberId ? `Gán cụ thể vào ${targetMember?.name || memberId}` : 'Tự động nhận diện chủ thể'}`,
      {
        totalFiles: files.length,
        fileNames: files.map((f) => f.name),
        autoDetect: !memberId,
        targetMemberId: memberId,
      }
    );
    if (!targetMember) {
      try {
        const newMemberId = `member_${crypto.randomUUID().slice(0, 12)}`;
        // Ưu tiên tạo member trên Drive nếu đã kết nối
        if (activeWorkspace.rootFolderId !== 'local_offline_workspace' && driveAuthorized) {
          const workspaceAfterMember = await addDriveFamilyMember(activeWorkspace, {
            id: newMemberId,
            name: 'Thành viên mới',
            role: 'other',
          });
          workspaceRef.current = workspaceAfterMember;
          setWorkspace(workspaceAfterMember);
          const loadedProfiles = await reloadProfiles(workspaceAfterMember);
          profilesRef.current = loadedProfiles;
          activeWorkspace = workspaceAfterMember;
          targetMember = workspaceAfterMember.family.members.find((member) => member.id === newMemberId);
        } else if (supportsDurableOfflineQueue() && offlineOwnerKey) {
          // Fallback sang Offline Member nếu được hỗ trợ
          const localMember: FamilyMember = {
            id: newMemberId,
            name: 'Thành viên mới',
            role: 'other',
            driveFolderId: `local_folder_${newMemberId}`,
            profileFileId: `local_profile_${newMemberId}`,
          };
          const localProfile = { ...createHealthProfile(localMember), syncPending: true };
          await localSyncOutbox.enqueueMemberSave(
            offlineOwnerKey,
            activeWorkspace.rootFolderId,
            localMember,
            localProfile,
            true,
          );
          const nextWs: HealthDriveWorkspace = {
            ...activeWorkspace,
            family: {
              ...activeWorkspace.family,
              members: [...activeWorkspace.family.members, localMember],
              updatedAt: new Date().toISOString(),
            },
          };
          workspaceRef.current = nextWs;
          setWorkspace(nextWs);
          profilesRef.current = { ...profilesRef.current, [newMemberId]: localProfile };
          setProfiles((previous) => ({ ...previous, [newMemberId]: localProfile }));
          activeWorkspace = nextWs;
          targetMember = localMember;
        }
      } catch (error) {
        showToast(
          error instanceof Error
            ? `Không thể chuẩn bị hồ sơ nhận diện tài liệu: ${error.message}`
            : 'Không thể chuẩn bị hồ sơ nhận diện tài liệu.',
          'error',
        );
        return;
      }
    }
    if (!targetMember) {
      showToast('Không thể chuẩn bị hồ sơ nhận diện tài liệu. Hãy kết nối Drive hoặc thêm hồ sơ thành viên rồi thử lại.', 'error');
      return;
    }
    batchStagingMemberIdRef.current = targetMember.id;
    activeWorkspace = workspaceRef.current || activeWorkspace;
    const queuedIds: Array<string | undefined> = [];
    if (supportsDurableOfflineQueue() && offlineOwnerKey) {
      try {
        for (const file of files) {
          const operation = await localSyncOutbox.enqueueUpload(
            offlineOwnerKey,
            activeWorkspace.rootFolderId,
            targetMember,
            file,
          );
          queuedIds.push(operation.id);
        }
        if (!isLocalOnlyWorkspace) {
          setPendingLocalUploadCount((count) => count + queuedIds.length);
        }
      } catch (error) {
        showToast(
          error instanceof Error
            ? `Không thể lưu tài liệu vào hàng đợi trên thiết bị: ${error.message}`
            : 'Không thể lưu tài liệu vào hàng đợi trên thiết bị.',
          'error',
        );
        return;
      }
    } else {
      queuedIds.push(...files.map(() => undefined));
    }
    const isOnline = typeof navigator === 'undefined' || navigator.onLine;
    if (!driveAuthorized || !isOnline || activeWorkspace.rootFolderId === 'local_offline_workspace') {
      if (supportsDurableOfflineQueue() && offlineOwnerKey) {
        showToast(
          isLocalOnlyWorkspace
            ? `Đã lưu ${files.length} tài liệu trên thiết bị; chưa đồng bộ lên Google Drive.`
            : `Đã lưu ${files.length} tài liệu trên thiết bị; sẽ tải lên khi Drive có thể truy cập.`,
          'info',
        );
      } else {
        showToast('Không có kết nối Drive và trình duyệt không hỗ trợ hàng đợi ngoại tuyến bền vững.', 'error');
      }
      if (!isLocalOnlyWorkspace) return;
    }
    const firstPendingId = queuedIds[0];
    if (firstPendingId) processingPendingUploadIdsRef.current.add(firstPendingId);
    if (queueErrorAdvanceTimerRef.current !== null) {
      window.clearTimeout(queueErrorAdvanceTimerRef.current);
      queueErrorAdvanceTimerRef.current = null;
    }
    const runId = Date.now();
    const firstItemToken = `${runId}:1`;
    activeQueueRunIdRef.current = runId;
    activeQueueItemTokenRef.current = firstItemToken;
    completedQueueTokensRef.current.clear();
    const firstQueueContext: QueueItemContext = { runId, itemToken: firstItemToken };
    uploadQueueRef.current = files.slice(1);
    pendingUploadIdsRef.current = queuedIds.slice(1);
    setUploadQueue(files.slice(1));
    const initialStatus = { current: 1, total: files.length };
    batchFailureCountRef.current = 0;
    queueStartedAtRef.current = Date.now();
    setQueueElapsedSeconds(0);
    updateQueueStatus(initialStatus);
    showToast(
      files.length === 1
        ? `Đang xử lý tài liệu cho ${targetMember.name}...`
        : `Đã xếp ${files.length} tệp; bắt đầu xử lý theo thứ tự.`,
      'info',
    );
    void requestNotificationPermission();
    void updateBatchNotificationProgress({
      current: 1,
      total: files.length,
      fileName: files[0].name,
      memberName: targetMember.name,
      phase: 'Chuẩn bị',
    });
    void beginDigitization(files[0], {
      memberId: memberId || targetMember.id,
      pendingUploadId: firstPendingId,
      queueContext: firstQueueContext,
    });
  }
  async function getPendingUpload(operationId: string): Promise<PendingUpload | undefined> {
    if (!supportsDurableOfflineQueue() || !offlineOwnerKey) return undefined;
    return localSyncOutbox.getUpload(offlineOwnerKey, operationId);
  }
  async function completePendingUpload(operationId?: string): Promise<void> {
    if (!operationId || !supportsDurableOfflineQueue() || !offlineOwnerKey) return;
    const pending = await getPendingUpload(operationId);
    if (!pending) return;
    await localSyncOutbox.complete(offlineOwnerKey, operationId);
    setPendingLocalUploadCount((count) => Math.max(0, count - 1));
  }
  async function handleManualSync(options: { autoCreate?: boolean } = {}): Promise<boolean> {
    if (!driveAuthorized) {
      showToast('Đang mở trang đăng nhập Google Drive để kích hoạt đồng bộ 2 chiều...', 'info');
      onConnectDrive();
      return false;
    }
    const cleanEmail = userEmail ? userEmail.trim().toLowerCase() : null;
    const savedRootId = cleanEmail
      ? localStorage.getItem(`${PROFILE_ROOT_KEY}_${cleanEmail}`)
      : null;
    if (savedRootId) {
      const opened = await openWorkspace(savedRootId);
      if (opened) return true;
      // Stale savedRootId was cleaned up by openWorkspace; continue below to find or autoCreate!
    }
    if (!workspace || workspace.rootFolderId === 'local_offline_workspace') {
      setIsSyncing(true);
      showToast('Đang tự động quét và kết nối Thư mục Sức Khỏe trên Google Drive...', 'info');
      try {
        const discovered = await findExistingHealthWorkspace();
        if (discovered) {
          const synchronized = await applyPendingMemberDeletions(discovered);
          if (cleanEmail) {
            localStorage.setItem(
              `${PROFILE_ROOT_KEY}_${cleanEmail}`,
              synchronized.rootFolderId
            );
          }
          localStorage.setItem(PROFILE_ROOT_KEY, synchronized.rootFolderId);
          workspaceRef.current = synchronized;
          setWorkspace(synchronized);
          setSelectedMemberId(
            findMemberForEmail(synchronized.family.members, userEmail)?.id ||
              synchronized.family.members[0]?.id ||
              '',
          );
          await reloadProfiles(synchronized);
          setErrorMessage('');
          showToast('Đã kết nối và đồng bộ 2 chiều thành công!', 'success');
          return true;
        } else if (options.autoCreate) {
          showToast('Đang khởi tạo thư mục Sức khỏe Gia đình mới trên Google Drive...', 'info');
          await handleCreateWorkspace();
          return true;
        } else {
          showToast('Không tìm thấy thư mục "Suc khoe gia dinh" trên Drive của bạn. Hãy bấm "Tạo kho dữ liệu".', 'info');
          return false;
        }
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : 'Không thể tìm hoặc mở thư mục Sức khỏe Gia đình trên Google Drive.';
        setErrorMessage(message);
        showToast(message, 'error');
        return false;
      } finally {
        setIsSyncing(false);
      }
      return false;
    }
    setIsLoading(true);
    showToast('Đang đồng bộ dữ liệu 2 chiều với Google Drive...', 'info');
    try {
      const loaded = await openHealthWorkspace(workspace.rootFolderId);
      const synchronized = await applyPendingMemberDeletions(loaded);
      setWorkspace(synchronized);
      await reloadProfiles(synchronized);
      
      // Tự động đồng bộ quyền truy cập cho thành viên nếu là Admin
      if (isWorkspaceAdmin) {
        void syncHealthWorkspaceMemberAssignments(synchronized).catch(err => {
          console.warn('[Sync] Tự động đồng bộ quyền Drive thất bại:', err);
        });
      }
      showToast('Đã đồng bộ dữ liệu 2 chiều thành công!', 'success');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Lỗi khi đồng bộ dữ liệu với Drive.',
        'error'
      );
    } finally {
      setIsLoading(false);
    }
  }
  useEffect(() => {
    if (
      !driveAuthorized ||
      !userEmail ||
      !workspace ||
      workspace.rootFolderId === 'local_offline_workspace'
    ) return;
    let cancelled = false;
    const syncWhenAvailable = async () => {
      if (
        cancelled ||
        syncOnResumeInFlightRef.current ||
        isLoading ||
        isUploading ||
        isUploadingRef.current ||
        queueStatusRef.current !== null ||
        activeQueueRunIdRef.current !== null ||
        (typeof navigator !== 'undefined' && !navigator.onLine)
      ) return;
      syncOnResumeInFlightRef.current = true;
      try {
        await handleManualSync();
      } finally {
        syncOnResumeInFlightRef.current = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncWhenAvailable();
    };
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [driveAuthorized, userEmail, workspace?.rootFolderId, isLoading, isUploading]);
  async function handleFactoryReset() {
    if (isLoading || isUploading || uploadQueueRef.current.length > 0) {
      showToast('Hãy đợi các thao tác tải lên hoặc đồng bộ hiện tại kết thúc rồi thử xóa lại.', 'info');
      return;
    }
    const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || '';
    const currentEmail = normalizeEmail(userEmail || getSignedInGoogleEmail());
    const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
    const hasRemoteWorkspace = Boolean(
      workspace && workspace.rootFolderId !== 'local_offline_workspace',
    );
    const selfMember = workspace?.family.members.find(
      (m) => normalizeEmail(m.email) === currentEmail,
    );
    let confirmed = false;
    let willDeleteEntireWorkspace = false;
    let willDeleteSelfMember = false;
    if (isWorkspaceAdmin) {
      willDeleteEntireWorkspace = isOnline && driveAuthorized && hasRemoteWorkspace;
      confirmed = await confirm({
        title: 'Xóa toàn bộ kho dữ liệu gia đình?',
        message: willDeleteEntireWorkspace
          ? 'Toàn bộ nội dung trong thư mục Workspace "Suc khoe gia dinh" trên Google Drive và dữ liệu sức khỏe của mọi thành viên sẽ bị xóa vĩnh viễn. Không thể hoàn tác.'
          : 'Toàn bộ dữ liệu sức khỏe, cache và hàng đợi chưa đồng bộ trên thiết bị này sẽ bị xóa vĩnh viễn. Dữ liệu trên Google Drive không bị xóa' +
            (hasRemoteWorkspace && !isOnline ? ' vì thiết bị đang offline.' : hasRemoteWorkspace ? ' vì Drive chưa được kết nối.' : '.') +
            ' Không thể khôi phục.',
        confirmLabel: 'Xóa toàn bộ kho dữ liệu',
      });
    } else {
      willDeleteSelfMember = isOnline && driveAuthorized && hasRemoteWorkspace && Boolean(selfMember);
      confirmed = await confirm({
        title: selfMember ? `Xóa dữ liệu hồ sơ của bạn (${selfMember.name})?` : 'Xóa dữ liệu trên thiết bị?',
        message: willDeleteSelfMember && selfMember
          ? `Thư mục tài liệu gốc (ảnh, PDF) và file hồ sơ JSON của riêng bạn sẽ bị xóa vĩnh viễn khỏi Google Drive. Bạn sẽ rời khỏi không gian gia đình này. Dữ liệu của các thành viên khác trong gia đình vẫn được giữ nguyên vẹn. Không thể hoàn tác.`
          : 'Toàn bộ dữ liệu hồ sơ và bộ nhớ tạm (cache) trên thiết bị này sẽ được dọn sạch.',
        confirmLabel: selfMember ? 'Xóa dữ liệu của tôi' : 'Xóa dữ liệu thiết bị',
      });
    }
    if (!confirmed) return;
    if (willDeleteEntireWorkspace) {
      onDriveWorkspaceReset();
    }
    
    setIsLoading(true);
    isResettingRef.current = true;
    discoveryAttemptedRef.current = true;
    // 1. Lưu lại các tham số cần thiết
    const oldRootFolderId = workspace?.rootFolderId;
    const oldUserEmail = userEmail;
    // 2. Tạo trạng thái mới sạch sẽ
    const freshWs = createDefaultLocalWorkspace(userEmail);
    const freshProf = {};
    try {
      // 3. Xóa dữ liệu Google Drive và Registry nếu có quyền
      if (willDeleteEntireWorkspace && oldRootFolderId) {
        showToast('Đang xóa toàn bộ thư mục Workspace trên Google Drive...', 'info');
        try {
          await deleteHealthWorkspaceFolder(oldRootFolderId);
        } catch (delError) {
          console.warn('[FactoryReset] Lỗi khi xóa trên Google Drive:', delError);
        }
      } else if (willDeleteSelfMember && selfMember && workspace) {
        showToast('Đang xóa tài liệu và hồ sơ cá nhân của bạn trên Google Drive...', 'info');
        try {
          await deleteDriveFamilyMember(workspace, selfMember.id);
        } catch (delError) {
          console.warn('[FactoryReset] Lỗi khi xóa hồ sơ thành viên trên Google Drive:', delError);
        }
      }
      // 4. Xóa cache "Sổ đăng ký" (Registry) ngay lập tức để Sync/Discovery không tìm lại folder cũ
      if (oldUserEmail) {
        await clearWorkspaceCache(oldUserEmail).catch(() => {});
      }
      
      // 5. Xóa các key quan trọng trong localStorage
      localStorage.removeItem(PROFILE_ROOT_KEY);
      localStorage.removeItem(LOCAL_WORKSPACE_KEY);
      localStorage.removeItem(LOCAL_PROFILES_KEY);
      if (oldUserEmail) {
        const emailSuffix = `_${encodeURIComponent(oldUserEmail.trim().toLowerCase())}`;
        localStorage.removeItem(`${PROFILE_ROOT_KEY}${emailSuffix}`);
        localStorage.removeItem(`${LOCAL_WORKSPACE_KEY}${emailSuffix}`);
        localStorage.removeItem(`${LOCAL_PROFILES_KEY}${emailSuffix}`);
        localStorage.removeItem(offlineCacheKey(LOCAL_WORKSPACE_KEY, oldUserEmail));
        localStorage.removeItem(offlineCacheKey(LOCAL_PROFILES_KEY, oldUserEmail));
      }
      // 6. Xóa Capacitor Filesystem (Offline outbox queue)
      if (supportsDurableOfflineQueue()) {
        try {
          await localSyncOutbox.clearAll();
        } catch (e) { /* ignore FS errors */ }
      }
      // 7. Quét và dọn dẹp sâu LocalStorage
      if (typeof localStorage !== 'undefined') {
        const exactKeys = new Set([
          'health_offline_workspace_v2',
          'health_offline_profiles_v2',
          'family_health_ai_digitization_logs',
        ]);
        const keyPrefixes = [
          `${LOCAL_WORKSPACE_KEY}_`,
          `${LOCAL_PROFILES_KEY}_`,
          `${PROFILE_ROOT_KEY}_`,
          'health_ocr_recovery_v1_',
          'health_pending_member_deletions_v1_',
          'health_retention_',
          'health_local_profile_',
        ];
        const keysToRemove: string[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key && (exactKeys.has(key) || keyPrefixes.some((p) => key.startsWith(p)))) {
            keysToRemove.push(key);
          }
        }
        for (const key of keysToRemove) {
          try {
            localStorage.removeItem(key);
          } catch (e) { /* ignore */ }
        }
      }
      // 8. Cập nhật UI sau khi xóa hoàn tất
      workspaceRef.current = freshWs;
      profilesRef.current = freshProf;
      setWorkspace(freshWs);
      setProfiles(freshProf);
      setProfileErrors({});
      setSelectedMemberId('');
      setRootIdInput('');
      setDigitizationDraft(null);
      setIdentityResolutionDraft(null);
      setPendingSubjectMember(null);
      setIsCreatingSubjectMember(false);
      setOcrRecoveryJobs([]);
      setPendingLocalUploadCount(0);
      setPendingUploadFiles([]);
      setUploadQueue([]);
      uploadQueueRef.current = [];
      pendingUploadIdsRef.current = [];
      setChatMessages([]);
      setChatInput('');
      digitizationLogger.clearLogs();
      setIsSyncing(false);
      discoveryAttemptedRef.current = true;
      showToast('Đã xóa sạch toàn bộ dữ liệu trên Google Drive và thiết bị thành công.', 'success');
    } catch (err) {
      console.error('[FactoryReset] Reset failed:', err);
      showToast('Đã xảy ra lỗi trong quá trình xóa dữ liệu.', 'error');
    } finally {
      isResettingRef.current = false;
      setIsLoading(false);
    }
  }
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupInFlight = useRef(false);
  const { confirm } = useConfirmDialog();
  const {
    updateInfo,
    isUpdateModalOpen,
    setIsUpdateModalOpen,
    isChecking: isCheckingUpdate,
    checkAppUpdate,
  } = useAppUpdate({
    currentVersion: appVersion,
    updateServerUrl: UPDATE_SERVER_URL,
    onNotification: showToast,
  });
  const members = prioritizeMemberForEmail(workspace?.family.members || [], userEmail);
  const offlineOwnerKey =
    userEmail?.trim().toLowerCase() ||
    (supportsDurableOfflineQueue() ? 'apk-local-device' : null);
  const canUseLocalWorkspace =
    supportsDurableOfflineQueue() &&
    workspace?.rootFolderId === 'local_offline_workspace';
  useEffect(() => {
    let cancelled = false;
    const activeWorkspace = workspaceRef.current;
    const guestLocalState = loadGuestLocalState();
    if (
      !guestLocalState ||
      !userEmail ||
      !driveAuthorized ||
      !activeWorkspace ||
      activeWorkspace.rootFolderId === 'local_offline_workspace'
    ) {
      setLocalImportAvailable(false);
      return;
    }
    const importMarker = `health_guest_imported_${encodeURIComponent(userEmail.trim().toLowerCase())}_${activeWorkspace.rootFolderId}`;
    if (localStorage.getItem(importMarker) === 'true') {
      setLocalImportAvailable(false);
      return;
    }
    const hasProfileData = Object.values(guestLocalState.profiles).some(
      (profile) => profile.timeline.length > 0 || profile.sources.length > 0,
    );
    const hasMultipleMembers = guestLocalState.workspace.family.members.length > 1;
    void localSyncOutbox.listUploads(APK_LOCAL_OWNER_KEY)
      .then((uploads) => {
        if (!cancelled) {
          setLocalImportAvailable(hasProfileData || hasMultipleMembers || uploads.length > 0);
        }
      })
      .catch((error: unknown) => {
        console.error('[Local data import] Could not inspect stored documents.', error);
        if (!cancelled) setLocalImportAvailable(hasProfileData || hasMultipleMembers);
      });
    return () => {
      cancelled = true;
    };
  }, [driveAuthorized, userEmail, workspace?.rootFolderId]);
  const isWorkspaceAdmin = Boolean(
    !workspace ||
      workspace.rootFolderId === 'local_offline_workspace' ||
      (userEmail &&
        workspace?.family.adminEmail &&
        userEmail.trim().toLowerCase() === workspace.family.adminEmail.trim().toLowerCase())
  );
  useEffect(() => {
    let active = true;
    const folderId =
      driveAuthorized && workspace && workspace.rootFolderId !== 'local_offline_workspace'
        ? workspace.rootFolderId
        : 'local_offline_workspace';
    const loading = loadSharedAiResources(folderId).then(({ keys }) => {
      if (active) setSharedGeminiKeys(keys);
    });
    trackSharedGeminiKeysLoad(loading);
    void loading.catch((error: unknown) => {
      if (!active) return;
      console.error('[AI resources] Could not load shared Gemini keys.', error);
      if (folderId !== 'local_offline_workspace') {
        showToast(
          error instanceof Error
            ? `Không tải được Tài nguyên AI: ${error.message}`
            : 'Không tải được Tài nguyên AI từ Drive.',
          'error',
        );
      }
    });
    return () => {
      active = false;
    };
  }, [driveAuthorized, showToast, workspace?.rootFolderId]);
  const selectedMember = members.find((m) => m.id === selectedMemberId) || members[0] || null;
  const selectedProfile = selectedMember ? profiles[selectedMember.id] : null;
  const trackerMember =
    members.find((member) => member.id === trackerState.memberId) || selectedMember;
  // Extract vital metrics from timeline containing abnormal measurements
  const metricOptions = useMemo(() => {
    if (!selectedProfile?.timeline) return [];
    const keys = new Set<string>();
    const gender = selectedMember?.gender;
    for (const event of selectedProfile.timeline) {
      for (const m of event.metrics) {
        const key = getHealthMetricStandardKey(m);
        if (!key) continue;
        const status = getHealthMetricRangeStatus(m, gender);
        if (status !== 'normal' && status !== 'unknown') {
          keys.add(key);
        }
      }
    }
    return Array.from(keys).map((key) => ({
      key,
      label: getHealthMetricDisplayName(key),
    }));
  }, [selectedProfile, selectedMember?.gender]);
  useEffect(() => {
    if (metricOptions.length > 0 && !metricOptions.some(({ key }) => key === selectedMetric)) {
      setSelectedMetric(metricOptions[0].key);
    }
  }, [metricOptions, selectedMetric]);
  // Chart data for chosen metric
  const chartData = useMemo(() => {
    if (!selectedProfile?.timeline || !selectedMetric) return [];
    return buildHealthMetricChartData(selectedProfile.timeline, selectedMetric);
  }, [selectedProfile, selectedMetric]);
  // Filtered timeline
  const filteredTimeline = useMemo(() => {
    if (!selectedProfile?.timeline) return [];
    const list = [...selectedProfile.timeline].sort(
      (a, b) =>
        new Date(b.date || b.recordedAt).getTime() -
        new Date(a.date || a.recordedAt).getTime(),
    );
    if (timelineFilter === 'all') return list;
    return list.filter((event) => event.type === timelineFilter);
  }, [selectedProfile, timelineFilter]);
  // Follow-up reminders belong to the member profile linked to the signed-in account.
  const upcomingFollowUps = useMemo(
    () => getFollowUpRemindersForSignedInMember(members, profiles, userEmail),
    [members, profiles, userEmail],
  );
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void scheduleFollowUpNotifications(
      upcomingFollowUps.map(({ member, event, followUpDate }) => ({
        eventId: event.id,
        eventTitle: event.title,
        followUpDate,
        memberName: member.name,
      })),
    );
  }, [upcomingFollowUps]);
  const totalTimelineEvents = useMemo(() => {
    return Object.values(profiles).reduce((sum, p) => sum + (p?.timeline?.length || 0), 0);
  }, [profiles]);
  useEffect(() => {
    try {
      clearLegacyHealthDemoData(localStorage);
    } catch (error) {
      console.warn('Không thể dọn workspace mẫu cũ khỏi thiết bị.', error);
    }
  }, []);
  useEffect(() => {
    if (!workspace) {
      setOcrRecoveryJobs([]);
      return;
    }
    try {
      setOcrRecoveryJobs(readOcrRecoveryJobs(workspace.rootFolderId));
    } catch (error) {
      console.error('[OCR recovery] Could not read local recovery metadata.', error);
      setErrorMessage(error instanceof Error ? error.message : 'Không thể khôi phục trạng thái OCR trên thiết bị.');
    }
  }, [workspace?.rootFolderId]);
  const reloadProfiles = useCallback(async (nextWorkspace: HealthDriveWorkspace) => {
    const authIdentity = authIdentityRef.current;
    if (nextWorkspace.rootFolderId === 'local_offline_workspace') {
      const localProfiles = Object.fromEntries(
        nextWorkspace.family.members.map((member) => [
          member.id,
          profilesRef.current[member.id] || createHealthProfile(member),
        ]),
      );
      profilesRef.current = localProfiles;
      setProfiles(localProfiles);
      setProfileErrors({});
      return localProfiles;
    }
    if (!authIdentity.driveAuthorized || !authIdentity.userEmail) return {};
    let activeWorkspace = nextWorkspace;
    if (supportsDurableOfflineQueue()) {
      const pendingMemberSaves = await localSyncOutbox.listMemberSaves(authIdentity.userEmail);
      for (const operation of pendingMemberSaves) {
        const assignedRootId = localStorage.getItem(
          `${PROFILE_ROOT_KEY}_${authIdentity.userEmail.trim().toLowerCase()}`,
        );
        if (
          operation.workspaceRootId !== activeWorkspace.rootFolderId &&
          (operation.workspaceRootId !== 'local_offline_workspace' || assignedRootId !== activeWorkspace.rootFolderId)
        ) continue;
        const existing = activeWorkspace.family.members.find((member) => member.id === operation.member.id) ||
          findMemberForEmail(activeWorkspace.family.members, operation.member.email);
        let updated: HealthDriveWorkspace;
        if (!existing) {
          const {
            driveFolderId: _localFolderId,
            profileFileId: _localProfileFileId,
            ...memberInput
          } = operation.member;
          updated = await addDriveFamilyMember(activeWorkspace, memberInput);
        } else {
          const memberUpdates = Object.fromEntries(
            Object.entries(operation.member).filter(([key, value]) =>
              value !== undefined &&
              key !== 'id' &&
              !(
                (key === 'driveFolderId' && typeof value === 'string' && value.startsWith('local_')) ||
                (key === 'profileFileId' && typeof value === 'string' && value.startsWith('local_'))
              ) &&
              value !== existing[key as keyof FamilyMember],
            ),
          ) as Partial<FamilyMember>;
          updated = Object.keys(memberUpdates).length > 0
            ? await updateDriveFamilyMember(activeWorkspace, existing.id, memberUpdates)
            : activeWorkspace;
        }
        const savedMember = updated.family.members.find((member) => member.id === operation.member.id) ||
          findMemberForEmail(updated.family.members, operation.member.email);
        if (!savedMember) {
          throw new Error(`Không thể xác định hồ sơ Drive cho thành viên ${operation.member.name}.`);
        }
        if (operation.profile) {
          await saveHealthProfile(savedMember.profileFileId, {
            ...operation.profile,
            member: savedMember,
          });
        }
        await localSyncOutbox.complete(authIdentity.userEmail, operation.id);
        activeWorkspace = updated;
      }
      if (activeWorkspace !== nextWorkspace) {
        workspaceRef.current = activeWorkspace;
        setWorkspace(activeWorkspace);
      }
    }
    let pendingSaves = supportsDurableOfflineQueue()
      ? await localSyncOutbox.listProfileSaves(authIdentity.userEmail)
      : [];
    let pendingSyncError = '';
    if (pendingSaves.length > 0) {
      try {
        await flushPendingHealthProfileSaves(activeWorkspace.family.members, authIdentity.userEmail);
        pendingSaves = await localSyncOutbox.listProfileSaves(authIdentity.userEmail);
      } catch (error) {
        pendingSyncError = error instanceof Error ? error.message : 'Không thể đồng bộ thay đổi đang chờ.';
        console.warn('[Drive sync] Pending profile changes remain on this device.', error);
      }
    }
    const entries = await Promise.all(
      activeWorkspace.family.members.map(async (member) => {
        const queuedForMember = (queued: PendingProfileSave) =>
          queued.profileFileId === member.profileFileId ||
          (isLocalProfileFileId(queued.profileFileId) && queued.profile.member.id === member.id) ||
          Boolean(
            isLocalProfileFileId(queued.profileFileId) &&
            queued.profile.member.email &&
            member.email &&
            queued.profile.member.email.trim().toLowerCase() === member.email.trim().toLowerCase(),
          );
        const memberPendingSaves = pendingSaves.filter(queuedForMember);
        try {
          const remote = await loadHealthProfile(member.profileFileId);
          let profile = parseHealthProfile(remote, member);
          for (const queued of memberPendingSaves) {
            profile = mergeHealthProfiles(profile, { ...queued.profile, member });
          }
          if (pendingSyncError && memberPendingSaves.length > 0) {
            profile.syncPending = true;
          }
          return [
            member.id,
            profile,
            pendingSyncError && profile.syncPending ? pendingSyncError : null,
          ] as const;
        } catch (error) {
          const cachedProfile = profilesRef.current[member.id];
          const queuedProfile = memberPendingSaves.at(-1)?.profile;
          let localProfile = cachedProfile?.member.profileFileId === member.profileFileId
            ? cachedProfile
            : queuedProfile;
          if (localProfile) {
            localProfile = { ...localProfile, member, syncPending: true };
          }
          return [
            member.id,
            localProfile || null,
            [
              error instanceof Error ? error.message : 'Không tải được hồ sơ.',
              ...(localProfile ? [pendingSyncError || 'Đang hiển thị bản cục bộ; thay đổi chưa được xác nhận trên Drive.'] : []),
            ].filter(Boolean).join(' '),
          ] as const;
        }
      })
    );
    if (
      authIdentityRef.current.userEmail !== authIdentity.userEmail ||
      !authIdentityRef.current.driveAuthorized
    ) {
      return {};
    }
    const nextProfiles: Record<string, HealthProfile> = {};
    const nextErrors: Record<string, string> = {};
    for (const [memberId, profile, error] of entries) {
      if (profile) nextProfiles[memberId] = profile;
      if (error) nextErrors[memberId] = error;
    }
    const unmatchedPendingSave = pendingSaves.find((queued) =>
      !activeWorkspace.family.members.some((member) =>
        queued.profileFileId === member.profileFileId ||
        (isLocalProfileFileId(queued.profileFileId) && queued.profile.member.id === member.id) ||
        Boolean(
          isLocalProfileFileId(queued.profileFileId) &&
          queued.profile.member.email &&
          member.email &&
          queued.profile.member.email.trim().toLowerCase() === member.email.trim().toLowerCase(),
        ),
      ),
    );
    if (pendingSyncError && unmatchedPendingSave && activeWorkspace.family.members[0]) {
      const memberId = activeWorkspace.family.members[0].id;
      nextErrors[memberId] = [
        nextErrors[memberId],
        `Có thay đổi đang chờ cho thành viên ${unmatchedPendingSave.profile.member.name}; chưa thể ánh xạ vào Workspace này.`,
      ].filter(Boolean).join(' ');
    }
    setProfiles(nextProfiles);
    setProfileErrors(nextErrors);
    const preferredMemberId =
      findMemberForEmail(activeWorkspace.family.members, authIdentityRef.current.userEmail)?.id ||
      activeWorkspace.family.members[0]?.id ||
      '';
    setSelectedMemberId((current) =>
      activeWorkspace.family.members.some((m) => m.id === current)
        ? current
        : preferredMemberId
    );
    return nextProfiles;
  }, []);
  const [isSyncing, setIsSyncing] = useState(false);
  const openWorkspace = useCallback(
    async (id: string): Promise<boolean> => {
      const authIdentity = authIdentityRef.current;
      if (!authIdentity.driveAuthorized || !authIdentity.userEmail) return false;
      setIsLoading(true);
      setErrorMessage('');
      try {
        const loaded = await openHealthWorkspace(id.trim());
        const opened = await applyPendingMemberDeletions(loaded);
        if (
          authIdentityRef.current.userEmail !== authIdentity.userEmail ||
          !authIdentityRef.current.driveAuthorized
        ) {
          return false;
        }
        if (userEmail) {
          localStorage.setItem(
            `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`,
            opened.rootFolderId
          );
        }
        localStorage.setItem(PROFILE_ROOT_KEY, opened.rootFolderId);
        workspaceRef.current = opened;
        setWorkspace(opened);
        setSelectedMemberId(
          findMemberForEmail(opened.family.members, authIdentity.userEmail)?.id ||
            opened.family.members[0]?.id ||
            '',
        );
        setRootIdInput(opened.rootFolderId);
        await reloadProfiles(opened);
        setErrorMessage('');
        showToast('Đã kết nối thư mục Google Drive thành công.', 'success');
        return true;
      } catch (error) {
        const isNotFound = error instanceof Error && /file not found|404|not found/i.test(error.message);
        if (isNotFound) {
          if (userEmail) {
            localStorage.removeItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`);
            void clearWorkspaceCache(userEmail);
          }
          localStorage.removeItem(PROFILE_ROOT_KEY);
          void unregisterHealthWorkspace(id.trim()).catch(() => {});
          setErrorMessage('');
        } else {
          setErrorMessage(
            error instanceof Error ? error.message : 'Không thể mở thư mục Drive.'
          );
        }
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [reloadProfiles, showToast, userEmail]
  );
  useEffect(() => {
    if (!driveAuthorized || !userEmail) return;
    let disposed = false;
    let handledAssignmentKey = '';
    const unsubscribe = subscribeHealthWorkspaceAssignments(
      userEmail,
      (assignment) => {
        if (!assignment || disposed) return;
        const key = `${assignment.rootFolderId}:${assignment.familyFileId}:${assignment.updatedAt}`;
        if (handledAssignmentKey === key) return;
        handledAssignmentKey = key;
        let startedSync = false;
        void (async () => {
          const current = workspaceRef.current;
          if (
            current &&
            current.rootFolderId !== 'local_offline_workspace' &&
            current.rootFolderId !== assignment.rootFolderId
          ) {
            const shouldSwitch = await confirm({
              title: 'Có lời mời Workspace mới',
              message: `Tài khoản ${userEmail} được mời vào một Workspace khác. Bạn có muốn chuyển sang Workspace đó không?`,
              confirmLabel: 'Mở Workspace',
            });
            if (!shouldSwitch) return;
          } else if (
            current?.rootFolderId === assignment.rootFolderId &&
            current.familyFileId === assignment.familyFileId
          ) {
            return;
          }
          setIsSyncing(true);
          startedSync = true;
          const loaded = await openAssignedHealthWorkspace(assignment, userEmail);
          const opened = await applyPendingMemberDeletions(loaded);
          if (
            disposed ||
            authIdentityRef.current.userEmail !== userEmail ||
            !authIdentityRef.current.driveAuthorized
          ) return;
          localStorage.setItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`, opened.rootFolderId);
          localStorage.setItem(PROFILE_ROOT_KEY, opened.rootFolderId);
          workspaceRef.current = opened;
          setWorkspace(opened);
          setSelectedMemberId(
            findMemberForEmail(opened.family.members, userEmail)?.id ||
              opened.family.members[0]?.id ||
              '',
          );
          setRootIdInput(opened.rootFolderId);
          await reloadProfiles(opened);
          showToast('Workspace được liên kết hoặc cập nhật tự động từ Firestore.', 'success');
        })()
          .catch((error: unknown) => {
            if (disposed) return;
            const message = error instanceof Error
              ? error.message
              : 'Không thể mở Workspace được chia sẻ.';
            setErrorMessage(message);
            showToast(message, 'error');
          })
          .finally(() => {
            if (!disposed && startedSync) setIsSyncing(false);
          });
      },
      (error) => {
        if (disposed) return;
        setErrorMessage(error.message);
        showToast(error.message, 'error');
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [confirm, driveAuthorized, reloadProfiles, showToast, userEmail]);
  const syncStatus = useMemo(() => {
    if (isSyncing) return 'syncing';
    if (isLoading || isUploading || isSummarizing || isRefining) return 'busy';
    if (pendingLocalUploadCount > 0 || Object.values(profiles).some((profile) => profile.syncPending)) {
      return 'pending';
    }
    if (!driveAuthorized) {
      return userEmail ? 'drive_expired' : 'offline';
    }
    if (!workspace || workspace.rootFolderId === 'local_offline_workspace') return 'unlinked';
    return 'online';
  }, [driveAuthorized, isSyncing, isLoading, isUploading, isSummarizing, isRefining, pendingLocalUploadCount, profiles, workspace, userEmail]);
  // Auto-connect to Drive Workspace on login
  useEffect(() => {
    if (!driveAuthorized || !userEmail || isResettingRef.current || cacheOwnerEmail !== normalizedUserEmail) return;
    const shouldRefreshCachedWorkspace = shouldRefreshCachedWorkspaceRef.current;
    
    // Skip if already connected (unless force refresh) or if we already tried discovery and failed
    if (
      workspace &&
      workspace.rootFolderId !== 'local_offline_workspace' &&
      !shouldRefreshCachedWorkspace
    ) return;
    
    if (!workspace && discoveryAttemptedRef.current && !shouldRefreshCachedWorkspace) return;
    shouldRefreshCachedWorkspaceRef.current = false;
    let cancelled = false;
    setIsSyncing(true);
    const savedRootId = localStorage.getItem(
      `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`
    );
    async function autoConnectDriveWorkspace() {
      try {
        if (savedRootId) {
          try {
            const loaded = await openHealthWorkspace(savedRootId.trim());
            const opened = await applyPendingMemberDeletions(loaded);
            if (!cancelled) {
              setWorkspace(opened);
              setSelectedMemberId(
                findMemberForEmail(opened.family.members, userEmail)?.id ||
                  opened.family.members[0]?.id ||
                  '',
              );
              setRootIdInput(opened.rootFolderId);
              setIsSyncing(false);
              await reloadProfiles(opened);
              showToast('Đã kết nối và đồng bộ 2 chiều dữ liệu từ Google Drive.', 'success');
              return;
            }
          } catch (savedError) {
            console.warn('[Auto-Connect] Saved root folder failed, searching Drive...', savedError);
            const savedMsg = savedError instanceof Error ? savedError.message : '';
            if (/file not found|\b404\b|not found|không tìm thấy kho dữ liệu|không tìm thấy (?:file )?family\.json|không còn trong danh sách/i.test(savedMsg)) {
              localStorage.removeItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`);
            }
          }
        }
        const assignmentPromise = readHealthWorkspaceAssignment(userEmail).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const assignmentResult = await assignmentPromise;
        const assignment = 'value' in assignmentResult ? assignmentResult.value : null;
        if ('error' in assignmentResult) {
          const message = assignmentResult.error instanceof Error
            ? assignmentResult.error.message
            : 'Không thể kiểm tra lời mời Workspace.';
          setErrorMessage(message);
          showToast(message, 'error');
        }
        if (cancelled) return;
        if (assignment) {
          try {
            const loaded = await openAssignedHealthWorkspace(assignment, userEmail);
            const opened = await applyPendingMemberDeletions(loaded);
            if (!cancelled) {
              localStorage.setItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`, opened.rootFolderId);
              setWorkspace(opened);
              setSelectedMemberId(
                findMemberForEmail(opened.family.members, userEmail)?.id ||
                  opened.family.members[0]?.id ||
                  '',
              );
              setRootIdInput(opened.rootFolderId);
              setIsSyncing(false);
              await reloadProfiles(opened);
              showToast('Đã mở không gian gia đình được chia sẻ từ Google Drive.', 'success');
              return;
            }
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : 'Không thể xác minh hoặc mở thư mục được chia sẻ.';
            const isNotFound = /file not found|404|not found/i.test(message);
            const isForbidden = /forbidden|403|permission/i.test(message);
            
            if (isNotFound) {
              setErrorMessage(`Chưa liên kết được thư mục của Admin (ID: ${assignment.rootFolderId}). Hãy kiểm tra xem bạn đã thấy thư mục này trong mục "Được chia sẻ với tôi" trên Google Drive chưa. Nếu chưa, hãy nhờ Admin bấm "Đồng bộ quyền truy cập" trong mục Gia đình.`);
            } else if (isForbidden) {
              setErrorMessage('Bạn không có quyền truy cập thư mục này. Hãy nhờ Admin cấp lại quyền cho email của bạn.');
            } else {
              setErrorMessage(`Lỗi liên kết: ${message}`);
            }
            showToast(message, 'error');
            setIsSyncing(false);
            return;
          }
        }
        if (discoveryAttemptedRef.current && !shouldRefreshCachedWorkspace) {
          setIsSyncing(false);
          return;
        }
        // Tự động tìm kiếm thư mục Sức khỏe Gia đình đã có trên Drive của tài khoản
        discoveryAttemptedRef.current = true;
        const loaded = await findExistingHealthWorkspace();
        const discovered = loaded
          ? await applyPendingMemberDeletions(loaded)
          : null;
        
        if (!cancelled && discovered) {
          localStorage.setItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`, discovered.rootFolderId);
          setWorkspace(discovered);
          setSelectedMemberId(
            findMemberForEmail(discovered.family.members, userEmail)?.id ||
              discovered.family.members[0]?.id ||
              '',
          );
          setRootIdInput(discovered.rootFolderId);
          setIsSyncing(false);
          void reloadProfiles(discovered)
            .then((loadedProfiles) => {
              const totalEvents = Object.values(loadedProfiles).reduce(
                (sum, profile) => sum + (profile.timeline?.length || 0),
                0,
              );
              showToast(
                `Đã tự động kết nối thư mục "Suc khoe gia dinh" trên Drive (${discovered.family.members.length} thành viên, ${totalEvents} hồ sơ).`,
                'success',
              );
            })
            .catch((error: unknown) => {
              console.error('[Auto-Connect] Could not load Drive profiles.', error);
              const message = error instanceof Error
                ? error.message
                : 'Không thể tải hồ sơ sức khỏe từ Google Drive.';
              setErrorMessage(message);
              showToast(message, 'error');
            });
        } else if (!cancelled) {
          // Không tìm thấy lời mời hay thư mục Drive cũ: trạng thái sạch, không báo lỗi giả
          if (!assignment && !('error' in assignmentResult)) {
            setErrorMessage('');
          }
          setIsSyncing(false);
        }
      } catch (err) {
        console.warn('[Auto-Connect Error]:', err);
        if (!cancelled) {
          const message = err instanceof Error
            ? err.message
            : 'Không thể tìm hoặc mở thư mục Sức khỏe Gia đình trên Google Drive.';
          setErrorMessage(message);
          showToast(message, 'error');
        }
      } finally {
        if (!cancelled) setIsSyncing(false);
      }
    }
    void autoConnectDriveWorkspace();
    return () => {
      cancelled = true;
      setIsSyncing(false);
    };
  }, [cacheOwnerEmail, driveAuthorized, normalizedUserEmail, reloadProfiles, showToast, userEmail, workspace?.rootFolderId]);
  // Clean expired raw files (>3 years) automatically
  useEffect(() => {
    if (!workspace || !driveAuthorized || cleanupInFlight.current) return;
    const lastRun = localStorage.getItem(`health_retention_${workspace.rootFolderId}`);
    const today = new Date().toISOString().slice(0, 10);
    if (lastRun === today) return;
    cleanupInFlight.current = true;
    void cleanupExpiredRawFiles(workspace)
      .then(async (result) => {
        localStorage.setItem(`health_retention_${workspace.rootFolderId}`, today);
        if (result.deleted) {
          showToast(`Đã dọn dẹp ${result.deleted} tệp y tế gốc đã số hóa quá 3 năm.`, 'info');
          await reloadProfiles(workspace);
        }
      })
      .catch((error: unknown) => {
        console.warn('Lỗi dọn dẹp tệp cũ:', error);
      })
      .finally(() => {
        cleanupInFlight.current = false;
      });
  }, [driveAuthorized, reloadProfiles, showToast, workspace]);
  // Workspace assignments reload
  const workspaceRootFolderId = workspace?.rootFolderId;
  const workspaceFamilyFileId = workspace?.familyFileId;
  const reloadWorkspaceAssignments = useCallback(async () => {
    if (
      !driveAuthorized ||
      !userEmail ||
      !workspaceRootFolderId ||
      workspaceRootFolderId === 'local_offline_workspace' ||
      !workspaceFamilyFileId ||
      !isWorkspaceAdmin
    ) return;
    try {
      const activeWorkspace = workspaceRef.current;
      if (!activeWorkspace ||
          activeWorkspace.rootFolderId !== workspaceRootFolderId ||
          activeWorkspace.familyFileId !== workspaceFamilyFileId) return;
      let assignments = await listHealthWorkspaceAssignments(workspaceRootFolderId);
      const adminRecord = assignments.find(
        (assignment) =>
          assignment.memberEmail.trim().toLowerCase() === activeWorkspace.family.adminEmail.trim().toLowerCase() &&
          assignment.role === 'ADMIN',
      );
      if (!adminRecord?.migrationComplete) {
        await syncHealthWorkspaceMemberAssignments(activeWorkspace);
        assignments = await listHealthWorkspaceAssignments(workspaceRootFolderId);
      }
      setWorkspaceAssignments(assignments);
    } catch (error) {
      console.warn('Lỗi tải quyền chia sẻ:', error);
      setErrorMessage(error instanceof Error ? error.message : 'Không thể đồng bộ quyền chia sẻ Workspace.');
    }
  }, [driveAuthorized, isWorkspaceAdmin, userEmail, workspaceFamilyFileId, workspaceRootFolderId]);
  useEffect(() => {
    void reloadWorkspaceAssignments();
  }, [reloadWorkspaceAssignments]);
  async function recoverCommittedWorkspaceSharingError(error: unknown): Promise<string | null> {
    if (!(error instanceof WorkspaceSharingSyncError)) return null;
    const updatedWorkspace = error.workspace;
    workspaceRef.current = updatedWorkspace;
    setWorkspace(updatedWorkspace);
    if (!updatedWorkspace.family.members.some((member) => member.id === selectedMemberId)) {
      setSelectedMemberId(updatedWorkspace.family.members[0]?.id || '');
    }
    if (editingMember && !updatedWorkspace.family.members.some((member) => member.id === editingMember.id)) {
      setEditingMember(null);
    }
    try {
      const loadedProfiles = await reloadProfiles(updatedWorkspace);
      profilesRef.current = loadedProfiles;
      setProfiles(loadedProfiles);
      return error.message;
    } catch (refreshError) {
      const reason = refreshError instanceof Error ? refreshError.message : 'Không thể tải lại hồ sơ.';
      return `${error.message} Làm mới dữ liệu cũng thất bại: ${reason}`;
    }
  }
  async function importGuestLocalDataToDrive() {
    const sourceState = loadGuestLocalState();
    const destination = workspaceRef.current;
    if (!sourceState || !userEmail || !driveAuthorized || !destination ||
        destination.rootFolderId === 'local_offline_workspace') {
      showToast('Hãy kết nối Google Drive và mở kho đích trước khi sao chép dữ liệu.', 'error');
      return;
    }
    const confirmed = await confirm({
      title: 'Sao chép dữ liệu trên thiết bị lên Drive?',
      message: `Hồ sơ và tài liệu cục bộ sẽ được sao chép vào kho Drive ${destination.rootFolderId} của ${userEmail}. Bản cục bộ vẫn được giữ trên thiết bị; dữ liệu y tế sẽ được tải lên Google Drive.`,
      confirmLabel: 'Sao chép lên Drive',
      cancelLabel: 'Để sau',
    });
    if (!confirmed) return;
    setIsImportingLocalData(true);
    setErrorMessage('');
    try {
      let nextWorkspace = destination;
      const uploads = await localSyncOutbox.listUploads(APK_LOCAL_OWNER_KEY);
      const uploadsById = new Map(uploads.map((operation) => [operation.id, operation]));
      const nextProfiles = { ...profilesRef.current };
      for (const localMember of sourceState.workspace.family.members) {
        const existingMember =
          nextWorkspace.family.members.find(
            (member) =>
              member.name.trim().toLocaleLowerCase() === localMember.name.trim().toLocaleLowerCase() ||
              Boolean(
                member.email &&
                  localMember.email &&
                  member.email.trim().toLowerCase() === localMember.email.trim().toLowerCase(),
              ),
          );
        let targetMember = existingMember;
        if (!targetMember) {
          const {
            id: localMemberId,
            driveFolderId: _localFolderId,
            profileFileId: _localProfileFileId,
            ...memberInput
          } = localMember;
          const memberId = nextWorkspace.family.members.some((member) => member.id === localMemberId)
            ? `member_${crypto.randomUUID().slice(0, 12)}`
            : localMemberId;
          nextWorkspace = await addDriveFamilyMember(nextWorkspace, { ...memberInput, id: memberId });
          targetMember = nextWorkspace.family.members.find((member) => member.id === memberId);
          if (!targetMember) {
            throw new Error(`Không thể tạo hồ sơ Drive cho ${localMember.name}.`);
          }
          workspaceRef.current = nextWorkspace;
          setWorkspace(nextWorkspace);
        }
        const localProfile = sourceState.profiles[localMember.id] || createHealthProfile(localMember);
        const sourceIdMap = new Map<string, string>();
        const importedSources: HealthSource[] = [];
        for (const source of localProfile.sources) {
          if (!source.driveFileId.startsWith('local_file_')) {
            importedSources.push(source);
            sourceIdMap.set(source.driveFileId, source.driveFileId);
            continue;
          }
          const uploadId = source.driveFileId.slice('local_file_'.length);
          const operation = uploadsById.get(uploadId) ||
            await localSyncOutbox.getUpload(APK_LOCAL_OWNER_KEY, uploadId);
          if (!operation) {
            throw new Error(`Không tìm thấy tệp gốc "${source.fileName}" trên thiết bị.`);
          }
          let uploaded = operation.workspaceRootId === nextWorkspace.rootFolderId
            ? operation.uploadedFile
            : undefined;
          if (!uploaded) {
            const file = await fileFromPendingUpload(operation);
            uploaded = await uploadRawHealthFile(targetMember, file);
            await localSyncOutbox.setUploadedFile(operation, uploaded, nextWorkspace.rootFolderId);
          }
          sourceIdMap.set(source.driveFileId, uploaded.id);
          importedSources.push({
            ...source,
            driveFileId: uploaded.id,
            fileName: uploaded.name,
            mimeType: uploaded.mimeType,
            uploadedAt: uploaded.createdTime,
          });
        }
        const importedProfile: HealthProfile = {
          ...localProfile,
          member: targetMember,
          sources: importedSources,
          timeline: localProfile.timeline.map((event) => ({
            ...event,
            sourceFileId: sourceIdMap.get(event.sourceFileId) || event.sourceFileId,
          })),
        };
        let remoteProfile = nextProfiles[targetMember.id];
        if (!remoteProfile) {
          remoteProfile = existingMember
            ? parseHealthProfile(await loadHealthProfile(targetMember.profileFileId), targetMember)
            : createHealthProfile(targetMember);
        }
        const savedProfile = await saveHealthProfile(
          targetMember.profileFileId,
          mergeHealthProfiles(remoteProfile, importedProfile),
        );
        nextProfiles[targetMember.id] = savedProfile;
        profilesRef.current = nextProfiles;
        setProfiles({ ...nextProfiles });
      }
      workspaceRef.current = nextWorkspace;
      setWorkspace(nextWorkspace);
      localStorage.setItem(
        `health_guest_imported_${encodeURIComponent(userEmail.trim().toLowerCase())}_${nextWorkspace.rootFolderId}`,
        'true',
      );
      setLocalImportAvailable(false);
      showToast('Đã sao chép hồ sơ và tài liệu cục bộ lên Google Drive. Bản trên thiết bị vẫn được giữ lại.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể sao chép dữ liệu cục bộ lên Google Drive.';
      setErrorMessage(message);
      showToast(`Sao chép chưa hoàn tất; dữ liệu gốc vẫn được giữ trên thiết bị. ${message}`, 'error');
    } finally {
      setIsImportingLocalData(false);
    }
  }
  async function handleCreateWorkspace() {
    if (!driveAuthorized) {
      onConnectDrive();
      return;
    }
    if (isCreatingWorkspaceRef.current) {
      return;
    }
    isCreatingWorkspaceRef.current = true;
    setIsLoading(true);
    setErrorMessage('');
    try {
      let created = await createHealthWorkspace(userEmail || '', userName);
      const previousWorkspace = workspaceRef.current;
      const localProfiles = profilesRef.current;
      if (previousWorkspace?.rootFolderId === 'local_offline_workspace') {
        if (supportsDurableOfflineQueue() && offlineOwnerKey && userEmail) {
          for (const member of previousWorkspace.family.members) {
            await localSyncOutbox.enqueueMemberSave(
              offlineOwnerKey,
              created.rootFolderId,
              member,
              localProfiles[member.id] || profiles[member.id],
              true,
            );
          }
        } else {
          for (const localMember of previousWorkspace.family.members) {
            const existing = created.family.members.find((member) => member.id === localMember.id) ||
              findMemberForEmail(created.family.members, localMember.email);
            if (!existing) {
              const {
                driveFolderId: _localFolderId,
                profileFileId: _localProfileFileId,
                ...memberInput
              } = localMember;
              created = await addDriveFamilyMember(created, memberInput);
            } else {
              const updates = Object.fromEntries(
                Object.entries(localMember).filter(([key, value]) =>
                  value !== undefined &&
                  key !== 'id' &&
                  !(
                    (key === 'driveFolderId' && typeof value === 'string' && value.startsWith('local_')) ||
                    (key === 'profileFileId' && typeof value === 'string' && value.startsWith('local_'))
                  ) &&
                  value !== existing[key as keyof FamilyMember],
                ),
              ) as Partial<FamilyMember>;
              if (Object.keys(updates).length > 0) {
                created = await updateDriveFamilyMember(created, existing.id, updates);
              }
            }
            const savedMember = created.family.members.find((member) => member.id === localMember.id) ||
              findMemberForEmail(created.family.members, localMember.email);
            const profile = localProfiles[localMember.id] || profiles[localMember.id];
            if (savedMember && profile) {
              await saveHealthProfile(savedMember.profileFileId, { ...profile, member: savedMember });
            }
          }
        }
      }
      localStorage.setItem(
        `${PROFILE_ROOT_KEY}_${userEmail?.trim().toLowerCase()}`,
        created.rootFolderId
      );
      workspaceRef.current = created;
      setWorkspace(created);
      setRootIdInput(created.rootFolderId);
      await reloadProfiles(created); // Tải hồ sơ vừa tạo
      showToast('Đã tạo thư mục Suc khoe gia dinh trên Google Drive!', 'success');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể tạo thư mục gia đình.'
      );
    } finally {
      setIsLoading(false);
      isCreatingWorkspaceRef.current = false;
    }
  }
  async function handleAddMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !newMemberName.trim()) return;
    setIsAddingMember(true);
    setErrorMessage('');
    try {
      let isoBirthDate: string | undefined = undefined;
      const rawDate = newMemberBirthDate.trim();
      if (rawDate) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
          isoBirthDate = rawDate;
        } else if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(rawDate)) {
          const [d, m, y] = rawDate.split(/[/.-]/);
          isoBirthDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        } else {
          isoBirthDate = rawDate;
        }
      }
      const memberId = `member_${crypto.randomUUID().slice(0, 12)}`;
      const memberInput = {
        id: memberId,
        name: newMemberName.trim(),
        birthDate: isoBirthDate,
        gender: newMemberGender,
        role: 'other',
        email: newMemberEmail.trim().toLowerCase() || undefined,
      };
      if (
        !driveAuthorized ||
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        workspace.rootFolderId === 'local_offline_workspace'
      ) {
        if (!supportsDurableOfflineQueue() || !offlineOwnerKey) {
          throw new Error('Không thể lưu yêu cầu thêm thành viên ngoại tuyến trên trình duyệt này.');
        }
        const localMember: FamilyMember = {
          ...memberInput,
          driveFolderId: `local_folder_${memberId}`,
          profileFileId: `local_profile_${memberId}`,
        };
        const localProfile = { ...createHealthProfile(localMember), syncPending: true };
        await localSyncOutbox.enqueueMemberSave(
          offlineOwnerKey,
          workspace.rootFolderId,
          localMember,
          localProfile,
          true,
        );
        const next: HealthDriveWorkspace = {
          ...workspace,
          family: {
            ...workspace.family,
            members: [...workspace.family.members, localMember],
            updatedAt: new Date().toISOString(),
          },
        };
        workspaceRef.current = next;
        setWorkspace(next);
        setProfiles((previous) => ({ ...previous, [memberId]: localProfile }));
        setNewMemberName('');
        setNewMemberBirthDate('');
        setNewMemberGender('male');
        setNewMemberEmail('');
        setSelectedMemberId(memberId);
        setActiveTab('timeline');
        showToast(`Đã lưu hồ sơ ${localMember.name} trên thiết bị; sẽ tạo hồ sơ Drive khi kết nối.`, 'info');
        return;
      }
      const next = await addDriveFamilyMember(workspace, {
        ...memberInput,
      });
      workspaceRef.current = next;
      setWorkspace(next);
      setNewMemberName('');
      setNewMemberBirthDate('');
      setNewMemberGender('male');
      setNewMemberEmail('');
      await reloadProfiles(next);
      setSelectedMemberId(memberId);
      setActiveTab('timeline');
      showToast(`Đã thêm thành viên ${newMemberName.trim()} vào hồ sơ gia đình.`, 'success');
    } catch (error) {
      const recoveryMessage = await recoverCommittedWorkspaceSharingError(error);
      setErrorMessage(
        recoveryMessage ||
          (error instanceof Error ? error.message : 'Không thể thêm thành viên.'),
      );
    } finally {
      setIsAddingMember(false);
    }
  }
  async function handleQuickAddMember(name: string): Promise<string> {
    if (!workspace || !name.trim()) throw new Error('Cần nhập tên thành viên.');
    setIsAddingMember(true);
    try {
      const memberId = `member_${crypto.randomUUID().slice(0, 12)}`;
      if (
        !driveAuthorized ||
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        workspace.rootFolderId === 'local_offline_workspace'
      ) {
        if (!supportsDurableOfflineQueue() || !offlineOwnerKey) {
          throw new Error('Không thể lưu yêu cầu thêm thành viên ngoại tuyến trên trình duyệt này.');
        }
        const localMember: FamilyMember = {
          id: memberId,
          name: name.trim(),
          role: 'other',
          driveFolderId: `local_folder_${memberId}`,
          profileFileId: `local_profile_${memberId}`,
        };
        const localProfile = { ...createHealthProfile(localMember), syncPending: true };
        await localSyncOutbox.enqueueMemberSave(
          offlineOwnerKey,
          workspace.rootFolderId,
          localMember,
          localProfile,
          true,
        );
        const next: HealthDriveWorkspace = {
          ...workspace,
          family: {
            ...workspace.family,
            members: [...workspace.family.members, localMember],
            updatedAt: new Date().toISOString(),
          },
        };
        workspaceRef.current = next;
        setWorkspace(next);
        setProfiles((previous) => ({ ...previous, [memberId]: localProfile }));
        showToast(`Đã lưu hồ sơ ${localMember.name} trên thiết bị; sẽ tạo hồ sơ Drive khi kết nối.`, 'info');
        return memberId;
      }
      const next = await addDriveFamilyMember(workspace, {
        id: memberId,
        name: name.trim(),
        role: 'other',
      });
      workspaceRef.current = next;
      setWorkspace(next);
      await reloadProfiles(next);
      showToast(`Đã thêm thành viên ${name.trim()}.`, 'success');
      return memberId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Không thể thêm thành viên.';
      showToast(msg, 'error');
      throw error;
    } finally {
      setIsAddingMember(false);
    }
  }
  async function handleSaveMember(updates: EditableFamilyMember) {
    if (!workspace || !editingMember) return;
    if (!isWorkspaceAdmin) {
      showToast('Chỉ Quản trị viên mới có quyền sửa thông tin thành viên.', 'error');
      setEditingMember(null);
      return;
    }
    const name = updates.name.trim();
    if (!name) {
      showToast('Họ tên thành viên không được để trống.', 'error');
      return;
    }
    const duplicate = workspace.family.members.some(
      (member) =>
        member.id !== editingMember.id &&
        member.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) {
      showToast('Tên thành viên này đã có trong gia đình.', 'error');
      return;
    }
    if (updates.birthDate) {
      const parsedDate = new Date(`${updates.birthDate}T00:00:00`);
      if (!Number.isFinite(parsedDate.getTime()) || parsedDate > new Date()) {
        showToast('Ngày sinh không hợp lệ hoặc nằm trong tương lai.', 'error');
        return;
      }
    }
    setIsSavingMember(true);
    setErrorMessage('');
    try {
      if (
        !driveAuthorized ||
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        workspace.rootFolderId === 'local_offline_workspace'
      ) {
        if (!supportsDurableOfflineQueue() || !offlineOwnerKey) {
          throw new Error('Không thể lưu chỉnh sửa ngoại tuyến trên trình duyệt này.');
        }
        const updatedMember = { ...editingMember, ...updates, name };
        const currentProfile = profilesRef.current[editingMember.id] || profiles[editingMember.id];
        const updatedProfile = currentProfile
          ? {
              ...currentProfile,
              member: updatedMember,
              updatedAt: new Date().toISOString(),
              syncPending: true,
            }
          : undefined;
        await localSyncOutbox.enqueueMemberSave(
          offlineOwnerKey,
          workspace.rootFolderId,
          updatedMember,
          updatedProfile,
          false,
        );
        const next: HealthDriveWorkspace = {
          ...workspace,
          family: {
            ...workspace.family,
            members: workspace.family.members.map((member) =>
              member.id === editingMember.id ? updatedMember : member,
            ),
            updatedAt: new Date().toISOString(),
          },
        };
        workspaceRef.current = next;
        setWorkspace(next);
        if (updatedProfile) {
          profilesRef.current = { ...profilesRef.current, [editingMember.id]: updatedProfile };
          setProfiles((previous) => ({ ...previous, [editingMember.id]: updatedProfile }));
        }
        setEditingMember(null);
        showToast(`Đã lưu chỉnh sửa hồ sơ ${name} trên thiết bị; sẽ đồng bộ khi Drive có thể truy cập.`, 'info');
        return;
      }
      const next = await updateDriveFamilyMember(workspace, editingMember.id, {
        ...updates,
        name,
      });
      workspaceRef.current = next;
      setWorkspace(next);
      const loaded = await reloadProfiles(next);
      profilesRef.current = loaded;
      showToast(`Đã cập nhật thông tin thành viên ${name}.`, 'success');
      setEditingMember(null);
    } catch (error) {
      const recoveryMessage = await recoverCommittedWorkspaceSharingError(error);
      const message = recoveryMessage ||
        (error instanceof Error ? error.message : 'Không thể cập nhật thành viên.');
      setErrorMessage(message);
      showToast(message, 'error');
    } finally {
      setIsSavingMember(false);
    }
  }

  async function handleDeleteFamilyMember(member: FamilyMember) {
    if (!workspace) return;
    const normalizeEmail = (email?: string | null) => email?.trim().toLowerCase() || '';
    const currentEmail = normalizeEmail(userEmail || getSignedInGoogleEmail());
    const adminEmail = normalizeEmail(workspace.family.adminEmail);
    const memberEmail = normalizeEmail(member.email);
    const isSelf = Boolean(currentEmail && memberEmail === currentEmail);

    if (!isWorkspaceAdmin && !isSelf) {
      showToast('Bạn chỉ có quyền xóa hồ sơ của chính mình. Chỉ Quản trị viên mới có quyền xóa hồ sơ của thành viên khác.', 'error');
      return;
    }
    const isAdminProfile = Boolean(adminEmail && memberEmail === adminEmail);
    if (isAdminProfile) {
      showToast('Không thể xóa hồ sơ Admin khỏi Workspace.', 'error');
      return;
    }
    const isLocalWorkspace = workspace.rootFolderId === 'local_offline_workspace';
    const isUnsyncedMember =
      member.driveFolderId.startsWith('local_folder_') &&
      member.profileFileId.startsWith('local_profile_');
    const canSyncRemote = driveAuthorized && (
      typeof navigator === 'undefined' || navigator.onLine
    );
    const confirmed = await confirm({
      title: isSelf && !isWorkspaceAdmin ? `Xóa vĩnh viễn hồ sơ của bạn?` : `Xóa vĩnh viễn hồ sơ của ${member.name}?`,
      message: isSelf && !isWorkspaceAdmin
        ? `Thư mục tài liệu gốc (ảnh, PDF) và file hồ sơ JSON của bạn sẽ bị xóa vĩnh viễn khỏi Google Drive. Bạn sẽ rời khỏi không gian gia đình này. Hồ sơ của các thành viên khác vẫn được giữ nguyên. Không thể hoàn tác.`
        : `Thành viên sẽ bị gỡ khỏi Workspace, xóa lời mời và quyền Drive, đồng thời xóa hồ sơ JSON và toàn bộ tài liệu Drive. Thành viên sẽ không thể liên kết lại Workspace này. Không thể hoàn tác.${!canSyncRemote && !isLocalWorkspace ? ' Yêu cầu sẽ được lưu trên thiết bị và thực hiện khi có mạng.' : ''}`,
      confirmLabel: isSelf && !isWorkspaceAdmin ? 'Xóa hồ sơ của tôi' : 'Xóa vĩnh viễn',
    });
    if (!confirmed) return;
    setIsLoading(true);
    setErrorMessage('');
    try {
      let next: HealthDriveWorkspace;
      let deletionQueuedForSync = false;
      const queueForSync = () => {
        queueMemberDeletion(workspace.rootFolderId, {
          memberId: member.id,
          email: member.email,
          queuedAt: Date.now(),
        });
        deletionQueuedForSync = true;
        return {
          ...workspace,
          family: {
            ...workspace.family,
            members: workspace.family.members.filter((item) => item.id !== member.id),
            updatedAt: new Date().toISOString(),
          },
        };
      };
      if (isLocalWorkspace || isUnsyncedMember) {
        next = {
          ...workspace,
          family: {
            ...workspace.family,
            members: workspace.family.members.filter((item) => item.id !== member.id),
            updatedAt: new Date().toISOString(),
          },
        };
      } else if (canSyncRemote) {
        try {
          const result = await deleteDriveFamilyMember(workspace, member.id);
          next = result.workspace;
        } catch (error) {
          if (!isNetworkUnavailableError(error)) throw error;
          next = queueForSync();
        }
      } else {
        next = queueForSync();
      }
      if (supportsDurableOfflineQueue() && offlineOwnerKey) {
        await localSyncOutbox.discardMemberOperations(
          offlineOwnerKey,
          member.id,
          workspace.rootFolderId,
          member.profileFileId,
        );
      }
      for (const source of profiles[member.id]?.sources || []) {
        forgetOcrRecoveryJob(source.driveFileId);
      }
      workspaceRef.current = next;
      setWorkspace(next);
      setProfiles((previous) => {
        const { [member.id]: _deletedProfile, ...remaining } = previous;
        return remaining;
      });
      setProfileErrors((previous) => {
        const { [member.id]: _deletedError, ...remaining } = previous;
        return remaining;
      });

      if (isSelf && !isWorkspaceAdmin) {
        const freshWs = createDefaultLocalWorkspace(userEmail);
        workspaceRef.current = freshWs;
        setWorkspace(freshWs);
        setProfiles({});
        setSelectedMemberId('');
        setChatMessages([]);
        setActiveTab('overview');
        if (userEmail) {
          await clearWorkspaceCache(userEmail).catch(() => {});
        }
        showToast('Đã xóa thành công hồ sơ cá nhân của bạn và rời khỏi không gian gia đình.', 'success');
        return;
      }

      setSelectedMemberId(next.family.members[0]?.id || '');
      setChatMessages([]);
      setActiveTab(next.family.members.length ? 'family' : 'overview');
      showToast(
        isLocalWorkspace || isUnsyncedMember
          ? `Đã xóa hồ sơ ${member.name} trên thiết bị này.`
          : canSyncRemote && !deletionQueuedForSync
            ? `Đã xóa thành viên ${member.name}, dữ liệu Drive và quyền truy cập liên quan.`
            : `Đã xóa ${member.name} khỏi danh sách trên thiết bị. Việc xóa Drive và thu hồi quyền sẽ hoàn tất khi có mạng.`,
        (canSyncRemote && !deletionQueuedForSync) || isLocalWorkspace || isUnsyncedMember ? 'success' : 'info',
      );
    } catch (error) {
      const recoveryMessage = await recoverCommittedWorkspaceSharingError(error);
      setErrorMessage(
        recoveryMessage ||
          (error instanceof Error ? error.message : 'Không thể xóa thành viên.'),
      );
    } finally {
      setIsLoading(false);
    }
  }
  async function handleRecreateMemberProfile(memberId: string) {
    if (!workspace || workspace.rootFolderId === 'local_offline_workspace') return;
    setIsLoading(true);
    showToast('Đang khởi tạo lại tệp hồ sơ trên Google Drive...', 'info');
    try {
      const updated = await recreateDriveMemberProfile(workspace, memberId);
      workspaceRef.current = updated;
      setWorkspace(updated);
      await reloadProfiles(updated);
      setProfileErrors((prev) => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
      showToast('Đã khởi tạo lại tệp hồ sơ thành công trên Google Drive.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể khởi tạo lại tệp hồ sơ.', 'error');
    } finally {
      setIsLoading(false);
    }
  }
  async function handleCleanupDriveDuplicates() {
    if (!workspace || !driveAuthorized) return;
    const confirmed = await confirm({
      title: 'Quét & Dọn dẹp tệp trùng trên Google Drive?',
      message: 'Hệ thống sẽ tự động tìm kiếm toàn bộ các tệp tin trùng lặp trong thư mục Drive của từng thành viên gia đình, giữ lại tệp gốc cũ nhất và xóa sạch các bản sao dư thừa để giải phóng dung lượng.',
      confirmLabel: 'Quét & Dọn dẹp ngay',
    });
    if (!confirmed) return;
    setIsLoading(true);
    showToast('Đang quét và xóa các tệp trùng lặp trên Google Drive...', 'info');
    try {
      const result = await cleanupDuplicateRawFilesOnDrive(workspace);
      if (result.deletedFilesCount > 0) {
        const mbFreed = (result.freedSpaceBytes / (1024 * 1024)).toFixed(1);
        showToast(
          `Đã dọn dẹp thành công ${result.deletedFilesCount} tệp trùng lặp trên Google Drive (giải phóng ~${mbFreed} MB)!`,
          'success'
        );
        if (workspace) await reloadProfiles(workspace);
      } else {
        showToast('Thư mục Google Drive của bạn đã sạch sẽ, không phát hiện tệp trùng lặp.', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Lỗi khi dọn dẹp tệp trùng trên Google Drive.', 'error');
    } finally {
      setIsLoading(false);
    }
  }
  async function beginDigitization(
    file: File,
    options?: {
      forceUpload?: boolean;
      memberId?: string;
      pendingUploadId?: string;
      uploadedFile?: PendingUpload['uploadedFile'];
      queueContext?: QueueItemContext;
    },
  ) {
    const pendingUploadId = options?.pendingUploadId;
    const queueContext = options?.queueContext;
    const opToken = queueContext?.itemToken || `single_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!workspaceRef.current) {
      if (pendingUploadId) processingPendingUploadIdsRef.current.delete(pendingUploadId);
      showToast('Hãy kết nối Google Drive trước khi tải tài liệu.', 'error');
      return;
    }
    if (
      queueContext &&
      (activeQueueRunIdRef.current !== queueContext.runId ||
        activeQueueItemTokenRef.current !== queueContext.itemToken)
    ) {
      if (pendingUploadId) processingPendingUploadIdsRef.current.delete(pendingUploadId);
      return;
    }
    beginUploadOp(opToken);
    const currentWorkspace = workspaceRef.current;
    const isLocalOnlyWorkspace =
      currentWorkspace.rootFolderId === 'local_offline_workspace' &&
      supportsDurableOfflineQueue();
    if (!isLocalOnlyWorkspace) {
      try {
        const token = await getValidGoogleAccessToken();
        if (!token) throw new Error('Không lấy được access token.');
      } catch {
        if (pendingUploadId) {
          processingPendingUploadIdsRef.current.delete(pendingUploadId);
          showToast('Tài liệu đã được lưu trên thiết bị và sẽ được thử tải lên khi Drive có thể truy cập.', 'info');
          activeQueueRunIdRef.current = null;
          activeQueueItemTokenRef.current = null;
          completedQueueTokensRef.current.clear();
          updateQueueStatus(null);
          batchStagingMemberIdRef.current = undefined;
          setUploadQueue([]);
          uploadQueueRef.current = [];
          pendingUploadIdsRef.current = [];
          endUploadOp(opToken);
          return;
        }
        digitizationLogger.log('error', 'drive', 'Lỗi xác thực Google Drive trước khi upload');
        showToast('Phiên Google Drive đã hết hạn hoặc chưa được cấp quyền. Vui lòng kết nối lại Drive.', 'error');
        activeQueueRunIdRef.current = null;
        activeQueueItemTokenRef.current = null;
        completedQueueTokensRef.current.clear();
        updateQueueStatus(null);
        batchStagingMemberIdRef.current = undefined;
        setUploadQueue([]);
        uploadQueueRef.current = [];
        pendingUploadIdsRef.current = [];
        endUploadOp(opToken);
        return;
      }
    }
    // TỰ ĐỘNG KHỞI TẠO THÀNH VIÊN ĐẦU TIÊN NẾU CHƯA CÓ (Quick Start Flow)
    // SỬ DỤNG REF để lấy danh sách thành viên mới nhất
    if (currentWorkspace.rootFolderId === 'local_offline_workspace' && !isLocalOnlyWorkspace) {
      showToast('Hãy kết nối hoặc tạo Workspace Google Drive trước khi tải tài liệu.', 'error');
      return;
    }
    const currentMembers = currentWorkspace.family.members;
    const targetMemberId = options?.memberId || selectedMemberIdRef.current || selectedMemberId;
    let effectiveMember = currentMembers.find(m => m.id === targetMemberId) || currentMembers[0];
    
    if (!effectiveMember) {
      showToast('Đang khởi tạo hồ sơ gia đình đầu tiên cho bạn...', 'info');
      setIsUploading(true);
      try {
        const user = auth.currentUser;
        const defaultName = user?.displayName || user?.email?.split('@')[0] || 'Thành viên mới';
        
        const memberId = `member_${crypto.randomUUID().slice(0, 12)}`;
        const next = await addDriveFamilyMember(currentWorkspace, {
          id: memberId,
          name: defaultName,
          role: 'other',
        });
        workspaceRef.current = next;
        setWorkspace(next);
        const freshProfiles = await reloadProfiles(next);
        profilesRef.current = freshProfiles;
        effectiveMember = next.family.members.find(m => m.id === memberId) || null;
        if (!effectiveMember) throw new Error('Không thể khởi tạo hồ sơ thành viên mặc định.');
        selectedMemberIdRef.current = memberId;
        setSelectedMemberId(memberId);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Lỗi khi tạo hồ sơ đầu tiên.', 'error');
        endUploadOp(opToken);
        processNextInQueue(queueContext);
        return;
      }
    }
    // KIỂM TRA HỒ SƠ SẴN SÀNG (Robust Loading for Batch)
    let currentProfile = profilesRef.current[effectiveMember.id] || profiles[effectiveMember.id];
    if (!currentProfile && isLocalOnlyWorkspace) {
      currentProfile = createHealthProfile(effectiveMember);
      profilesRef.current[effectiveMember.id] = currentProfile;
      setProfiles((previous) => ({ ...previous, [effectiveMember!.id]: currentProfile! }));
    }
    if (!currentProfile) {
      try {
        const remote = await loadHealthProfile(effectiveMember.profileFileId);
        currentProfile = parseHealthProfile(remote, effectiveMember);
        profilesRef.current[effectiveMember.id] = currentProfile;
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: currentProfile! }));
      } catch (profileError) {
        // Nếu vẫn lỗi, thử chờ 1 giây (có thể đang reload) rồi thử lại một lần nữa
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const remote = await loadHealthProfile(effectiveMember.profileFileId);
          currentProfile = parseHealthProfile(remote, effectiveMember);
          profilesRef.current[effectiveMember.id] = currentProfile;
          setProfiles((prev) => ({ ...prev, [effectiveMember.id]: currentProfile! }));
        } catch (retryError) {
          showToast(
            `Đang chuẩn bị hồ sơ cho ${effectiveMember.name}. Vui lòng đợi trong giây lát...`,
            'info',
          );
          // Vẫn cho chạy tiếp nếu đây là tệp đầu tiên của thành viên mới
          if (members.length > 1) {
            endUploadOp(opToken);
            processNextInQueue(queueContext);
            return;
          }
        }
      }
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('Tệp vượt quá giới hạn cho phép 30 MB.', 'error');
      endUploadOp(opToken);
      processNextInQueue(queueContext);
      return;
    }
    let existingDriveFileId: string | undefined = options?.uploadedFile?.id;
    setDigitizationError('');
    setShowQuickActionModal(false);
    // Bắt đầu cập nhật tiến trình cho tệp hiện tại
    setTrackerState({
      isOpen: false,
      file,
      memberId: effectiveMember.id,
      step: 'uploading_drive',
      progressPercent: 10,
      progressMessage: file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf')
        ? `Đang phân tích & tối ưu nén tệp PDF "${file.name}"...`
        : `Đang chuẩn bị tệp hình ảnh "${file.name}"...`,
      driveFile: null,
      modelUsed: 'gemini-3.5-flash-lite',
      partialExtracted: {},
      error: null,
      totalPages: 1,
      processedPages: 0,
      queueContext,
    });
    notifyBatchProgress(file.name, effectiveMember.name, 'Chuẩn bị', 10);
    // 1. Tối ưu & Nén tệp (PDF hoặc Ảnh) phía client trước khi upload
    let processedFile: File = file;
    try {
      if (file.type.includes('pdf') || file.name.toLowerCase().endsWith('.pdf')) {
        const compressTimer = digitizationLogger.startTimer();
        const compressRes = await compressPdfIfNeeded(file, (msg) => {
          setTrackerState((prev) => ({ ...prev, progressMessage: msg }));
        });
        const compressMs = compressTimer();
        processedFile = compressRes.file;
        if (compressRes.reductionPercent > 0) {
          const origMb = (compressRes.originalSizeBytes / (1024 * 1024)).toFixed(1);
          const compMb = (compressRes.compressedSizeBytes / (1024 * 1024)).toFixed(1);
          digitizationLogger.log(
            'info',
            'compress',
            `Đã tối ưu nén tệp PDF "${file.name}": ${origMb} MB ➔ ${compMb} MB (giảm ${compressRes.reductionPercent}%) trong ${compressMs}ms`,
            { originalBytes: compressRes.originalSizeBytes, compressedBytes: compressRes.compressedSizeBytes, reductionPercent: compressRes.reductionPercent },
            compressMs
          );
          showToast(
            `Đã tối ưu nén tệp PDF "${file.name}": ${origMb} MB ➔ ${compMb} MB (Tiết kiệm ${compressRes.reductionPercent}%)!`,
            'success',
          );
        }
      } else {
        processedFile = await compressImageIfNeeded(file);
      }
      setTrackerState((prev) => ({
        ...prev,
        file: processedFile,
        progressPercent: 25,
        progressMessage: isLocalOnlyWorkspace
          ? 'Đang chuẩn bị tài liệu đã lưu trên thiết bị để số hóa...'
          : existingDriveFileId
            ? 'Tệp đã có trên Drive. Đang chạy AI Vision quét dữ liệu...'
            : 'Đang tải tệp đã tối ưu lên Google Drive...',
      }));
      notifyBatchProgress(
        file.name,
        effectiveMember.name,
        isLocalOnlyWorkspace || existingDriveFileId ? 'Chuẩn bị OCR' : 'Tải lên Drive',
        25,
      );
    } catch (error) {
      console.warn('[Preprocessing Warning]:', error);
      // Giữ nguyên file gốc nếu nén bị gián đoạn
      processedFile = file;
    }
    if (!options?.forceUpload) {
      try {
        const { hash, size } = await computeFileFingerprint(processedFile);
        const activeProfile = profilesRef.current[effectiveMember.id] ||
          profiles[effectiveMember.id] ||
          createHealthProfile(effectiveMember);
        const sameMemberMatch = detectDuplicateFile(
          { name: processedFile.name, size },
          hash,
          activeProfile,
          effectiveMember,
        );
        const match = sameMemberMatch || detectCrossMemberDuplicateFile(
          { name: processedFile.name, size },
          hash,
          profilesRef.current,
          effectiveMember.id,
        );
        if (match) {
          existingDriveFileId = match.existingSource.driveFileId;
          if (options?.uploadedFile && options.uploadedFile.id !== existingDriveFileId) {
            try {
              await trashDriveFile(options.uploadedFile.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Lỗi không xác định.';
              showToast(`Đã nhận diện tệp trùng chính xác nhưng chưa dọn được bản Drive thừa: ${message}`, 'error');
            }
          }

          const eventIsSaved = Boolean(match.linkedEvent);
          if (match.existingSource.status === 'processed' && eventIsSaved) {
            const memberMsg = match.memberName && match.memberName !== effectiveMember.name
              ? `trong hồ sơ của ${match.memberName}`
              : `trong hồ sơ của ${effectiveMember.name}`;
            showToast(`Tệp "${file.name}" trùng nội dung đã OCR và lưu JSON ${memberMsg}; bỏ qua bản lặp.`, 'info');
            await completePendingUpload(pendingUploadId);
            processingPendingUploadIdsRef.current.delete(pendingUploadId || '');
            endUploadOp(opToken);
            processNextInQueue(queueContext);
            return;
          }
          showToast(`Tệp "${file.name}" trùng chính xác nguồn đã có; sẽ tiếp tục OCR từ bản hiện có.`, 'info');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Lỗi không xác định.';
        digitizationLogger.log('warn', 'dedup_check', `Không thể hoàn tất kiểm tra hash trước upload: ${message}`);
      }
    }
    let preExtractedResult: Awaited<ReturnType<typeof extractHealthEventWithProgress>> | undefined;
    const isAutoDetectMode = pickedMemberIdForBatchRef.current === undefined;
    const activeProfileForContainment = profilesRef.current[effectiveMember.id] || profiles[effectiveMember.id];
    const containmentCandidateProfiles = isAutoDetectMode
      ? Object.values(profilesRef.current)
      : [activeProfileForContainment].filter(Boolean);
    const canPreflightContainment = !options?.forceUpload &&
      !existingDriveFileId &&
      containmentCandidateProfiles.some((profile) =>
        Boolean(profile?.sources.some((source) =>
          source.status === 'processed' &&
          !source.rawDeletedAt &&
          (
            (source.contentIndexComplete && Boolean(source.contentIndexPages?.length)) ||
            profile.timeline.some((event) => event.sourceFileId === source.driveFileId)
          ),
        )),
      );
    if (canPreflightContainment) {
      try {
        notifyBatchProgress(file.name, effectiveMember.name, 'Đang đối chiếu OCR trước khi lưu raw', 30);
        preExtractedResult = await extractHealthEventWithProgress(
          processedFile,
          effectiveMember,
          (update) => {
            applyExtractionProgress(update);
            notifyBatchProgress(
              file.name,
              effectiveMember.name,
              EXTRACTION_NOTIFICATION_PHASES[update.stage],
              update.progressPercent,
            );
          },
          { isAutoDetect: isAutoDetectMode },
        );
        const { hash } = await computeFileFingerprint(processedFile);
        const containmentMember = (
          isAutoDetectMode && isRecognizablePatientName(preExtractedResult.extracted.patientName)
            ? findMemberByOcrPatientName(
                preExtractedResult.extracted.patientName,
                workspaceRef.current?.family.members || members,
                preExtractedResult.extracted.patientBirthDate,
                preExtractedResult.extracted.patientGender,
              ).matched
            : undefined
        ) || effectiveMember;
        const integrated = await tryIntegrateContainedDocument(
          containmentMember,
          processedFile,
          hash,
          preExtractedResult,
          queueContext,
        );
        if (integrated) {
          await completePendingUpload(pendingUploadId);
          endUploadOp(opToken);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Lỗi OCR không xác định.';
        digitizationLogger.log(
          'warn',
          'content_dedup_preflight',
          `Không thể kết luận tài liệu có bị bao trùm trước upload; giữ raw và tiếp tục lưu an toàn: ${message}`,
          { fileName: file.name, memberId: effectiveMember.id },
        );
        showToast(
          `Chưa thể xác minh nội dung trùng của "${file.name}". Ứng dụng sẽ giữ raw và tiếp tục xử lý để tránh mất dữ liệu.`,
          'info',
        );
      }
    }
    try {
      if (isLocalOnlyWorkspace) {
        if (!pendingUploadId || !offlineOwnerKey) {
          throw new Error('Không thể xác định tài liệu đã lưu trong bộ nhớ của ứng dụng.');
        }
        const localFile: DriveFile = {
          id: `local_file_${pendingUploadId}`,
          name: processedFile.name,
          mimeType: processedFile.type || 'application/octet-stream',
          createdTime: new Date().toISOString(),
          size: String(processedFile.size),
        };
        const { hash } = await computeFileFingerprint(processedFile);
        const isPdfDoc = processedFile.type.includes('pdf') || processedFile.name.toLowerCase().endsWith('.pdf');
        const totalPages = isPdfDoc ? await getPdfPageCount(await processedFile.arrayBuffer()) : 1;
        const source: HealthSource = {
          driveFileId: localFile.id,
          fileName: localFile.name,
          fileSize: processedFile.size,
          fileHash: hash,
          mimeType: localFile.mimeType,
          uploadedAt: localFile.createdTime,
          status: 'pending',
          totalPages,
          processedPages: 0,
        };
        const staged = addHealthSource(
          profilesRef.current[effectiveMember.id] || currentProfile || createHealthProfile(effectiveMember),
          source,
        );
        const savedProfile = await saveHealthProfile(effectiveMember.profileFileId, staged);
        profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: savedProfile };
        setProfiles((previous) => ({ ...previous, [effectiveMember.id]: savedProfile }));
        setTrackerState((previous) => ({
          ...previous,
          driveFile: localFile,
          progressPercent: 35,
          progressMessage: 'Tài liệu đã lưu an toàn trên thiết bị. Đang số hóa bằng Gemini...',
        }));
        await runDocumentExtraction(processedFile, effectiveMember, localFile.id, preExtractedResult, queueContext);
      } else if (existingDriveFileId) {
        // Tệp đã có trên Google Drive: Tái sử dụng tệp gốc, KHÔNG tạo bản sao trùng lặp trên Drive
        digitizationLogger.log(
          'info',
          'drive_reuse',
          `Tái sử dụng tệp đã có sẵn trên Google Drive: ID=${existingDriveFileId} ("${processedFile.name}")`,
          { fileId: existingDriveFileId, fileName: processedFile.name }
        );
        const existingSource = currentProfile?.sources.find(
          (source) => source.driveFileId === existingDriveFileId,
        );
        if (!existingSource && options?.uploadedFile) {
          const { hash } = await computeFileFingerprint(processedFile);
          const isPdfDoc = processedFile.type.includes('pdf') || processedFile.name.toLowerCase().endsWith('.pdf');
          const totalPages = isPdfDoc
            ? await getPdfPageCount(await processedFile.arrayBuffer())
            : 1;
          const source: HealthSource = {
            driveFileId: options.uploadedFile.id,
            fileName: options.uploadedFile.name,
            fileSize: processedFile.size,
            fileHash: hash,
            mimeType: options.uploadedFile.mimeType || processedFile.type || 'application/octet-stream',
            uploadedAt: options.uploadedFile.createdTime || new Date().toISOString(),
            status: 'pending',
            totalPages,
            processedPages: 0,
          };
          const staged = addHealthSource(
            profilesRef.current[effectiveMember.id] || currentProfile || createHealthProfile(effectiveMember),
            source,
          );
          const saved = await saveHealthProfile(effectiveMember.profileFileId, staged);
          profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: saved };
          setProfiles((previous) => ({ ...previous, [effectiveMember.id]: saved }));
          await completePendingUpload(pendingUploadId);
        } else if (pendingUploadId) {
          await completePendingUpload(pendingUploadId);
        }
        await runDocumentExtraction(processedFile, effectiveMember, existingDriveFileId, preExtractedResult, queueContext);
        const reusedUploaded: DriveFile = {
          ...(options?.uploadedFile || {}),
          id: existingDriveFileId,
          name: options?.uploadedFile?.name || processedFile.name,
          mimeType: options?.uploadedFile?.mimeType || processedFile.type || 'application/octet-stream',
          createdTime: options?.uploadedFile?.createdTime || new Date().toISOString(),
        };
        setTrackerState((prev) => ({ ...prev, driveFile: reusedUploaded }));
      } else {
        const uploadTimer = digitizationLogger.startTimer();
        digitizationLogger.log(
          'info',
          'drive_upload_start',
          `Bắt đầu tải tệp "${processedFile.name}" (${(processedFile.size / 1024).toFixed(1)} KB) lên Google Drive của ${effectiveMember.name}...`,
          { fileName: processedFile.name, size: processedFile.size, memberName: effectiveMember.name }
        );
        const uploaded = await uploadRawHealthFile(effectiveMember, processedFile);
        const uploadMs = uploadTimer();
        digitizationLogger.log(
          'info',
          'drive_upload_complete',
          `Tải tệp lên Google Drive thành công trong ${uploadMs}ms. File ID: ${uploaded.id}`,
          { fileId: uploaded.id, fileName: uploaded.name, memberId: effectiveMember.id },
          uploadMs
        );
        if (pendingUploadId && userEmail) {
          const pending = await getPendingUpload(pendingUploadId);
          if (pending) await localSyncOutbox.setUploadedFile(pending, uploaded);
        }
        setTrackerState((prev) => ({ ...prev, driveFile: uploaded }));
        const { hash } = await computeFileFingerprint(processedFile);
        const isPdfDoc = processedFile.type.includes('pdf') || processedFile.name.toLowerCase().endsWith('.pdf');
        const realTotalPages = isPdfDoc ? await getPdfPageCount(await processedFile.arrayBuffer()) : 1;
        const source: HealthSource = {
          driveFileId: uploaded.id,
          fileName: uploaded.name,
          fileSize: processedFile.size,
          fileHash: hash,
          mimeType: uploaded.mimeType || processedFile.type || 'application/octet-stream',
          uploadedAt: uploaded.createdTime || new Date().toISOString(),
          status: 'pending',
          totalPages: realTotalPages,
          processedPages: 0,
        };
        const current = profilesRef.current[effectiveMember.id] ||
          currentProfile ||
          createHealthProfile(effectiveMember);
        const stagedProfile = addHealthSource(current, source);
        const savedProfile = await saveHealthProfile(effectiveMember.profileFileId, stagedProfile);
        profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: savedProfile };
        setProfiles((previous) => ({ ...previous, [effectiveMember.id]: savedProfile }));
        await completePendingUpload(pendingUploadId);
        await runDocumentExtraction(processedFile, effectiveMember, uploaded.id, preExtractedResult, queueContext);
      }
    } catch (error) {
      batchFailureCountRef.current += 1;
      const msg = error instanceof Error
        ? error.message
        : 'Không thể hoàn tất lưu tài liệu vào Google Drive hoặc hồ sơ thành viên.';

      setTrackerState((prev) => ({
        ...prev,
        step: 'error',
        progressMessage: 'Lỗi trong quá trình xử lý',
        error: msg,
      }));

      if (
        queueContext &&
        activeQueueRunIdRef.current === queueContext.runId &&
        activeQueueItemTokenRef.current === queueContext.itemToken &&
        queueStatusRef.current !== null
      ) {
        queueErrorAdvanceTimerRef.current = window.setTimeout(() => {
          setTrackerState(prev => ({ ...prev, isOpen: false }));
          processNextInQueue(queueContext);
        }, 2500);
      }
      if (pendingUploadId) processingPendingUploadIdsRef.current.delete(pendingUploadId);
    } finally {
      endUploadOp(opToken);
      if (pendingUploadId) processingPendingUploadIdsRef.current.delete(pendingUploadId);
    }
  }
  useEffect(() => {
    if (
      !supportsDurableOfflineQueue() ||
      !driveAuthorized ||
      !userEmail ||
      !workspace ||
      workspace.rootFolderId === 'local_offline_workspace'
    ) return;
    let cancelled = false;
    const drainPendingUploads = async () => {
      if (
        cancelled ||
        pendingUploadDrainInFlightRef.current ||
        isUploading ||
        isUploadingRef.current ||
        queueStatusRef.current !== null ||
        activeQueueRunIdRef.current !== null ||
        activeUploadOpRef.current !== null ||
        uploadQueueRef.current.length > 0 ||
        processingPendingUploadIdsRef.current.size > 0 ||
        (typeof navigator !== 'undefined' && !navigator.onLine)
      ) return;
      pendingUploadDrainInFlightRef.current = true;
      try {
        const pending = await localSyncOutbox.listUploads(userEmail);
        if (cancelled) return;
        setPendingLocalUploadCount(pending.length);
        const assignedRootId = localStorage.getItem(
          `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`,
        );
        const latestWorkspace = workspaceRef.current || workspace;
        for (const operation of pending) {
          if (cancelled || queueStatusRef.current !== null || activeQueueRunIdRef.current !== null) return;
          if (
            operation.workspaceRootId !== latestWorkspace.rootFolderId &&
            (operation.workspaceRootId !== 'local_offline_workspace' || assignedRootId !== latestWorkspace.rootFolderId)
          ) continue;
          if (processingPendingUploadIdsRef.current.has(operation.id)) continue;
          const targetMember =
            latestWorkspace.family.members.find((member) => member.id === operation.member.id) ||
            findMemberForEmail(latestWorkspace.family.members, operation.member.email);
          if (!targetMember) continue;
          processingPendingUploadIdsRef.current.add(operation.id);
          const file = await fileFromPendingUpload(operation);
          await beginDigitization(file, {
            memberId: targetMember.id,
            pendingUploadId: operation.id,
            uploadedFile: operation.uploadedFile,
          });
        }
      } catch (error) {
        console.error('[Drive sync] Could not resume pending local uploads.', error);
        showToast(
          error instanceof Error ? `Đồng bộ tài liệu đang chờ thất bại: ${error.message}` : 'Không thể đồng bộ tài liệu đang chờ.',
          'error',
        );
      } finally {
        pendingUploadDrainInFlightRef.current = false;
      }
    };
    const onOnline = () => void drainPendingUploads();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void drainPendingUploads();
    };
    void drainPendingUploads();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [driveAuthorized, isUploading, uploadQueue.length, userEmail, workspace?.rootFolderId, showToast]);
  function applyExtractionProgress(update: ExtractionProgressUpdate) {
    setTrackerState((prev) => {
      const nextStep: TrackerStep =
        update.stage === 'extracting_content'
          ? 'extracting_content'
          : update.stage === 'matching_patient'
          ? 'matching_patient'
          : update.stage === 'completed'
          ? 'completed'
          : 'reading_document';
      return {
        ...prev,
        step: nextStep,
        progressPercent: Math.max(prev.progressPercent, update.progressPercent),
        progressMessage: update.message,
        modelUsed: update.modelUsed || prev.modelUsed,
        partialExtracted: update.partialEvent
          ? { ...prev.partialExtracted, ...update.partialEvent }
          : prev.partialExtracted,
        totalPages: update.totalPages !== undefined ? update.totalPages : prev.totalPages,
        processedPages: update.processedPages !== undefined ? update.processedPages : prev.processedPages,
      };
    });
  }
  async function runDocumentExtraction(
    file: File,
    member: FamilyMember,
    driveFileId?: string,
    preExtractedResult?: Awaited<ReturnType<typeof extractHealthEventWithProgress>>,
    queueContext?: QueueItemContext,
  ) {
    let latestProgress = 45;
    try {
      const reportProgress = (update: ExtractionProgressUpdate) => {
        applyExtractionProgress(update);
        latestProgress = update.progressPercent;
        notifyBatchProgress(
          file.name,
          member.name,
          EXTRACTION_NOTIFICATION_PHASES[update.stage],
          update.progressPercent,
        );
        if (driveFileId) persistOcrRecoveryJob(driveFileId, 'processing', latestProgress, file.name);
      };
      const isAutoDetect = pickedMemberIdForBatchRef.current === undefined;
      const result = preExtractedResult || await extractHealthEventWithProgress(
        file,
        member,
        reportProgress,
        { isAutoDetect },
      );
      if (!driveFileId) throw new Error('Không xác định được mã tài liệu Drive để lưu kết quả OCR.');
      const source = Object.values(profilesRef.current)
        .flatMap((profile) => profile.sources)
        .find((item) => item.driveFileId === driveFileId);
      const draft: DigitizationDraft = {
        source: {
          id: driveFileId,
          name: source?.fileName || file.name,
          mimeType: source?.mimeType || file.type || 'application/octet-stream',
          createdTime: source?.uploadedAt || new Date().toISOString(),
        },
        extracted: result.extracted,
        contentIndexPages: result.contentIndexPages,
        contentIndexComplete: result.contentIndexComplete,
        queueContext,
      };
      setTrackerState((previous) => ({
        ...previous,
        step: 'completed',
        progressPercent: 100,
        progressMessage: 'OCR hoàn tất. Đang xác định hồ sơ thành viên...',
        partialExtracted: result.extracted,
        modelUsed: result.modelUsed || previous.modelUsed,
        isOpen: false,
      }));
      const patientName = result.extracted.patientName?.trim();
      if (!isRecognizablePatientName(patientName)) {
        if (driveFileId) persistOcrRecoveryJob(driveFileId, 'needs_review', 100, file.name);
        const latestProfile = profilesRef.current[member.id] || profiles[member.id];
        if (latestProfile) {
          const unresolvedProfile: HealthProfile = {
            ...latestProfile,
            sources: latestProfile.sources.map((sourceItem) =>
              sourceItem.driveFileId === driveFileId
                ? { ...sourceItem, subjectStatus: 'unresolved' }
                : sourceItem,
            ),
            updatedAt: new Date().toISOString(),
          };
          const saved = await saveHealthProfile(member.profileFileId, unresolvedProfile);
          profilesRef.current = { ...profilesRef.current, [member.id]: saved };
          setProfiles((previous) => ({ ...previous, [member.id]: saved }));
        }
        setIdentityResolutionDraft({
          ...draft,
        });
        showToast(
          `OCR chưa xác định được chủ thể của "${draft.source.name}". Hãy tạo hoặc chọn thành viên để gán dữ liệu.`,
          'info',
        );
        return;
      }
      const targetMember = await findOrCreateOcrMember(patientName, result.extracted);
      if (!targetMember) {
        if (driveFileId) persistOcrRecoveryJob(driveFileId, 'needs_review', 100, file.name);
        const latestProfile = profilesRef.current[member.id] || profiles[member.id];
        if (latestProfile) {
          const unresolvedProfile: HealthProfile = {
            ...latestProfile,
            sources: latestProfile.sources.map((sourceItem) =>
              sourceItem.driveFileId === driveFileId
                ? { ...sourceItem, subjectStatus: 'unresolved' }
                : sourceItem,
            ),
            updatedAt: new Date().toISOString(),
          };
          const saved = await saveHealthProfile(member.profileFileId, unresolvedProfile);
          profilesRef.current = { ...profilesRef.current, [member.id]: saved };
          setProfiles((previous) => ({ ...previous, [member.id]: saved }));
        }
        setIdentityResolutionDraft(draft);
        showToast(
          `OCR nhận diện "${patientName}" nhưng không thể khớp an toàn với một hồ sơ duy nhất. Hãy xác nhận chủ thể trước khi lưu.`,
          'info',
        );
        return;
      }
      setSelectedMemberId(targetMember.id);
      selectedMemberIdRef.current = targetMember.id;
      setTrackerState((previous) => ({ ...previous, memberId: targetMember.id }));
      const saved = await saveExtractedDocumentAutomatically(draft, targetMember, true);
      if (!saved) {
        batchFailureCountRef.current += 1;
        setTrackerState((previous) => ({
          ...previous,
          isOpen: !queueContext,
          step: 'error',
          progressMessage: 'Không thể lưu kết quả OCR.',
          error: workspaceRef.current?.rootFolderId === 'local_offline_workspace'
            ? 'Tài liệu đã lưu trên thiết bị nhưng chưa lưu được kết quả vào hồ sơ.'
            : 'Tài liệu đã được tải lên Drive nhưng chưa lưu được vào hồ sơ.',
        }));
        notifyBatchProgress(file.name, targetMember.name, 'Lỗi lưu kết quả');
        processNextInQueue(queueContext);
        return;
      }
    } catch (error) {
      batchFailureCountRef.current += 1;
      const msg = error instanceof Error ? error.message : 'Chưa thể phân tích tài liệu bằng Gemini.';
      if (driveFileId) persistOcrRecoveryJob(driveFileId, 'interrupted', latestProgress, file.name);
      setDigitizationError(msg);
      setTrackerState((prev) => ({
        ...prev,
        step: 'error',
        progressMessage: 'Lỗi nhận dạng tài liệu',
        error: msg,
      }));
      showToast(
        workspaceRef.current?.rootFolderId === 'local_offline_workspace'
          ? 'Tài liệu vẫn được giữ trên thiết bị. Bạn có thể nhập thủ công hoặc thử lại khi có mạng.'
          : 'Tài liệu đã lưu trên Drive. Bạn có thể nhập thủ công hoặc thử lại.',
        'info',
      );
      processNextInQueue(queueContext);
    }
  }
  async function findOrCreateOcrMember(
    patientName: string,
    extracted: Partial<HealthEvent>,
  ): Promise<FamilyMember | undefined> {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace) throw new Error('Không tìm thấy Workspace để gán tài liệu OCR.');
    const currentMembers = currentWorkspace.family.members;
    const findEmptyPlaceholder = (requireZeroSources = false) => {
      return currentMembers.find((candidate) => {
        const profile = profilesRef.current[candidate.id] || profiles[candidate.id];
        const isPlaceholder = candidate.name === 'Thành viên mới' ||
          candidate.name === 'Gia đình' ||
          candidate.name.toLowerCase().includes('thanh vien');
        const isEmpty = !profile || (
          profile.timeline.length === 0 &&
          (requireZeroSources ? profile.sources.length === 0 : profile.sources.length <= 1)
        );
        return isPlaceholder && isEmpty;
      });
    };
    
    const { matched, candidates } = findMemberByOcrPatientName(
      patientName,
      currentMembers,
      extracted.patientBirthDate,
      extracted.patientGender,
    );
    if (matched) {
      digitizationLogger.log(
        'info',
        'subject_match',
        `Khớp chủ thể bệnh nhân "${patientName}" với thành viên gia đình: "${matched.name}" (${matched.id})`,
        { patientName, matchedMemberId: matched.id, matchedMemberName: matched.name }
      );
      // Chỉ dọn placeholder rỗng hoàn toàn (0 timeline, 0 sources) để không xóa nhầm tệp chờ xử lý
      const emptyPlaceholder = findEmptyPlaceholder(true);
      if (emptyPlaceholder && emptyPlaceholder.id !== matched.id && isWorkspaceAdmin) {
        try {
          const { workspace: cleanedWs } = await deleteDriveFamilyMember(currentWorkspace, emptyPlaceholder.id);
          workspaceRef.current = cleanedWs;
          setWorkspace(cleanedWs);
        } catch (e) {
          console.warn('[OCR Subject Match] Could not cleanup leftover placeholder member:', e);
        }
      }
      if (!profilesRef.current[matched.id]) {
        const reloaded = await reloadProfiles(workspaceRef.current || currentWorkspace);
        profilesRef.current = reloaded;
        setProfiles(reloaded);
      }
      return matched;
    }
    // Nếu không có ứng viên nào, không trùng tên với thành viên đã có (tránh tạo bản sao khi lệch ngày sinh/giới tính)
    // và tên hợp lệ -> Tự động đổi tên thành viên rỗng hoặc tạo thành viên mới
    const hasSameNameConflict = hasSameNameMemberConflict(patientName, currentMembers);
    if (candidates.length === 0 && !hasSameNameConflict && isRecognizablePatientName(patientName)) {
      digitizationLogger.log(
        'info',
        'subject_auto_create',
        `Không tìm thấy thành viên khớp; tự động tạo/cập nhật hồ sơ cho "${patientName}"`,
        { patientName }
      );
      
      try {
        const cleanedPatientName = sanitizeOcrPatientName(patientName) || patientName;
        const normalizedName = normalizeVietnameseProperName(cleanedPatientName);
        const emptyPlaceholder = findEmptyPlaceholder();
        let targetMember: FamilyMember;
        let updatedWorkspace: HealthDriveWorkspace;
        if (emptyPlaceholder) {
          // Ưu tiên CẬP NHẬT/ĐỔI TÊN thành viên rỗng 'Thành viên mới' sẵn có thành "Trương Anh Tuấn"
          if (currentWorkspace.rootFolderId !== 'local_offline_workspace' && driveAuthorized) {
            updatedWorkspace = await updateDriveFamilyMember(currentWorkspace, emptyPlaceholder.id, {
              name: normalizedName,
              gender: genderFromOcr(extracted.patientGender, emptyPlaceholder.gender),
              birthDate: extracted.patientBirthDate || emptyPlaceholder.birthDate,
            });
            targetMember = updatedWorkspace.family.members.find(m => m.id === emptyPlaceholder.id)!;
          } else {
            targetMember = {
              ...emptyPlaceholder,
              name: normalizedName,
              gender: genderFromOcr(extracted.patientGender, emptyPlaceholder.gender),
              birthDate: extracted.patientBirthDate || emptyPlaceholder.birthDate,
            };
            updatedWorkspace = {
              ...currentWorkspace,
              family: {
                ...currentWorkspace.family,
                members: currentWorkspace.family.members.map(m => m.id === emptyPlaceholder.id ? targetMember : m),
                updatedAt: new Date().toISOString(),
              },
            };
          }
        } else {
          // Nếu không có thành viên rỗng sẵn có -> Tạo mới hoàn toàn
          const newMemberId = `member_${crypto.randomUUID().slice(0, 12)}`;
          if (currentWorkspace.rootFolderId !== 'local_offline_workspace' && driveAuthorized) {
            updatedWorkspace = await addDriveFamilyMember(currentWorkspace, {
              id: newMemberId,
              name: normalizedName,
              gender: genderFromOcr(extracted.patientGender),
              birthDate: extracted.patientBirthDate,
              role: 'other',
            });
            targetMember = updatedWorkspace.family.members.find(m => m.id === newMemberId)!;
          } else {
            targetMember = {
              id: newMemberId,
              name: normalizedName,
              gender: genderFromOcr(extracted.patientGender),
              birthDate: extracted.patientBirthDate,
              role: 'other',
              driveFolderId: `local_folder_${newMemberId}`,
              profileFileId: `local_profile_${newMemberId}`,
            };
            const localProfile = { ...createHealthProfile(targetMember), syncPending: true };
            if (offlineOwnerKey) {
              await localSyncOutbox.enqueueMemberSave(
                offlineOwnerKey,
                currentWorkspace.rootFolderId,
                targetMember,
                localProfile,
                true,
              );
            }
            updatedWorkspace = {
              ...currentWorkspace,
              family: {
                ...currentWorkspace.family,
                members: [...currentWorkspace.family.members, targetMember],
                updatedAt: new Date().toISOString(),
              },
            };
            profilesRef.current = { ...profilesRef.current, [targetMember.id]: localProfile };
            setProfiles((prev) => ({ ...prev, [targetMember.id]: localProfile }));
          }
        }
        workspaceRef.current = updatedWorkspace;
        setWorkspace(updatedWorkspace);
        
        // Ensure profile is loaded for the target member
        if (!profilesRef.current[targetMember.id]) {
          const reloaded = await reloadProfiles(updatedWorkspace);
          profilesRef.current = reloaded;
          setProfiles(reloaded);
        }
        
        showToast(`Đã tự động gán hồ sơ cho "${normalizedName}".`, 'success');
        return targetMember;
      } catch (error) {
        console.error('[OCR Auto-create] Failed to create or update member:', error);
      }
    }
    digitizationLogger.log(
      'warn',
      'subject_match_requires_confirmation',
      `Không thể khớp chủ thể OCR "${patientName}" tự động (số ứng viên: ${candidates.length}); yêu cầu xác nhận thủ công.`,
      {
        patientName,
        candidateNames: candidates.map((c) => c.name),
        patientBirthDate: extracted.patientBirthDate,
        patientGender: extracted.patientGender,
      }
    );
    return undefined;
  }
  function genderFromOcr(
    value?: string,
    fallback: FamilyMember['gender'] = 'other',
  ): FamilyMember['gender'] {
    const gender = value?.trim().toLowerCase();
    if (gender === 'nam' || gender === 'male') return 'male';
    if (gender === 'nữ' || gender === 'female') return 'female';
    return fallback;
  }

  async function cleanupContainedRawDocuments(
    member: FamilyMember,
    incomingSourceId: string,
    preMergeContainmentHint?: {
      existingSourceId: string;
      relation: 'left_contains_right' | 'right_contains_left' | 'equivalent';
    },
  ): Promise<void> {
    const isLocalWorkspace = workspaceRef.current?.rootFolderId === 'local_offline_workspace';
    let profile = profilesRef.current[member.id] || profiles[member.id];
    if (!profile || (!isLocalWorkspace && profile.syncPending)) return;
    const incoming = profile.sources.find((source) => source.driveFileId === incomingSourceId);
    if (
      !incoming ||
      incoming.status !== 'processed' ||
      incoming.rawDeletedAt ||
      !incoming.digitizedAt
    ) return;

    const incomingEvents = profile.timeline.filter(
      (event) =>
        event.sourceFileId === incoming.driveFileId ||
        event.additionalSources?.some((source) => source.driveFileId === incoming.driveFileId),
    );
    const hasIncomingIndex = Boolean(incoming.contentIndexComplete && incoming.contentIndexPages?.length);
    if (!hasIncomingIndex && incomingEvents.length === 0 && !preMergeContainmentHint) return;

    for (const existing of profile.sources) {
      if (
        existing.driveFileId === incoming.driveFileId ||
        existing.status !== 'processed' ||
        existing.rawDeletedAt ||
        !existing.digitizedAt
      ) continue;

      let containmentRelation: 'left_contains_right' | 'right_contains_left' | 'equivalent' | null = null;
      if (hasIncomingIndex && existing.contentIndexComplete && existing.contentIndexPages?.length) {
        const comparison = compareDocumentContainment(
          { pages: existing.contentIndexPages, complete: true },
          { pages: incoming.contentIndexPages || [], complete: true },
        );
        if (
          comparison.relation === 'right_contains_left' ||
          comparison.relation === 'left_contains_right' ||
          comparison.relation === 'equivalent'
        ) {
          containmentRelation = comparison.relation;
        }
      }

      if (!containmentRelation && incomingEvents.length > 0) {
        const existingEvents = profile.timeline.filter((event) => event.sourceFileId === existing.driveFileId);
        for (const existingEv of existingEvents) {
          for (const incomingEv of incomingEvents) {
            const structCmp = compareStructuredEventContainment(existingEv, incomingEv);
            if (structCmp !== 'none') {
              containmentRelation = structCmp;
              break;
            }
          }
          if (containmentRelation) break;
        }
      }

      if (
        !containmentRelation &&
        preMergeContainmentHint &&
        existing.driveFileId === preMergeContainmentHint.existingSourceId
      ) {
        containmentRelation = preMergeContainmentHint.relation;
      }

      if (!containmentRelation) continue;

      let canonical = existing;
      let redundant = incoming;
      if (containmentRelation === 'right_contains_left') {
        canonical = incoming;
        redundant = existing;
      } else if (containmentRelation === 'equivalent') {
        const existingScore = (existing.contentIndexPages?.length || 0) * 1_000_000 + (existing.fileSize || 0);
        const incomingScore = (incoming.contentIndexPages?.length || 0) * 1_000_000 + (incoming.fileSize || 0);
        if (incomingScore > existingScore) {
          canonical = incoming;
          redundant = existing;
        }
      }

      const linkedEvents = profile.timeline.filter((event) =>
        event.sourceFileId === redundant.driveFileId ||
        event.additionalSources?.some((source) => source.driveFileId === redundant.driveFileId),
      );
      if (linkedEvents.length === 0) continue;

      const contribution = {
        fileName: redundant.fileName,
        fileHash: redundant.fileHash || '',
        hashAlgorithm: 'sha256' as const,
        uploadedAt: redundant.uploadedAt,
        disposition: (containmentRelation === 'equivalent' ? 'duplicate' : 'included') as 'duplicate' | 'included',
      };
      const canonicalContributions = [
        ...(canonical.sourceContributions || []),
        ...(redundant.sourceContributions || []),
        contribution,
      ].filter((item, index, list) =>
        list.findIndex((candidate) =>
          candidate.fileHash === item.fileHash &&
          candidate.hashAlgorithm === item.hashAlgorithm &&
          candidate.fileName === item.fileName,
        ) === index,
      );
      const canonicalSources = new Map(
        (canonical.driveFileId === redundant.driveFileId
          ? []
          : [{ driveFileId: canonical.driveFileId, fileName: canonical.fileName }])
          .map((source) => [source.driveFileId, source]),
      );
      for (const event of linkedEvents) {
        for (const source of [
          ...(event.additionalSources || []),
          { driveFileId: event.sourceFileId, fileName: event.sourceFileName },
          { driveFileId: redundant.driveFileId, fileName: redundant.fileName },
        ]) {
          if (source.driveFileId && source.driveFileId !== canonical.driveFileId) {
            canonicalSources.set(source.driveFileId, source);
          }
        }
      }

      const remappedTimeline = profile.timeline.map((event) => {
        const referencesRedundant =
          event.sourceFileId === redundant.driveFileId ||
          event.additionalSources?.some((source) => source.driveFileId === redundant.driveFileId);
        if (!referencesRedundant) return event;
        const mergedEventSources = new Map(
          (event.additionalSources || []).map((source) => [source.driveFileId, source]),
        );
        for (const [id, src] of canonicalSources.entries()) {
          if (id && id !== canonical.driveFileId) mergedEventSources.set(id, src);
        }
        return {
          ...event,
          sourceFileId: canonical.driveFileId,
          sourceFileName: canonical.fileName,
          additionalSources: Array.from(mergedEventSources.values()),
        };
      });
      const linkedSourceIds = new Set(
        remappedTimeline.flatMap((event) => [
          event.sourceFileId,
          ...(event.additionalSources || []).map((source) => source.driveFileId),
        ]),
      );
      if (!linkedSourceIds.has(canonical.driveFileId)) continue;

      const updatedProfile: HealthProfile = {
        ...profile,
        timeline: remappedTimeline,
        sources: profile.sources.map((source) =>
          source.driveFileId === canonical.driveFileId
            ? { ...source, sourceContributions: canonicalContributions }
            : source,
        ),
        updatedAt: new Date().toISOString(),
      };
      let savedBeforeTrash: HealthProfile;
      try {
        savedBeforeTrash = await saveHealthProfile(member.profileFileId, updatedProfile);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Lỗi không xác định.';
        showToast(`Đã lưu dữ liệu OCR, nhưng giữ lại raw do không lưu được liên kết nguồn: ${message}`, 'error');
        return;
      }
      if (!isLocalWorkspace && savedBeforeTrash.syncPending) {
        showToast(
          `Đã hợp nhất "${redundant.fileName}"; chờ đồng bộ Drive trước khi dọn tệp thừa.`,
          'info',
        );
        return;
      }
      profilesRef.current = { ...profilesRef.current, [member.id]: savedBeforeTrash };
      setProfiles((previous) => ({ ...previous, [member.id]: savedBeforeTrash }));

      try {
        if (redundant.driveFileId.startsWith('local_file_')) {
          await deleteLocalSource(redundant.driveFileId, offlineOwnerKey || 'apk-local-device');
        } else {
          await trashDriveFile(redundant.driveFileId);
        }
        const deletionTime = new Date().toISOString();
        const markedProfile: HealthProfile = {
          ...savedBeforeTrash,
          sources: savedBeforeTrash.sources.map((source) =>
            source.driveFileId === redundant.driveFileId
              ? { ...source, rawDeletedAt: deletionTime }
              : source,
          ),
          updatedAt: deletionTime,
        };
        const savedAfterTrash = await saveHealthProfile(member.profileFileId, markedProfile);
        profilesRef.current = { ...profilesRef.current, [member.id]: savedAfterTrash };
        setProfiles((previous) => ({ ...previous, [member.id]: savedAfterTrash }));
        profile = savedAfterTrash;
        showToast(
          `Đã gộp và dọn tệp trùng "${redundant.fileName}"; giữ bản đầy đủ "${canonical.fileName}".`,
          'success',
        );
        if (redundant.driveFileId === incomingSourceId) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Lỗi không xác định.';
        if (!redundant.driveFileId.startsWith('local_file_')) {
          try {
            await restoreTrashedDriveFile(redundant.driveFileId);
          } catch {
            // ignore restore failure
          }
        }
        showToast(`Đã giữ lại tệp "${redundant.fileName}": ${message}`, 'error');
        return;
      }
    }
  }

  async function tryIntegrateContainedDocument(
    member: FamilyMember,
    file: File,
    fileHash: string,
    result: Awaited<ReturnType<typeof extractHealthEventWithProgress>>,
    queueContext?: QueueItemContext,
  ): Promise<boolean> {
    if (
      !/^[a-f0-9]{64}$/i.test(fileHash) ||
      !isRecognizablePatientName(result.extracted.patientName) ||
      !isOcrSubjectMatchedToMember(
        result.extracted.patientName,
        member,
        workspaceRef.current?.family.members || members,
        result.extracted.patientBirthDate,
        result.extracted.patientGender,
      )
    ) return false;

    const isLocalWorkspace = workspaceRef.current?.rootFolderId === 'local_offline_workspace';
    const profile = profilesRef.current[member.id] || profiles[member.id];
    if (!profile || (!isLocalWorkspace && profile.syncPending)) return false;
    const incomingIndex = createDocumentContentIndex(result.contentIndexPages);

    const candidates = profile.sources
      .filter((source) =>
        source.status === 'processed' &&
        !source.rawDeletedAt &&
        source.digitizedAt &&
        profile.timeline.some((event) =>
          event.sourceFileId === source.driveFileId ||
          event.additionalSources?.some((item) => item.driveFileId === source.driveFileId),
        ),
      )
      .map((source) => {
        let matched = false;
        let score = 0;
        if (incomingIndex.complete && source.contentIndexComplete && source.contentIndexPages?.length) {
          const comparison = compareDocumentContainment(
            { pages: source.contentIndexPages, complete: true },
            incomingIndex,
          );
          if (comparison.relation === 'left_contains_right' || comparison.relation === 'equivalent') {
            matched = true;
            score = comparison.rightCoverage;
          }
        }
        if (!matched) {
          const sourceEvents = profile.timeline.filter((ev) => ev.sourceFileId === source.driveFileId);
          for (const ev of sourceEvents) {
            const structCmp = compareStructuredEventContainment(ev, result.extracted);
            if (structCmp === 'left_contains_right' || structCmp === 'equivalent') {
              matched = true;
              score = structCmp === 'equivalent' ? 0.99 : 0.95;
              break;
            }
          }
        }
        return { source, matched, score };
      })
      .filter((candidate) => candidate.matched)
      .sort((left, right) => right.score - left.score);

    const canonical = candidates[0]?.source;
    if (!canonical) return false;

    const draft: DigitizationDraft = {
      source: {
        id: canonical.driveFileId,
        name: canonical.fileName,
        mimeType: canonical.mimeType,
        createdTime: canonical.uploadedAt,
        size: canonical.fileSize === undefined ? undefined : String(canonical.fileSize),
      },
      extracted: result.extracted,
      contentIndexPages: canonical.contentIndexPages || [],
      contentIndexComplete: Boolean(canonical.contentIndexComplete),
      sourceContributions: [{
        fileName: file.name,
        fileHash,
        hashAlgorithm: 'sha256',
        uploadedAt: new Date().toISOString(),
        disposition: 'included',
      }],
      queueContext,
    };

    const saved = await saveExtractedDocumentAutomatically(draft, member, true);
    if (saved) {
      showToast(
        `Đã gộp "${file.name}" vào "${canonical.fileName}"; không lưu bản trùng.`,
        'success',
      );
    }
    return saved;
  }

  async function saveExtractedDocumentAutomatically(
    draft: DigitizationDraft,
    member: FamilyMember,
    subjectManuallyConfirmed = false,
  ): Promise<boolean> {
    if (!subjectManuallyConfirmed && !isOcrSubjectMatchedToMember(
      draft.extracted.patientName,
      member,
      workspaceRef.current?.family.members || members,
      draft.extracted.patientBirthDate,
      draft.extracted.patientGender,
    )) {
      const message = `Chưa lưu tài liệu: chủ thể OCR "${draft.extracted.patientName || 'chưa nhận dạng'}" không khớp hồ sơ ${member.name}.`;
      setDigitizationError(message);
      showToast(message, 'error');
      return false;
    }
    const profile = profilesRef.current[member.id] || profiles[member.id];
    if (!profile) {
      showToast(`Không tải được hồ sơ của ${member.name}; tài liệu chưa được gán.`, 'error');
      return false;
    }
    const extracted = draft.extracted;
    const event: HealthEvent = cleanAndDeduplicateEventData({
      id: `event_${crypto.randomUUID()}`,
      sourceFileId: draft.source.id,
      sourceFileName: draft.source.name,
      type: validEventType(extracted.type || 'other'),
      title: extracted.title?.trim() || draft.source.name || 'Hồ sơ y tế mới',
      date: validDateOrEmpty(extracted.date),
      facility: extracted.facility,
      doctorName: extracted.doctorName,
      customCategory: extracted.customCategory,
      physicalExam: extracted.physicalExam,
      diagnoses: extracted.diagnoses || [],
      medications: extracted.medications || [],
      metrics: extracted.metrics || [],
      imagingResults: extracted.imagingResults || [],
      vaccinations: extracted.vaccinations || [],
      hospitalization: cleanHospitalizationRecord(extracted.hospitalization),
      advice: extracted.advice,
      nextFollowUp: extracted.nextFollowUp,
      notes: extracted.notes,
      patientName: extracted.patientName?.trim() || undefined,
      patientBirthDate: extracted.patientBirthDate,
      patientGender: extracted.patientGender,
      extractedData: isRecord(extracted.extractedData)
        ? extracted.extractedData as Record<string, JsonValue>
        : undefined,
      recordedAt: new Date().toISOString(),
    });
    const duplicate = detectDuplicateEvent(profile.timeline, {
      ...extracted,
      sourceFileId: draft.source.id,
    });
    digitizationLogger.log(
      'info',
      'dedup_check',
      duplicate
        ? `Phát hiện sự kiện trùng ngày/loại: "${duplicate.matchedEvent.title}" (ID: ${duplicate.matchedEvent.id}). Tự động chọn giải pháp: HỢP NHẤT (Merge)`
        : `Không phát hiện sự kiện trùng lặp trên dòng thời gian của ${member.name}. Tự động tạo sự kiện mới.`,
      { duplicateFound: Boolean(duplicate), matchedEventId: duplicate?.matchedEvent.id, title: duplicate?.matchedEvent.title }
    );
    const formData = new FormData();
    formData.set('duplicateResolution', duplicate ? 'merge' : 'create_new');
    formData.set('matchedEventId', duplicate?.matchedEvent.id || '');
    const saved = await handleSaveDigitization(formData, {
      draft,
      member,
      event,
      duplicateResolution: duplicate ? 'merge' : 'create_new',
      matchedEventId: duplicate?.matchedEvent.id,
      subjectManuallyConfirmed,
    });
    if (saved) {
      forgetOcrRecoveryJob(draft.source.id);
      setDigitizationError('');
      showToast(`Đã tự động lưu tài liệu cho ${member.name}.`, 'success');
    }
    return saved;
  }
  async function createMemberForUnresolvedSubject(name: string) {
    const draft = identityResolutionDraft;
    if (!draft || isCreatingSubjectMember) return;
    setIsCreatingSubjectMember(true);
    setDigitizationError('');
    try {
      const currentWorkspace = workspaceRef.current;
      if (!currentWorkspace) throw new Error('Không tìm thấy Workspace hiện tại.');
      const cleanName = name.trim();
      if (!isRecognizablePatientName(cleanName)) {
        throw new Error('Vui lòng nhập họ tên hợp lệ cho hồ sơ thành viên mới.');
      }
      let targetMember = pendingSubjectMember &&
        pendingSubjectMember.name === cleanName &&
        currentWorkspace.family.members.some((member) => member.id === pendingSubjectMember.id)
        ? pendingSubjectMember
        : undefined;
      if (!targetMember) {
        const placeholderMember = currentWorkspace.family.members.find((candidate) => {
          const profile = profilesRef.current[candidate.id] || profiles[candidate.id];
          const isPlaceholder = candidate.name === 'Thành viên mới' ||
            candidate.name === 'Gia đình' ||
            candidate.name.toLowerCase().includes('thanh vien');
          return isPlaceholder && Boolean(profile && profile.timeline.length === 0);
        });
        const memberId = placeholderMember?.id || `member_${crypto.randomUUID().slice(0, 12)}`;
        const updatedWorkspace = placeholderMember && isWorkspaceAdmin
          ? await updateDriveFamilyMember(currentWorkspace, memberId, {
              name: cleanName,
              birthDate: draft.extracted.patientBirthDate || undefined,
              gender: genderFromOcr(draft.extracted.patientGender, placeholderMember.gender),
            })
          : await addDriveFamilyMember(currentWorkspace, {
              id: memberId,
              name: cleanName,
              birthDate: draft.extracted.patientBirthDate || undefined,
              gender: genderFromOcr(draft.extracted.patientGender),
              role: 'other',
            });
        workspaceRef.current = updatedWorkspace;
        setWorkspace(updatedWorkspace);
        profilesRef.current = await reloadProfiles(updatedWorkspace);
        targetMember = updatedWorkspace.family.members.find((member) => member.id === memberId);
        if (!targetMember) throw new Error('Không tải được hồ sơ thành viên vừa tạo.');
        setPendingSubjectMember(targetMember);
      }
      setSelectedMemberId(targetMember.id);
      selectedMemberIdRef.current = targetMember.id;
      const saved = await saveExtractedDocumentAutomatically(draft, targetMember, true);
      if (!saved) throw new Error('Đã tạo thành viên nhưng chưa lưu được dữ liệu OCR. Hãy thử lại.');
      setIdentityResolutionDraft(null);
      setPendingSubjectMember(null);
      processNextInQueue(draft.queueContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể tạo thành viên và gán dữ liệu OCR.';
      setDigitizationError(message);
      showToast(message, 'error');
    } finally {
      setIsCreatingSubjectMember(false);
    }
  }
  async function assignUnresolvedSubjectToMember(targetMember: FamilyMember) {
    const draft = identityResolutionDraft;
    if (!draft || isCreatingSubjectMember) return;
    setIsCreatingSubjectMember(true);
    setDigitizationError('');
    try {
      setSelectedMemberId(targetMember.id);
      selectedMemberIdRef.current = targetMember.id;
      const saved = await saveExtractedDocumentAutomatically(draft, targetMember, true);
      if (!saved) throw new Error(`Chưa lưu được dữ liệu OCR vào hồ sơ của ${targetMember.name}. Hãy thử lại.`);
      setIdentityResolutionDraft(null);
      setPendingSubjectMember(null);
      showToast(`Đã gán tài liệu vào hồ sơ của ${targetMember.name}.`, 'success');
      processNextInQueue(draft.queueContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể gán dữ liệu OCR vào hồ sơ thành viên.';
      setDigitizationError(message);
      showToast(message, 'error');
    } finally {
      setIsCreatingSubjectMember(false);
    }
  }
  function handleCancelBatchQueue() {
    if (queueErrorAdvanceTimerRef.current !== null) {
      window.clearTimeout(queueErrorAdvanceTimerRef.current);
      queueErrorAdvanceTimerRef.current = null;
    }
    activeQueueRunIdRef.current = null;
    activeQueueItemTokenRef.current = null;
    completedQueueTokensRef.current.clear();
    activeUploadOpRef.current = null;
    isUploadingRef.current = false;
    setIsUploading(false);
    processingPendingUploadIdsRef.current.clear();
    uploadQueueRef.current = [];
    pendingUploadIdsRef.current = [];
    setUploadQueue([]);
    updateQueueStatus(null);
    pickedMemberIdForBatchRef.current = undefined;
    batchStagingMemberIdRef.current = undefined;
    setIdentityResolutionDraft(null);
    setPendingSubjectMember(null);
    showToast('Đã dừng toàn bộ hàng đợi xử lý.', 'info');
  }
  function deferUnresolvedSubject() {
    const draftContext = identityResolutionDraft?.queueContext;
    setIdentityResolutionDraft(null);
    setPendingSubjectMember(null);
    setDigitizationError('');
    showToast(
      workspaceRef.current?.rootFolderId === 'local_offline_workspace'
        ? 'Tài liệu vẫn được giữ trên thiết bị và chưa gán vào hồ sơ nào. Có thể chạy lại OCR sau.'
        : 'Tài liệu vẫn được giữ trên Drive và chưa gán vào hồ sơ nào. Có thể chạy lại OCR sau.',
      'info',
    );
    processNextInQueue(draftContext);
  }
  async function retryDigitization() {
    const file = trackerState.file;
    const member = members.find((item) => item.id === trackerState.memberId);
    if (!file || !member) return;
    if (!trackerState.driveFile) {
      void beginDigitization(file, {
        forceUpload: true,
        queueContext: trackerState.queueContext,
      });
      return;
    }
    const opToken = trackerState.queueContext?.itemToken || `retry_${Date.now()}`;
    beginUploadOp(opToken);
    setDigitizationError('');
    setTrackerState((prev) => ({
      ...prev,
      isOpen: true,
      step: 'reading_document',
      progressPercent: 45,
      progressMessage: 'Đang thử lại OCR với tài liệu đã lưu trên Drive...',
      partialExtracted: {},
      error: null,
    }));
    try {
      const profile = profiles[member.id];
      if (!profile) {
        throw new Error('Không tải được hồ sơ thành viên. Hãy tải lại hồ sơ trước khi thử OCR.');
      }
      if (!profile.sources.some((source) => source.driveFileId === trackerState.driveFile?.id)) {
        const { hash } = await computeFileFingerprint(file);
        const source: HealthSource = {
          driveFileId: trackerState.driveFile.id,
          fileName: trackerState.driveFile.name,
          fileSize: file.size,
          fileHash: hash,
          mimeType: trackerState.driveFile.mimeType || file.type || 'application/octet-stream',
          uploadedAt: trackerState.driveFile.createdTime || new Date().toISOString(),
          status: 'pending',
        };
        const savedProfile = await saveHealthProfile(
          member.profileFileId,
          addHealthSource(profile, source),
        );
        setProfiles((prev) => ({ ...prev, [member.id]: savedProfile }));
      }
      await runDocumentExtraction(file, member, trackerState.driveFile.id, undefined, trackerState.queueContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể chuẩn bị tài liệu để thử OCR.';
      setDigitizationError(message);
      setTrackerState((prev) => ({
        ...prev,
        step: 'error',
        progressMessage: 'Không thể chuẩn bị tài liệu để thử lại',
        error: message,
      }));
    } finally {
      endUploadOp(opToken);
    }
  }
  async function resumeInterruptedOcr(job: OcrRecoveryJob) {
    if (queueStatusRef.current || activeQueueRunIdRef.current !== null || isUploadingRef.current) {
      showToast('Hãy đợi hàng đợi tải lên hiện tại hoàn tất rồi chạy lại OCR.', 'info');
      return;
    }
    const member = members.find((candidate) =>
      profiles[candidate.id]?.sources.some((source) => source.driveFileId === job.driveFileId),
    );
    const source = member
      ? profiles[member.id]?.sources.find((item) => item.driveFileId === job.driveFileId)
      : undefined;
    if (!member || !source) {
      showToast('Không tìm thấy nguồn tài liệu trong hồ sơ Drive. Hãy tải lại hồ sơ gia đình rồi thử lại.', 'error');
      return;
    }
    const opToken = `resume_${job.driveFileId}_${Date.now()}`;
    beginUploadOp(opToken);
    try {
      const blob = job.driveFileId.startsWith('local_file_')
        ? await fileFromLocalSource(job.driveFileId, offlineOwnerKey || 'apk-local-device')
        : await downloadDriveFile(job.driveFileId);
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new Error('Tài liệu trên Drive vượt quá giới hạn 30 MB.');
      }
      const file = new File([blob], source.fileName, { type: source.mimeType });
      const driveFile: DriveFile = {
        id: source.driveFileId,
        name: source.fileName,
        mimeType: source.mimeType,
        createdTime: source.uploadedAt,
        size: String(source.fileSize || blob.size),
      };
      setSelectedMemberId(member.id);
      setTrackerState({
        isOpen: false,
        file,
        memberId: member.id,
        step: 'reading_document',
        progressPercent: 45,
        progressMessage: 'Đã khôi phục từ Google Drive. Đang chạy lại OCR theo từng phần...',
        driveFile,
        modelUsed: 'gemini-3.5-flash-lite',
        partialExtracted: {},
        error: null,
        queueContext: undefined,
      });
      persistOcrRecoveryJob(job.driveFileId, 'processing', 45);
      await runDocumentExtraction(file, member, job.driveFileId);
    } catch (error) {
      persistOcrRecoveryJob(job.driveFileId, 'interrupted', job.progressPercent);
      showToast(error instanceof Error ? error.message : 'Không thể khôi phục OCR từ Google Drive.', 'error');
    } finally {
      endUploadOp(opToken);
    }
  }
  function handleFileUploadTrigger() {
    if (pickedMemberIdForBatchRef.current !== undefined) {
      fileInputRef.current?.click();
      return;
    }
    setIsFileTriggerActive(true);
    setIsCameraTriggerActive(false);
    setIsQuickActionTriggerActive(false);
    setShowUploadMemberPicker(true);
  }
  function handleQuickActionTrigger() {
    setIsQuickActionTriggerActive(true);
    setIsFileTriggerActive(false);
    setIsCameraTriggerActive(false);
    setShowUploadMemberPicker(true);
  }
  async function handleCameraCapture(skipMemberPicker = false) {
    if (!skipMemberPicker && pickedMemberIdForBatchRef.current === undefined) {
      setIsCameraTriggerActive(true);
      setShowUploadMemberPicker(true);
      return;
    }
    digitizationLogger.log('info', 'camera', 'Mở camera chụp ảnh hồ sơ y tế...');
    try {
      const photo = await CapacitorCamera.getPhoto({
        quality: 85,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
      });
      if (!photo.webPath) {
        digitizationLogger.log('warn', 'camera', 'Không nhận được đường dẫn ảnh từ camera');
        return;
      }
      const response = await fetch(photo.webPath);
      if (!response.ok) throw new Error('Không đọc được ảnh chụp từ camera.');
      const blob = await response.blob();
      const file = new File(
        [blob],
        `kham-benh-${new Date().toISOString().slice(0, 10)}-${Date.now().toString().slice(-4)}.${photo.format || 'jpg'}`,
        { type: blob.type || 'image/jpeg' }
      );
      digitizationLogger.log(
        'info',
        'camera',
        `Chụp ảnh thành công: "${file.name}" (${(file.size / 1024).toFixed(1)} KB, định dạng ${photo.format || 'jpg'})`,
        { fileName: file.name, fileSize: file.size, format: photo.format }
      );
      
      await stageFilesAndStart([file], pickedMemberIdForBatchRef.current);
      
      // Automatic loop for batch capture
      setTimeout(() => {
        void handleCameraCapture(true);
      }, 500);
    } catch (error) {
      // User cancelled or error - stop loop
      setIsCameraTriggerActive(false);
      pickedMemberIdForBatchRef.current = undefined;
      const isCancelled = error instanceof Error && /cancel|cancelled|canceled/i.test(error.message);
      if (isCancelled) {
        digitizationLogger.log('info', 'camera', 'Người dùng đã đóng/hủy chụp ảnh');
      } else {
        digitizationLogger.log(
          'error',
          'camera',
          `Lỗi khi chụp ảnh từ camera: ${error instanceof Error ? error.message : 'Unknown'}`
        );
        if (error instanceof Error) {
          showToast(error.message, 'error');
        }
      }
    }
  }
  async function handleSaveDigitization(
    submitEvent: React.FormEvent<HTMLFormElement> | FormData,
    options: {
      targetMemberId?: string;
      member?: FamilyMember;
      draft?: DigitizationDraft;
      event?: HealthEvent;
      duplicateResolution?: 'merge' | 'replace' | 'create_new';
      matchedEventId?: string;
      subjectManuallyConfirmed?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!(submitEvent instanceof FormData)) submitEvent.preventDefault();
    const effectiveMember =
      options.member ||
      (options.targetMemberId && members.find((m) => m.id === options.targetMemberId)) ||
      selectedMember;
    let effectiveProfile = effectiveMember
      ? profilesRef.current[effectiveMember.id] || profiles[effectiveMember.id]
      : selectedProfile;
    const draft = options.draft || digitizationDraft;
    if (!draft || !effectiveMember || !effectiveProfile) return false;
    if (!options.subjectManuallyConfirmed && !isOcrSubjectMatchedToMember(
      draft.extracted.patientName,
      effectiveMember,
      workspaceRef.current?.family.members || members,
      draft.extracted.patientBirthDate,
      draft.extracted.patientGender,
    )) {
      const message = `Chưa lưu tài liệu: chủ thể OCR "${draft.extracted.patientName || 'chưa nhận dạng'}" không khớp hồ sơ ${effectiveMember.name}.`;
      setDigitizationError(message);
      showToast(message, 'error');
      return false;
    }
    const form = submitEvent instanceof FormData ? submitEvent : new FormData(submitEvent.currentTarget);
    const date = String(form.get('date') || '');
    const title = String(form.get('title') || '').trim();
    const extracted = draft.extracted;
    const duplicateResolution = options.duplicateResolution || String(form.get('duplicateResolution') || 'create_new') as
      | 'merge'
      | 'replace'
      | 'create_new';
    const matchedEventId = options.matchedEventId || String(form.get('matchedEventId') || '');
    const rawEvent: HealthEvent = options.event || {
      id: `event_${crypto.randomUUID()}`,
      sourceFileId: draft.source.id,
      sourceFileName: draft.source.name,
      type: validEventType(String(form.get('type') || extracted.type)),
      title: title || 'Hồ sơ y tế mới',
      date,
      facility: String(form.get('facility') || '').trim() || undefined,
      doctorName: extracted.doctorName,
      customCategory: extracted.customCategory,
      physicalExam: extracted.physicalExam,
      diagnoses: splitLines(String(form.get('diagnoses') || '')),
      medications: parseMedicationLines(String(form.get('medications') || '')),
      metrics: parseMetricLines(String(form.get('metrics') || '')),
      imagingResults: extracted.imagingResults || [],
      vaccinations: extracted.vaccinations || [],
      hospitalization: cleanHospitalizationRecord(extracted.hospitalization),
      advice: String(form.get('advice') || '').trim() || undefined,
      nextFollowUp: String(form.get('nextFollowUp') || '').trim() || undefined,
      notes: String(form.get('notes') || '').trim() || undefined,
      patientName: extracted.patientName,
      patientBirthDate: extracted.patientBirthDate,
      patientGender: extracted.patientGender,
      extractedData: isRecord(extracted.extractedData)
        ? (extracted.extractedData as Record<string, JsonValue>)
        : undefined,
      recordedAt: new Date().toISOString(),
    };
    // Khử trùng lặp nội dung bên trong (chẩn đoán, thuốc, chỉ số đo)
    const nextEvent = options.event || cleanAndDeduplicateEventData(rawEvent);
    try {
      const currentProfiles = profilesRef.current;
      const latestMembers = workspaceRef.current?.family.members || members;
      const sourceOwner = latestMembers.find((member) =>
        currentProfiles[member.id]?.sources.some(
          (source) => source.driveFileId === draft.source.id && !source.relocatedToMemberId,
        ),
      );
      const priorSource = Object.values(currentProfiles)
        .flatMap((profile) => profile.sources)
        .find((source) => source.driveFileId === draft.source.id);
      const { relocatedToMemberId: _previousOwner, ...sourceBase } = priorSource || {
        driveFileId: draft.source.id,
        fileName: draft.source.name,
        mimeType: draft.source.mimeType || 'application/octet-stream',
        uploadedAt: draft.source.createdTime || new Date().toISOString(),
        status: 'pending' as const,
      };
      const contentIndex = createDocumentContentIndex(draft.contentIndexPages);
      const sourceContributions = [
        ...(sourceBase.sourceContributions || []),
        ...(draft.sourceContributions || []),
      ].filter((item, index, list) =>
        list.findIndex((candidate) =>
          candidate.fileHash === item.fileHash &&
          candidate.hashAlgorithm === item.hashAlgorithm &&
          candidate.fileName === item.fileName,
        ) === index,
      );
      const resolvedProcessedPages = Math.max(
        sourceBase.processedPages || 0,
        sourceBase.totalPages || 0,
        contentIndex.pages.length || 0,
        1,
      );
      const targetSource: HealthSource = {
        ...sourceBase,
        status: priorSource?.status || 'pending',
        subjectStatus: undefined,
        relocatedToMemberId: undefined,
        totalPages: sourceBase.totalPages || Math.max(contentIndex.pages.length || 0, 1),
        processedPages: resolvedProcessedPages,
        contentIndexPages: sourceBase.contentIndexComplete
          ? sourceBase.contentIndexPages
          : contentIndex.pages,
        contentIndexComplete: sourceBase.contentIndexComplete ||
          (draft.contentIndexComplete && contentIndex.complete),
        sourceContributions: sourceContributions.length ? sourceContributions : undefined,
      };
      if (sourceOwner?.id !== effectiveMember.id) {
       let driveFileMoved = false;
       try {
         await moveDriveFileToMember(draft.source.id, effectiveMember);
         driveFileMoved = true;
         const targetWithSource = effectiveProfile.sources.some((s) => s.driveFileId === draft.source.id)
           ? {
               ...effectiveProfile,
               sources: effectiveProfile.sources.map((s) =>
                 s.driveFileId === draft.source.id ? { ...s, ...targetSource } : s,
               ),
             }
           : addHealthSource(effectiveProfile, targetSource);
         effectiveProfile = await saveHealthProfile(effectiveMember.profileFileId, targetWithSource);
         currentProfiles[effectiveMember.id] = effectiveProfile;
         profilesRef.current = currentProfiles;
         setProfiles((previous) => ({ ...previous, [effectiveMember.id]: effectiveProfile! }));
         if (sourceOwner) {
           const ownerProfile = currentProfiles[sourceOwner.id];
           if (ownerProfile) {
             const relocatedProfile: HealthProfile = {
               ...ownerProfile,
               sources: ownerProfile.sources.map((source) =>
                 source.driveFileId === draft.source.id
                   ? { ...source, subjectStatus: undefined, relocatedToMemberId: effectiveMember.id }
                   : source,
               ),
               updatedAt: new Date().toISOString(),
             };
             const savedOwner = await saveHealthProfile(sourceOwner.profileFileId, relocatedProfile);
             currentProfiles[sourceOwner.id] = savedOwner;
             setProfiles((previous) => ({ ...previous, [sourceOwner.id]: savedOwner }));
           }
         }
       } catch (transferError) {
         if (driveFileMoved && sourceOwner) {
           try {
             await moveDriveFileToMember(draft.source.id, sourceOwner);
           } catch (rollbackError) {
             const originalMessage = transferError instanceof Error ? transferError.message : 'Lỗi chưa xác định.';
             const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : 'Lỗi chưa xác định.';
             throw new Error(
               `Không thể hoàn tất chuyển tài liệu (${originalMessage}). Cũng không thể chuyển tệp về thư mục ban đầu (${rollbackMessage}). Hãy kiểm tra hai hồ sơ trên Drive trước khi tiếp tục.`,
             );
           }
         }
         throw transferError;
       }
      } else if (!effectiveProfile.sources.some((source) => source.driveFileId === draft.source.id)) {
        effectiveProfile = await saveHealthProfile(
          effectiveMember.profileFileId,
          addHealthSource(effectiveProfile, targetSource),
        );
        currentProfiles[effectiveMember.id] = effectiveProfile;
        profilesRef.current = currentProfiles;
        setProfiles((previous) => ({ ...previous, [effectiveMember.id]: effectiveProfile! }));
      } else {
        effectiveProfile = {
          ...effectiveProfile,
          sources: effectiveProfile.sources.map((source) =>
            source.driveFileId === draft.source.id
              ? {
                  ...source,
                  ...targetSource,
                  status: source.status,
                }
              : source,
          ),
        };
      }
      const existingMatch = matchedEventId
        ? effectiveProfile.timeline.find((item) => item.id === matchedEventId)
        : null;
      const saveProfileTimer = digitizationLogger.startTimer();
      if (duplicateResolution === 'merge' && existingMatch) {
        let preMergeContainmentHint:
          | {
              existingSourceId: string;
              relation: 'left_contains_right' | 'right_contains_left' | 'equivalent';
            }
          | undefined;
        if (existingMatch.sourceFileId && existingMatch.sourceFileId !== draft.source.id) {
          const structRelation = compareStructuredEventContainment(existingMatch, nextEvent);
          if (structRelation !== 'none') {
            preMergeContainmentHint = {
              existingSourceId: existingMatch.sourceFileId,
              relation: structRelation,
            };
          }
        }
        // 1. Hợp nhất thông minh sự kiện cũ và mới (giữ lại chỉ số, thuốc, bổ sung cái mới)
        const mergedEvent = mergeHealthEvents(existingMatch, nextEvent);
        const updatedTimeline = effectiveProfile.timeline.map((item) =>
          item.id === matchedEventId ? mergedEvent : item
        );
        const updatedSources = effectiveProfile.sources.map((item) =>
          item.driveFileId === draft.source.id
            ? {
                ...item,
                status: 'processed' as const,
                subjectStatus: undefined,
                digitizedAt: new Date().toISOString(),
                processedPages: Math.max(item.processedPages || 0, item.totalPages || 0, resolvedProcessedPages),
                contentIndexPages: item.contentIndexComplete ? item.contentIndexPages : targetSource.contentIndexPages,
                contentIndexComplete: item.contentIndexComplete || targetSource.contentIndexComplete,
                sourceContributions: targetSource.sourceContributions,
              }
            : item
        );
        const nextProfile: HealthProfile = {
          ...effectiveProfile,
          timeline: updatedTimeline,
          sources: updatedSources,
          summary: summarizeTimeline(updatedTimeline, effectiveProfile.summary.narrative),
          updatedAt: new Date().toISOString(),
        };
        const saved = await saveHealthProfile(effectiveMember.profileFileId, nextProfile);
        const saveMs = saveProfileTimer();
        currentProfiles[effectiveMember.id] = saved;
        profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: saved };
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: saved }));
        await cleanupContainedRawDocuments(effectiveMember, draft.source.id, preMergeContainmentHint);
        forgetOcrRecoveryJob(draft.source.id);
        setSelectedMemberId(effectiveMember.id);
        selectedMemberIdRef.current = effectiveMember.id;
        setDigitizationDraft(null);
        setDigitizationError('');
        digitizationLogger.log(
          'info',
          'save_merged',
          `Hợp nhất thành công vào sự kiện "${existingMatch.title}" của ${effectiveMember.name} trong ${saveMs}ms`,
          { eventId: existingMatch.id, memberName: effectiveMember.name, durationMs: saveMs },
          saveMs
        );
        showToast(
          `Đã hợp nhất dữ liệu vào hồ sơ "${existingMatch.title}" của ${effectiveMember.name}.`,
          'success'
        );
        if (!queueStatusRef.current || queueStatusRef.current.total <= 1) {
          setActiveTab('timeline');
        }
        processNextInQueue(draft.queueContext);
        return true;
      } else if (duplicateResolution === 'replace' && existingMatch) {
        // 2. Ghi đè toàn bộ sự kiện cũ bằng dữ liệu mới nhất
        const replacedEvent: HealthEvent = {
          ...nextEvent,
          id: matchedEventId,
          recordedAt: new Date().toISOString(),
        };
        const updatedTimeline = effectiveProfile.timeline.map((item) =>
          item.id === matchedEventId ? replacedEvent : item
        );
        const updatedSources = effectiveProfile.sources.map((item) =>
          item.driveFileId === draft.source.id
            ? {
                ...item,
                status: 'processed' as const,
                subjectStatus: undefined,
                digitizedAt: new Date().toISOString(),
                processedPages: Math.max(item.processedPages || 0, item.totalPages || 0, resolvedProcessedPages),
                contentIndexPages: item.contentIndexComplete ? item.contentIndexPages : targetSource.contentIndexPages,
                contentIndexComplete: item.contentIndexComplete || targetSource.contentIndexComplete,
                sourceContributions: targetSource.sourceContributions,
              }
            : item
        );
        const nextProfile: HealthProfile = {
          ...effectiveProfile,
          timeline: updatedTimeline,
          sources: updatedSources,
          summary: summarizeTimeline(updatedTimeline, effectiveProfile.summary.narrative),
          updatedAt: new Date().toISOString(),
        };
        const saved = await saveHealthProfile(effectiveMember.profileFileId, nextProfile);
        const saveMs = saveProfileTimer();
        currentProfiles[effectiveMember.id] = saved;
        profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: saved };
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: saved }));
        await cleanupContainedRawDocuments(effectiveMember, draft.source.id);
        forgetOcrRecoveryJob(draft.source.id);
        setSelectedMemberId(effectiveMember.id);
        selectedMemberIdRef.current = effectiveMember.id;
        setDigitizationDraft(null);
        setDigitizationError('');
        digitizationLogger.log(
          'info',
          'save_replaced',
          `Ghi đè thành công sự kiện "${existingMatch.title}" của ${effectiveMember.name} trong ${saveMs}ms`,
          { eventId: existingMatch.id, memberName: effectiveMember.name, durationMs: saveMs },
          saveMs
        );
        showToast(
          `Đã cập nhật ghi đè hồ sơ "${existingMatch.title}" của ${effectiveMember.name}.`,
          'success'
        );
        if (!queueStatusRef.current || queueStatusRef.current.total <= 1) {
          setActiveTab('timeline');
        }
        processNextInQueue(draft.queueContext);
        return true;
      } else {
        // 3. Tạo sự kiện mới độc lập
        const digitized = digitizeHealthSource(effectiveProfile, nextEvent);
        const nextProfile: HealthProfile = {
          ...digitized,
          sources: digitized.sources.map((item) =>
            item.driveFileId === draft.source.id
              ? {
                  ...item,
                  processedPages: Math.max(item.processedPages || 0, item.totalPages || 0, resolvedProcessedPages),
                  contentIndexPages: item.contentIndexComplete ? item.contentIndexPages : targetSource.contentIndexPages,
                  contentIndexComplete: item.contentIndexComplete || targetSource.contentIndexComplete,
                  sourceContributions: targetSource.sourceContributions,
                }
              : item,
          ),
        };
        const merged = await saveHealthProfile(effectiveMember.profileFileId, nextProfile);
        const saveMs = saveProfileTimer();
        currentProfiles[effectiveMember.id] = merged;
        profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: merged };
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: merged }));
        await cleanupContainedRawDocuments(effectiveMember, draft.source.id);
        forgetOcrRecoveryJob(draft.source.id);
        setSelectedMemberId(effectiveMember.id);
        selectedMemberIdRef.current = effectiveMember.id;
        setDigitizationDraft(null);
        setDigitizationError('');
        digitizationLogger.log(
          'info',
          'save_new',
          `Lưu thành công sự kiện mới "${nextEvent.title}" cho ${effectiveMember.name} trong ${saveMs}ms`,
          { eventId: nextEvent.id, memberName: effectiveMember.name, durationMs: saveMs },
          saveMs
        );
        showToast(`Đã lưu hồ sơ sức khỏe cho ${effectiveMember.name} lên Google Drive.`, 'success');
        if (!queueStatusRef.current || queueStatusRef.current.total <= 1) {
          setActiveTab('timeline');
        }
        processNextInQueue(draft.queueContext);
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể lưu hồ sơ.';
      digitizationLogger.log('error', 'save_error', `Lỗi khi lưu hồ sơ sức khỏe: ${message}`, { error: message });
      setDigitizationError(message);
      showToast(message, 'error');
      return false;
    }
  }
  async function handleAskAssistant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember || !selectedProfile || !chatInput.trim()) return;
    const question = chatInput.trim();
    const requestId = ++chatRequestIdRef.current;
    const assistantMsgId = `assistant_${requestId}_${Date.now()}`;
    const requestMemberId = selectedMember.id;
    const requestWorkspaceRootId = workspaceRef.current?.rootFolderId;
    const requestUserEmail = authIdentityRef.current.userEmail;
    const isCurrentRequest = () =>
      requestId === chatRequestIdRef.current &&
      selectedMemberIdRef.current === requestMemberId &&
      workspaceRef.current?.rootFolderId === requestWorkspaceRootId &&
      authIdentityRef.current.userEmail === requestUserEmail;
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const history = chatMessages.slice(-10).map(({ role, text }) => ({ role, text }));
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', text: question, timestamp: timeStr }]);
    setIsChatting(true);

    let streamedText = '';
    let streamedCitations: HealthAssistantCitation[] = [];
    const upsertAssistantDraft = (nextText: string, nextCitations: HealthAssistantCitation[], finalTimestamp?: string) => {
      setChatMessages((prev) => {
        const existingIndex = prev.findIndex((msg) => msg.id === assistantMsgId);
        const draftMessage: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          text: nextText,
          citations: nextCitations,
          ...(finalTimestamp ? { timestamp: finalTimestamp } : {}),
        };
        if (existingIndex === -1) {
          return [...prev, draftMessage];
        }
        return prev.map((msg, idx) => (idx === existingIndex ? draftMessage : msg));
      });
    };

    try {
      const { answer, citations } = await streamHealthAssistant(
        question,
        selectedMember,
        selectedProfile,
        (chunk) => {
          if (!isCurrentRequest()) return;
          streamedText += chunk;
          upsertAssistantDraft(streamedText, streamedCitations);
        },
        history,
        (sources) => {
          if (!isCurrentRequest()) return;
          streamedCitations = sources;
          if (streamedText) {
            upsertAssistantDraft(streamedText, streamedCitations);
          }
        },
      );
      if (!isCurrentRequest()) return;
      const finalAnswer = answer.trim() || streamedText;
      const finalCitations = citations.length > 0 ? citations : streamedCitations;
      upsertAssistantDraft(
        finalAnswer || 'Trợ lý AI chưa có phản hồi phù hợp. Vui lòng thử lại.',
        finalCitations,
        new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      );
    } catch (error) {
      if (!isCurrentRequest()) return;
      const errorText =
        error instanceof Error
          ? error.message
          : 'Không thể kết nối trợ lý AI lúc này. Vui lòng thử lại.';
      upsertAssistantDraft(
        streamedText ? `${streamedText}\n\n(${errorText})` : errorText,
        streamedCitations,
        new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      );
    } finally {
      if (isCurrentRequest()) setIsChatting(false);
    }
  }
  async function handleAiSummary(model: string = 'gemini-4-hydrogen') {
    if (!selectedMember || !selectedProfile) return;
    setIsSummarizing(true);
    setAnalysisError('');
    digitizationLogger.log('info', 'analysis', `Bắt đầu phân tích chuyên sâu (${model})`, { memberId: selectedMember.id });
    
    try {
      // Step 1: Narrative Summary (3.5-flash-lite)
      showToast('Đang tạo đánh giá tổng quan...', 'info');
      const narrative = await summarizeHealthProfile(selectedMember, selectedProfile);
      
      // Step 2: Comprehensive 4-Layer Analysis
      showToast('Đang phân tích 4 lớp y khoa chuyên sâu bằng AI...', 'info');
      const deepRes = await analyzeComprehensiveHealth(selectedMember, selectedProfile, model);
      
      const updated: HealthProfile = {
        ...selectedProfile,
        summary: { ...selectedProfile.summary, narrative },
        aiDeepAnalysis: deepRes.result,
        aiAnalysis: deepRes.aiAnalysis,
        updatedAt: new Date().toISOString(),
      };
      
      const saved = await saveHealthProfile(selectedMember.profileFileId, updated);
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: saved }));
      digitizationLogger.log('info', 'analysis', 'Hoàn tất phân tích chuyên sâu', { memberId: selectedMember.id });
      showToast(`Đã hoàn tất phân tích 4 lớp y khoa chuyên sâu bằng AI!`, 'success');
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : 'Không thể tạo tổng kết bệnh án.';
      let friendlyMsg = rawMsg;
      if (rawMsg.includes('{') && rawMsg.includes('error')) {
        try {
          const parsed = JSON.parse(rawMsg);
          if (parsed?.error?.message) {
            friendlyMsg = `Máy chủ AI Google đang bận (${parsed.error.code || 503}): ${parsed.error.message}`;
          }
        } catch {
          // ignore
        }
      }
      setAnalysisError(friendlyMsg);
      digitizationLogger.log('error', 'analysis', 'Lỗi phân tích chuyên sâu');
      showToast(friendlyMsg, 'error');
    } finally {
      setIsSummarizing(false);
    }
  }
  async function handleRefineAndOrganize() {
    if (!selectedMember || !selectedProfile) return;
    if (!selectedProfile.timeline || selectedProfile.timeline.length === 0) {
      showToast('Chưa có dữ liệu y tế nào để hiệu chỉnh. Hãy tải tệp hoặc chụp tài liệu khám bệnh trước.', 'info');
      return;
    }
    setIsRefining(true);
    try {
      const { organizedTimeline } = await refineAndOrganizeMemberData(
        selectedMember,
        selectedProfile.timeline
      );
      const currentEvents = new Map(selectedProfile.timeline.map((event) => [event.id, event]));
      const proposedIds = organizedTimeline.map((event) => event.id);
      if (
        organizedTimeline.length !== currentEvents.size ||
        new Set(proposedIds).size !== currentEvents.size ||
        proposedIds.some((id) => !currentEvents.has(id))
      ) {
        throw new Error('AI trả về danh sách sự kiện không khớp hồ sơ gốc. Không có dữ liệu nào được thay đổi.');
      }
      const { timeline: finalTimeline, mergedCount } = consolidateTimelineEvents(organizedTimeline);
      const updatedProfile: HealthProfile = {
        ...selectedProfile,
        timeline: finalTimeline,
        summary: summarizeTimeline(finalTimeline, selectedProfile.summary.narrative),
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveHealthProfile(selectedMember.profileFileId, updatedProfile);
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: saved }));
      showToast(
        mergedCount > 0
          ? `Đã chuẩn hóa danh pháp & gộp ${mergedCount} hồ sơ trùng/cùng đợt khám thành công!`
          : 'Đã chuẩn hóa danh pháp y khoa thành công! Bạn có thể bấm "Phân tích chuyên sâu" khi cần.',
        'success',
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Lỗi khi hiệu chỉnh dữ liệu.', 'error');
    } finally {
      setIsRefining(false);
    }
  }
  async function handleInviteWorkspaceMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !userEmail || !isWorkspaceAdmin) return;
    const email = inviteEmail.trim().toLowerCase();
    setIsLoading(true);
    setErrorMessage('');
    try {
      const assignments = new Map(
        workspaceAssignments
          .filter((a) => a.memberEmail !== email)
          .map((a) => [a.memberEmail, { role: a.role, source: a.source }])
      );
      assignments.set(email, {
        role: inviteRole,
        source: workspace.family.members.some(
          (member) => member.email.trim().toLowerCase() === email,
        ) ? 'family_member' : undefined,
      });
      await ensureDriveFolderAccess(workspace.rootFolderId, email, inviteRole);
      await publishHealthWorkspaceAssignments(
        workspace.rootFolderId,
        workspace.familyFileId,
        userEmail,
        [...assignments].map(([memberEmail, assignment]) => ({
          email: memberEmail,
          role: assignment.role,
          source: assignment.source,
        }))
      );
      setInviteEmail('');
      await reloadWorkspaceAssignments();
      showToast(
        `Đã cấp quyền Drive và gửi lời mời Workspace cho ${email}.`,
        'success'
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể gửi lời mời Workspace.'
      );
    } finally {
      setIsLoading(false);
    }
  }
  async function handleRevokeWorkspaceMember(memberEmail: string) {
    if (!workspace || !isWorkspaceAdmin) return;
    setIsLoading(true);
    setErrorMessage('');
    try {
      await revokeDriveFolderAccess(workspace.rootFolderId, memberEmail);
      await removeHealthWorkspaceAssignment(workspace.rootFolderId, memberEmail);
      await reloadWorkspaceAssignments();
      showToast('Đã thu hồi quyền Drive và xóa lời mời Workspace.', 'success');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể thu hồi quyền chia sẻ.'
      );
    } finally {
      setIsLoading(false);
    }
  }
  const handleRootTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) {
      swipeTouchStartRef.current = null;
      return;
    }
    const touch = event.touches[0];
    swipeTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
      ignoreTabSwipe: shouldIgnoreHorizontalSwipeStart(event.target, mainContentRef.current),
    };
  };

  const handleRootTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = swipeTouchStartRef.current;
    swipeTouchStartRef.current = null;
    if (!start || event.changedTouches.length !== 1) return;

    const touch = event.changedTouches[0];
    const hasBlockingOverlay = hasActiveBackHandlers(BackPriority.SHEET);
    const outcome = evaluateHorizontalGesture({
      startX: start.x,
      startY: start.y,
      endX: touch.clientX,
      endY: touch.clientY,
      durationMs: Date.now() - start.time,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
      allowTabSwipe: Boolean(workspace) && !hasBlockingOverlay,
      ignoredByTarget: start.ignoreTabSwipe,
    });

    if (outcome === 'edge_back') {
      handleBackNavigation();
      return;
    }

    if (outcome === 'swipe_next_tab' || outcome === 'swipe_prev_tab') {
      const currentIdx = DASHBOARD_TAB_ORDER.indexOf(activeTabRef.current);
      if (currentIdx === -1) return;
      const nextIdx = outcome === 'swipe_next_tab' ? currentIdx + 1 : currentIdx - 1;
      if (nextIdx >= 0 && nextIdx < DASHBOARD_TAB_ORDER.length) {
        setActiveTab(DASHBOARD_TAB_ORDER[nextIdx], {
          direction: outcome === 'swipe_next_tab' ? 'left' : 'right',
        });
      }
    }
  };

  return (
    <div
      onTouchStart={handleRootTouchStart}
      onTouchEnd={handleRootTouchEnd}
      onTouchCancel={() => {
        swipeTouchStartRef.current = null;
      }}
      className="h-[100dvh] min-h-0 overflow-hidden bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-emerald-100 selection:text-emerald-900"
    >
      {/* 1. TOP BAR CONTRACT: One row, clean zones, thumb-friendly safe area */}
      <header className="sticky top-0 z-30 shrink-0 bg-white/95 backdrop-blur-md border-b border-slate-200/80 safe-area-header shadow-xs">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-2 flex items-center justify-between gap-2">
          {/* Zone 1: Brand Wordmark & Logo */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <AppLogo size="sm" />
            <div className="min-w-0">
              <span className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 truncate block">
                Sức Khỏe Gia Đình
              </span>
              <div className="flex items-center gap-1.5 text-[10px]">
                {syncStatus === 'syncing' ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping shrink-0" />
                    <span className="truncate font-bold text-amber-700 animate-pulse">Đang đồng bộ</span>
                  </>
                ) : syncStatus === 'busy' ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 shrink-0" />
                    <span className="truncate font-semibold text-sky-700">Đang xử lý</span>
                  </>
                ) : syncStatus === 'pending' ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                    <span className="truncate font-semibold text-amber-700">
                      Chờ đồng bộ{pendingLocalUploadCount ? ` (${pendingLocalUploadCount})` : ''}
                    </span>
                  </>
                ) : syncStatus === 'online' ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span className="truncate font-semibold text-emerald-700">Online</span>
                  </>
                ) : syncStatus === 'unlinked' ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                    <span className="truncate font-medium text-slate-500">Chưa liên kết Drive</span>
                  </>
                ) : syncStatus === 'drive_expired' ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 animate-pulse" />
                    <span className="truncate font-semibold text-amber-700">Cần cấp lại quyền Drive</span>
                  </>
                ) : (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                    <span className="truncate font-medium text-slate-500">Offline</span>
                  </>
                )}
              </div>
            </div>
          </div>
          {/* Zone 2: Member & Menu Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {members.length > 0 && (
              <div className="relative" ref={memberMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowMemberDropdown(!showMemberDropdown);
                    setShowSettingsDropdown(false);
                  }}
                  className="flex items-center gap-1 p-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:scale-95 transition-all"
                  title={selectedMember?.name || 'Chọn thành viên'}
                >
                  <span className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                    {selectedMember?.name.charAt(0) || 'U'}
                  </span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                </button>
                {showMemberDropdown && (
                  <div className="absolute right-0 mt-2 w-60 bg-white border border-slate-200 rounded-2xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 duration-150">
                    <div className="px-3 py-1.5 text-[10px] font-black text-slate-400 uppercase tracking-wider">
                      Hồ sơ thành viên
                    </div>
                    <div className="max-h-60 overflow-y-auto space-y-0.5">
                      {members.map((m) => {
                        const isCurrent = m.id === selectedMember?.id;
                        const memberRole = getWorkspaceMemberRole(m, workspace?.family.adminEmail);
                        const count = profiles[m.id]?.timeline?.length || 0;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setSelectedMemberId(m.id);
                              setShowMemberDropdown(false);
                            }}
                            className={`w-full flex items-center justify-between p-2 rounded-xl text-xs font-semibold transition-colors ${
                              isCurrent
                                ? 'bg-emerald-50 text-emerald-800 font-bold'
                                : 'hover:bg-slate-50 text-slate-700'
                            }`}
                          >
                            <div className="flex items-center gap-2 truncate">
                              <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-[11px] shrink-0">
                                {m.name.charAt(0)}
                              </span>
                              <span className="truncate">{m.name}</span>
                              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                                memberRole === 'Admin'
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}>
                                {memberRole}
                              </span>
                            </div>
                            <span className="text-[10px] text-slate-400 font-mono tabular-nums shrink-0">
                              {count} mục
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-1 pt-1 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => {
                          setShowMemberDropdown(false);
                          setActiveTab('family');
                        }}
                        className="w-full flex items-center gap-2 p-2 rounded-xl text-xs text-emerald-700 hover:bg-emerald-50 font-bold"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Thêm người thân...</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Menu / Settings Dropdown Trigger */}
            <div className="relative" ref={settingsMenuRef}>
              <button
                type="button"
                onClick={() => {
                  setShowSettingsDropdown(!showSettingsDropdown);
                  setShowMemberDropdown(false);
                }}
                className="p-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 active:scale-95 transition-all flex items-center justify-center"
                title="Cài đặt & Tiện ích"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {showSettingsDropdown && (
                <div className="absolute right-0 mt-2 w-64 bg-white border border-slate-200 rounded-2xl shadow-xl p-2.5 z-50 animate-in fade-in zoom-in-95 duration-150 space-y-1">
                  {userEmail && (
                    <div className="p-2 bg-slate-50 rounded-xl border border-slate-100 mb-1">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Tài khoản</div>
                      <div className="text-xs font-bold text-slate-800 truncate">{userEmail}</div>
                    </div>
                  )}
                  {/* 1. Đồng bộ dữ liệu */}
                  <button
                    type="button"
                    disabled={isSyncing || isLoading}
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      if (!userEmail || needsDriveAuthorization) {
                        onConnectDrive();
                      } else if (hasRemoteWorkspace) {
                        void handleManualSync();
                      } else {
                        void handleCreateWorkspace();
                      }
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-emerald-50 text-slate-700 hover:text-emerald-900 transition-colors text-left text-xs font-semibold disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <FolderSync className="w-4 h-4 text-emerald-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-800">{driveActionLabel}</div>
                      <div className="text-[10px] text-slate-400 font-normal truncate">
                        {needsDriveAuthorization
                          ? 'Cấp lại quyền truy cập Drive'
                          : hasRemoteWorkspace
                            ? 'Đồng bộ 2 chiều với Drive'
                            : 'Khởi tạo thư mục trên Drive'}
                      </div>
                    </div>
                  </button>
                  {/* 2. Xóa dữ liệu */}
                  <button
                    type="button"
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      void handleFactoryReset();
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-rose-50 text-slate-700 hover:text-rose-900 transition-colors text-left text-xs font-semibold"
                  >
                    <Trash2 className="w-4 h-4 text-rose-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold">Xóa dữ liệu</div>
                      <div className="text-[10px] text-slate-400 font-normal">
                        {isWorkspaceAdmin ? 'Xóa toàn bộ thư mục Drive & thiết bị' : 'Xóa hồ sơ cá nhân & tài liệu raw'}
                      </div>
                    </div>
                  </button>
                  {/* 3. Đăng nhập / Đăng xuất & Kết nối lại Drive */}
                  <div className="pt-0.5 pb-0.5 space-y-1">
                    {userEmail ? (
                      <button
                        type="button"
                        onClick={() => {
                          setShowSettingsDropdown(false);
                          onLogout();
                        }}
                        className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-rose-50 text-rose-600 transition-colors text-left text-xs font-bold"
                      >
                        <LogOut className="w-4 h-4 shrink-0 text-rose-500" />
                        <span>Đăng xuất tài khoản</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setShowSettingsDropdown(false);
                          onConnectDrive();
                        }}
                        className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 transition-colors text-left text-xs font-bold"
                      >
                        <LogIn className="w-4 h-4 shrink-0" />
                        <span>Đăng nhập Google</span>
                      </button>
                    )}
                  </div>
                  {/* 4. Xuất log file */}
                  <button
                    type="button"
                    onClick={async () => {
                      setShowSettingsDropdown(false);
                      try {
                        const success = await digitizationLogger.exportLogsAsFile(undefined, {
                          userEmail,
                          memberCount: members.length,
                          workspaceRoot: workspace?.rootFolderId,
                        });
                        if (success) {
                          showToast('Đã xuất file log trên thiết bị thành công.', 'success');
                        } else {
                          showToast('Không thể tạo file log.', 'error');
                        }
                      } catch (err) {
                        showToast(
                          err instanceof Error
                            ? `Không thể xuất log: ${err.message}`
                            : 'Không thể xuất log từ thiết bị.',
                          'error',
                        );
                      }
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-colors text-left text-xs font-semibold"
                  >
                    <Download className="w-4 h-4 text-teal-600 shrink-0" />
                    <span>Xuất log file</span>
                  </button>
                  {/* 5. Tài nguyên AI */}
                  <button
                    type="button"
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      setShowAiResourcesModal(true);
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-colors text-left text-xs font-semibold"
                  >
                    <KeyRound className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>Tài nguyên AI</span>
                  </button>
                  {/* 6. Phiên bản */}
                  <button
                    type="button"
                    disabled={isCheckingUpdate}
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      void checkAppUpdate(true);
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-colors text-left text-xs font-semibold border-t border-slate-100 mt-1 pt-2"
                  >
                    <div className="flex items-center gap-2.5">
                      <RefreshCw className={`w-4 h-4 text-slate-500 shrink-0 ${isCheckingUpdate ? 'animate-spin text-emerald-600' : ''}`} />
                      <span>Phiên bản</span>
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono">v{appVersion}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      {/* Main Content Area */}
      <main
        ref={mainContentRef}
        className={activeTab === 'assistant'
          ? 'flex-1 min-h-0 max-w-6xl w-full mx-auto px-3 sm:px-4 pt-2 sm:pt-3 assistant-viewport-content overflow-hidden flex flex-col'
          : 'flex-1 min-h-0 overflow-y-auto overscroll-y-contain max-w-6xl w-full mx-auto px-4 py-4 sm:py-6 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]'}>
        {errorMessage && (() => {
          const isDriveApiDisabled =
            errorMessage.includes('drive.googleapis.com') ||
            errorMessage.includes('Google Drive API has not been used') ||
            errorMessage.includes('has not been used in project') ||
            errorMessage.includes('SERVICE_DISABLED') ||
            errorMessage.includes('accessNotConfigured');
          const consoleUrlMatch = errorMessage.match(/https:\/\/[^\s]+/);
          const consoleUrl =
            consoleUrlMatch?.[0] ||
            'https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=637661729068';
          return (
            <div
              role="alert"
              className="mb-4 flex flex-col gap-2 p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-900 text-sm animate-in fade-in"
            >
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-rose-950">
                    {isDriveApiDisabled
                      ? 'Dịch vụ Google Drive API chưa được kích hoạt'
                      : 'Thông báo hệ thống'}
                  </p>
                  <p className="text-xs text-rose-800 mt-1 leading-relaxed">
                    {isDriveApiDisabled
                      ? 'Dự án Google Cloud (637661729068) của ứng dụng chưa bật quyền Google Drive API. Bạn cần bật API này trên Google Cloud Console để ứng dụng có thể tạo thư mục lưu trữ.'
                      : errorMessage}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setErrorMessage('')}
                  className="p-1 rounded-lg text-rose-500 hover:bg-rose-100 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {isDriveApiDisabled && (
                <div className="mt-2 pt-2 border-t border-rose-200/60 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                  <span className="text-[11px] text-rose-700">
                    Nhấn nút bên cạnh để mở Google Cloud Console, bấm <b>BẬT (ENABLE)</b> rồi quay lại thử lại:
                  </span>
                  <a
                    href={consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 text-white font-bold text-xs shadow-xs transition-all shrink-0"
                  >
                    <span>Mở Google Cloud Console</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}
            </div>
          );
        })()}
        {selectedMember && profileErrors[selectedMember.id] && (
          <div
            role="alert"
            className="mb-4 flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="text-sm">
              <p className="font-bold">Chưa tải được hồ sơ của {selectedMember.name}</p>
              <p className="mt-1 text-xs font-mono break-all text-amber-900">{profileErrors[selectedMember.id]}</p>
              <p className="mt-1 text-xs">
                {/file not found|404|không tìm thấy tệp/i.test(profileErrors[selectedMember.id])
                  ? 'Tệp hồ sơ trên Google Drive đã bị xóa hoặc không còn tồn tại. Bạn có thể khởi tạo lại tệp hồ sơ mới hoặc xóa thành viên này khỏi gia đình.'
                  : 'Để tránh ghi đè nhầm bằng hồ sơ rỗng, thao tác số hóa và AI đang bị khóa.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {/file not found|404|không tìm thấy tệp/i.test(profileErrors[selectedMember.id]) && workspace?.rootFolderId !== 'local_offline_workspace' && (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleRecreateMemberProfile(selectedMember.id)}
                  className="rounded-xl bg-emerald-700 px-3 py-2 text-xs font-bold text-white shadow hover:bg-emerald-800 disabled:opacity-50"
                >
                  Khởi tạo lại hồ sơ trên Drive
                </button>
              )}
              <button
                type="button"
                disabled={isLoading || !workspace}
                onClick={() => workspace && void reloadProfiles(workspace)}
                className="shrink-0 rounded-xl bg-amber-700 px-3 py-2 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-50"
              >
                Tải lại hồ sơ
              </button>
            </div>
          </div>
        )}
        {localImportAvailable && workspace?.rootFolderId !== 'local_offline_workspace' && (
          <section className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950">
            <div className="flex items-start gap-3">
              <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-sky-700" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-extrabold">Có dữ liệu ngoại tuyến trên thiết bị</h3>
                <p className="mt-1 text-xs leading-relaxed text-sky-900">
                  Dữ liệu chỉ được sao chép lên kho Drive khi bạn xác nhận. Bản cục bộ sẽ được giữ nguyên.
                </p>
                <button
                  type="button"
                  disabled={isImportingLocalData || isUploading || isLoading}
                  onClick={() => void importGuestLocalDataToDrive()}
                  className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl bg-sky-700 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-sky-800 disabled:opacity-50"
                >
                  {isImportingLocalData
                    ? <LoaderCircle className="h-4 w-4 animate-spin" />
                    : <Cloud className="h-4 w-4" />}
                  {isImportingLocalData ? 'Đang sao chép...' : 'Sao chép dữ liệu lên Drive'}
                </button>
              </div>
            </div>
          </section>
        )}
        {/* Setup Screen if no workspace is opened */}
        {!workspace ? (
          <div className="max-w-xl mx-auto my-6 bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-sm">
            <div className="text-center mb-6">
              <AppLogo size="xl" className="justify-center mb-4" />
              <h2 className="text-2xl font-black tracking-tight text-slate-900">
                Sức Khỏe Gia Đình
              </h2>
              <p className="mt-1.5 text-xs sm:text-sm text-slate-600 max-w-md mx-auto">
                Lưu trữ hồ sơ y tế gia đình an toàn trên Google Drive của bạn.
              </p>
            </div>
            {needsDriveAuthorization ? (
              <div className="space-y-4">
                {userEmail ? (
                  <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-950 text-xs flex items-start gap-2.5">
                    <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-amber-900">
                        Cần cấp quyền Google Drive
                      </p>
                      <p className="text-[11px] text-amber-800 mt-0.5">
                        Tài khoản <span className="font-semibold">{userEmail}</span> chưa cấp quyền Drive để đồng bộ.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-950 text-xs space-y-1">
                    <div className="flex items-center gap-2 font-bold text-emerald-900">
                      <ShieldCheck className="w-4 h-4 text-emerald-600" />
                      <span>Riêng tư trên Google Drive cá nhân</span>
                    </div>
                    <p className="text-[11px]">
                      Dữ liệu lưu trực tiếp trên Google Drive của bạn, không qua máy chủ trung gian.
                    </p>
                  </div>
                )}
                
                <button
                  type="button"
                  onClick={onConnectDrive}
                  className="w-full flex items-center justify-center gap-2.5 py-3.5 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-sm shadow-md shadow-emerald-600/20 transition-all"
                >
                  <LogIn className="w-4 h-4" />
                  <span>{userEmail ? 'Cấp lại quyền Drive' : 'Đăng nhập Google & Cấp quyền Drive'}</span>
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-950 text-xs flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-emerald-900">
                      Admin: <span className="font-semibold text-emerald-700">{userEmail}</span>
                    </p>
                    <p className="text-[11px] text-emerald-800 mt-0.5">
                      Tạo thư mục gia đình mới hoặc mở thư mục Drive đã được chia sẻ.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleCreateWorkspace()}
                  className="w-full flex items-center justify-center gap-2.5 py-3.5 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-sm shadow-md shadow-emerald-600/20 transition-all disabled:opacity-50"
                >
                  {isLoading ? (
                    <LoaderCircle className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  <span>Khởi tạo Thư mục “Suc khoe gia dinh” mới</span>
                </button>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" />
                  <span className="uppercase font-semibold tracking-wider">HOẶC MỞ THƯ MỤC CÓ SẴN</span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (rootIdInput.trim()) void openWorkspace(rootIdInput);
                  }}
                  className="space-y-3"
                >
                  <div>
                    <label
                      htmlFor="folder-id-input"
                      className="block text-xs font-bold text-slate-700 uppercase tracking-wide mb-1"
                    >
                      Mã Thư mục Drive đã được chia sẻ
                    </label>
                    <input
                      id="folder-id-input"
                      type="text"
                      value={rootIdInput}
                      onChange={(e) => setRootIdInput(e.target.value)}
                      placeholder="Dán mã ID thư mục Google Drive..."
                      required
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 text-sm font-mono text-slate-900"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading || !rootIdInput.trim()}
                    className="w-full py-2.5 rounded-xl border border-slate-300 hover:bg-slate-50 active:scale-[0.98] text-slate-800 text-sm font-bold transition-all disabled:opacity-50"
                  >
                    {isLoading ? 'Đang kết nối...' : 'Mở thư mục'}
                  </button>
                </form>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* VIEW 1: TỔNG QUAN (OVERVIEW) */}
            {activeTab === 'overview' && (
              <div className={`space-y-6 ${tabSlideClass}`}>
                {/* Empty Local Data Guidance Card */}
                {totalTimelineEvents === 0 && (
                  <div className="bg-white border border-slate-200/90 rounded-3xl p-4 sm:p-5 shadow-xs text-center animate-in fade-in zoom-in-95 duration-200">
                    <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-2.5 border border-emerald-100 shadow-xs">
                      <FolderHeart className="w-5 h-5" />
                    </div>
                    <h3 className="text-base font-black text-slate-900 tracking-tight">Chưa có dữ liệu y tế</h3>
                    {/* Compact 3-Step Chips */}
                    <div className="grid grid-cols-3 gap-2 my-3 text-left">
                      <button
                        type="button"
                        onClick={() => setActiveTab('family')}
                        className="p-2.5 rounded-2xl bg-slate-50 border border-slate-100 hover:border-emerald-300 hover:bg-emerald-50/50 transition-all text-left group"
                      >
                        <span className="w-5 h-5 rounded-lg bg-emerald-600 text-white font-extrabold text-[10px] flex items-center justify-center mb-1">1</span>
                        <h4 className="font-bold text-[11px] text-slate-900 group-hover:text-emerald-700 leading-tight">1. Tạo hồ sơ</h4>
                        <p className="text-[10px] text-slate-500 mt-0.5 truncate">Thành viên</p>
                      </button>
                      <button
                        type="button"
                        onClick={handleFileUploadTrigger}
                        className="p-2.5 rounded-2xl bg-slate-50 border border-slate-100 hover:border-emerald-300 hover:bg-emerald-50/50 transition-all text-left group"
                      >
                        <span className="w-5 h-5 rounded-lg bg-emerald-600 text-white font-extrabold text-[10px] flex items-center justify-center mb-1">2</span>
                        <h4 className="font-bold text-[11px] text-slate-900 group-hover:text-emerald-700 leading-tight">2. Tải tài liệu</h4>
                        <p className="text-[10px] text-slate-500 mt-0.5 truncate">Tải ảnh/PDF</p>
                      </button>
                      <div className="p-2.5 rounded-2xl bg-slate-50 border border-slate-100 text-left">
                        <span className="w-5 h-5 rounded-lg bg-emerald-600 text-white font-extrabold text-[10px] flex items-center justify-center mb-1">3</span>
                        <h4 className="font-bold text-[11px] text-slate-900 leading-tight">3. Phân tích</h4>
                        <p className="text-[10px] text-slate-500 mt-0.5 truncate">AI Y khoa</p>
                      </div>
                    </div>
                    {/* Action Bar */}
                    <div className="flex justify-center">
                      {!userEmail ? (
                        <button
                          type="button"
                          onClick={() => {
                            setErrorMessage('');
                            onConnectDrive();
                          }}
                          className="w-full sm:w-auto min-w-[220px] py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-xs transition-all"
                        >
                          <ShieldCheck className="w-4 h-4 text-white" />
                          <span>{driveActionLabel}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isSyncing}
                          onClick={() => {
                            if (needsDriveAuthorization) {
                              onConnectDrive();
                            } else if (hasRemoteWorkspace) {
                              void handleManualSync();
                            } else {
                              void handleCreateWorkspace();
                            }
                          }}
                          className="w-full sm:w-auto min-w-[220px] py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-xs"
                        >
                          <Cloud className="w-4 h-4 text-white" />
                          <span>{isSyncing ? 'Đang đồng bộ...' : driveActionLabel}</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {/* Upcoming Follow-ups Alert Strip */}
                {upcomingFollowUps.length > 0 && (
                  <div className="rounded-2xl border border-amber-200/90 bg-amber-50/80 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 text-amber-900 font-extrabold text-sm">
                        <Calendar className="w-4 h-4 text-amber-600" />
                        <span>Lịch tái khám & Nhắc nhở sắp tới</span>
                      </div>
                      <span className="text-[11px] font-bold text-amber-700">
                        {upcomingFollowUps.length} nhắc hẹn
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {upcomingFollowUps.slice(0, 2).map((item, idx) => (
                        <div
                          key={idx}
                          className="bg-white p-3 rounded-xl border border-amber-200/60 shadow-xs flex items-center justify-between gap-3 text-xs"
                        >
                          <div>
                            <span className="font-bold text-slate-900">{item.member.name}: </span>
                            <span className="text-slate-700">{item.event.title}</span>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {item.event.facility && `${item.event.facility} · `}
                              Hẹn ngày: {formatDateVN(item.followUpDate)}
                            </div>
                          </div>
                          <span
                            className={`px-2 py-1 rounded-lg font-bold text-[10px] shrink-0 ${
                              item.daysRemaining < 0
                                ? 'bg-rose-100 text-rose-800'
                                : item.daysRemaining <= 3
                                ? 'bg-amber-100 text-amber-900 animate-pulse'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {item.daysRemaining < 0
                              ? `Quá hạn ${Math.abs(item.daysRemaining)} ngày`
                              : item.daysRemaining === 0
                              ? 'Hôm nay!'
                              : `Còn ${item.daysRemaining} ngày`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedProfile && (
                  <div className="space-y-5">
                    <AiDeepAnalysisCard
                      analysis={selectedProfile.aiDeepAnalysis}
                      aiAnalysis={selectedProfile.aiAnalysis}
                      medicalHistory={selectedProfile.medicalHistory}
                      narrativeSummary={selectedProfile.summary.narrative}
                      isAnalyzing={isSummarizing}
                      onRetry={() => void handleAiSummary('gemini-4-hydrogen')}
                      onRefine={() => void handleRefineAndOrganize()}
                      isRefining={isRefining}
                      error={analysisError}
                    />
                    {metricOptions.length > 0 && (() => {
                      const metricInfo = getHealthMetricInfo(selectedMetric);
                      return (
                        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 sm:p-5 shadow-xs space-y-4">
                          <div className="flex flex-col gap-3">
                            <div className="min-w-0">
                              <h4 className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
                                <Activity className="h-4 w-4 text-teal-600 shrink-0" />
                                <span>Diễn biến chỉ số sức khỏe</span>
                              </h4>
                              <p className="mt-0.5 text-xs text-slate-500">
                                Xu hướng qua các lần khám đã ghi nhận
                              </p>
                            </div>
                            <div className="flex w-full items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                              {metricOptions.map(({ key, label }) => (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() => setSelectedMetric(key)}
                                  className={`shrink-0 rounded-xl px-3 py-1.5 text-xs font-bold whitespace-nowrap transition-all ${
                                    selectedMetric === key
                                      ? 'bg-slate-900 text-white shadow-xs'
                                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                  }`}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                          {/* Metric Explanation & Normal Range Banner (2-line layout) */}
                          <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3 shadow-xs space-y-1 text-xs">
                            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                              <span className="font-extrabold text-emerald-950 text-sm shrink-0">
                                {metricInfo.name}
                              </span>
                              {metricInfo.normalRangeText && !metricInfo.normalRangeText.includes('Tham khảo') ? (
                                <span className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[10px] font-bold text-emerald-800 shadow-2xs border border-emerald-200 shrink-0">
                                  🛡️ {metricInfo.normalRangeText}
                                </span>
                              ) : null}
                            </div>
                            <p className="text-emerald-900/90 leading-relaxed font-medium">
                              {metricInfo.description}
                            </p>
                          </div>
                          <Suspense fallback={<div className="h-56 animate-pulse rounded-xl bg-slate-50" />}>
                            <HealthMetricsChart
                              data={chartData}
                              metricName={getHealthMetricDisplayName(selectedMetric)}
                              minNormal={metricInfo.minNormal}
                              maxNormal={metricInfo.maxNormal}
                            />
                          </Suspense>
                        </div>
                      );
                    })()}
                  </div>
                )}
                {/* Compact Family Members List */}
                <div>
                  <div className="flex items-center justify-between mb-2.5">
                    <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
                      <Users className="w-4 h-4 text-emerald-600" />
                      <span>Hồ sơ thành viên</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => setActiveTab('family')}
                      className="text-xs font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
                    >
                      <span>Quản lý</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {!members.length ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-center">
                      <p className="text-xs text-slate-500">Chưa có hồ sơ thành viên nào</p>
                      <button
                        type="button"
                        onClick={() => setActiveTab('family')}
                        className="mt-2 text-xs font-bold text-emerald-600 hover:text-emerald-700"
                      >
                        + Thêm thành viên ngay
                      </button>
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {members.map((m) => {
                        const prof = profiles[m.id];
                        const eventCount = prof?.timeline?.length || 0;
                        const isChosen = m.id === selectedMember?.id;
                        const memberRole = getWorkspaceMemberRole(m, workspace?.family.adminEmail);
                        return (
                          <div
                            key={m.id}
                            onClick={() => {
                              setSelectedMemberId(m.id);
                              setActiveTab('timeline');
                            }}
                            className={`group cursor-pointer rounded-2xl p-3 border transition-all text-left bg-white flex items-center justify-between gap-3 ${
                              isChosen
                                ? 'border-emerald-500 ring-2 ring-emerald-500/20 shadow-xs'
                                : 'border-slate-200/80 hover:border-emerald-300'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xs shrink-0">
                                {m.name.charAt(0)}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <h4 className="font-bold text-slate-900 text-xs truncate">
                                    {m.name}
                                  </h4>
                                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold shrink-0 ${
                                    memberRole === 'Admin'
                                      ? 'bg-emerald-100 text-emerald-700'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}>
                                    {memberRole}
                                  </span>
                                </div>
                                <p className="text-[10px] text-slate-500 truncate">
                                  {eventCount} sự kiện y tế
                                </p>
                              </div>
                            </div>
                            <span className="w-7 h-7 rounded-xl bg-slate-50 group-hover:bg-emerald-50 group-hover:text-emerald-700 text-slate-400 flex items-center justify-center shrink-0 transition-colors">
                              <ArrowRight className="w-3.5 h-3.5" />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* VIEW 2: HỒ SƠ Y TẾ (TIMELINE & VITALS) */}
            {activeTab === 'timeline' && (
              <div className={`space-y-6 ${tabSlideClass}`}>
                {/* Active Member Bar & Action CTAs */}
                {selectedProfile && selectedProfile.timeline.length > 0 && (
                  <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-black text-lg shrink-0">
                        {selectedMember?.name.charAt(0) || 'U'}
                      </div>
                      <div className="min-w-0">
                        <h3 className="font-extrabold text-slate-900 text-sm truncate">
                          {selectedMember?.name}
                        </h3>
                        {selectedMember && (
                          <p className="text-[11px] text-slate-500 truncate">
                            {[
                              selectedMember.gender === 'male' ? 'Nam' : selectedMember.gender === 'female' ? 'Nữ' : selectedMember.gender === 'other' ? 'Khác' : '',
                              selectedMember.birthDate ? `Sinh ${formatDateVN(selectedMember.birthDate)}` : '',
                            ].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleFileUploadTrigger}
                        disabled={(!driveAuthorized && !canUseLocalWorkspace) || isUploading}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition-all disabled:opacity-50 shadow-xs active:scale-[0.98]"
                      >
                        <FileUp className="w-4 h-4" />
                        <span>Tải tài liệu</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRawFilesModal(true)}
                        disabled={!driveAuthorized && !canUseLocalWorkspace}
                        className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl border border-teal-200 bg-teal-50/80 hover:bg-teal-100 text-teal-900 font-bold text-xs transition-all disabled:opacity-50 shrink-0"
                        title="Quản lý tài liệu gốc và trạng thái số hóa"
                      >
                        <FileStack className="w-4 h-4 text-teal-600" />
                        <span>Tài liệu gốc</span>
                      </button>
                    </div>
                  </div>
                )}
                {/* Timeline Filter Tabs */}
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                  <button
                    type="button"
                    onClick={() => setTimelineFilter('all')}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                      timelineFilter === 'all'
                        ? 'bg-slate-900 text-white shadow-xs'
                        : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    Tất cả ({selectedProfile?.timeline.length || 0})
                  </button>
                  {EVENT_TYPE_OPTIONS.map((opt) => {
                    const count =
                      selectedProfile?.timeline.filter((e) => e.type === opt.value).length || 0;
                    if (count === 0 && timelineFilter !== opt.value) return null;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setTimelineFilter(opt.value)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                          timelineFilter === opt.value
                            ? 'bg-slate-900 text-white shadow-xs'
                            : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label} ({count})
                      </button>
                    );
                  })}
                </div>
                {/* Health Events List */}
                <div className="space-y-4">
                  {filteredTimeline.length === 0 ? (
                    <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center">
                      <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3 border border-emerald-100 shadow-2xs">
                        <FolderHeart className="w-7 h-7" />
                      </div>
                      <h4 className="font-extrabold text-slate-800 text-base">
                        Chưa có sự kiện y tế
                      </h4>
                      <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                        Tải ảnh hoặc PDF sổ khám, đơn thuốc, xét nghiệm để số hóa.
                      </p>
                    </div>
                  ) : (
                    filteredTimeline.map((event) => {
                      const opt =
                        EVENT_TYPE_OPTIONS.find((t) => t.value === event.type) ||
                        EVENT_TYPE_OPTIONS[EVENT_TYPE_OPTIONS.length - 1];
                      const IconComp = opt.icon;
                      return (
                        <div
                          key={event.id}
                          className="bg-white border border-slate-200/80 rounded-2xl p-4 sm:p-5 shadow-xs hover:border-emerald-300 transition-all space-y-3"
                        >
                          {/* Event Header Top Bar */}
                          <div className="flex flex-wrap items-center justify-between gap-2.5 w-full border-b border-slate-100 pb-2.5">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 shadow-2xs border border-emerald-100/60">
                                <IconComp className="w-4 h-4" />
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 min-w-0">
                                <span className="font-bold text-emerald-800">{opt.label}</span>
                                {event.customCategory && (
                                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium text-[11px] border border-slate-200">
                                    {event.customCategory}
                                  </span>
                                )}
                                <span aria-hidden="true" className="text-slate-300">·</span>
                                <span className="font-mono tabular-nums text-slate-500">{formatDateVN(event.date) || 'Chưa rõ ngày'}</span>
                              </div>
                            </div>
                            {/* View original file(s) on Drive */}
                            {event.additionalSources && event.additionalSources.length > 1 ? (
                              <div className="flex flex-wrap items-center gap-1.5 min-w-0 max-w-full">
                                {event.additionalSources.map((src, idx) => (
                                  <a
                                    key={src.driveFileId || idx}
                                    href={`https://drive.google.com/file/d/${encodeURIComponent(
                                      src.driveFileId
                                    )}/view`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 px-2 py-1 rounded-lg border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-[11px] font-medium text-emerald-800 max-w-[160px] sm:max-w-[240px] truncate"
                                    title={`Xem tệp gốc: ${src.fileName}`}
                                  >
                                    <ExternalLink className="w-3 h-3 text-emerald-600 shrink-0" />
                                    <span className="truncate">{src.fileName || `Tệp ${idx + 1}`}</span>
                                  </a>
                                ))}
                              </div>
                            ) : event.sourceFileId && (
                              <a
                                href={`https://drive.google.com/file/d/${encodeURIComponent(
                                  event.sourceFileId
                                )}/view`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-xs font-bold text-blue-800 shrink-0"
                                title="Xem tệp gốc trên Google Drive"
                              >
                                <FileText className="w-4 h-4" strokeWidth={2.5} />
                                <span className="hidden sm:inline">Tài liệu gốc</span>
                              </a>
                            )}
                          </div>
                          {/* Event Title & Metadata Block (Full Width Edge-to-Edge) */}
                          <div className="w-full space-y-2">
                            <h4 className="text-base font-extrabold text-slate-900 leading-snug break-words w-full">
                              {event.title}
                            </h4>
                            {(event.facility || event.doctorName) && (
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-x-4 gap-y-1.5 pt-1 text-xs text-slate-600 w-full">
                                {event.facility && (
                                  <p className="flex items-start gap-1.5 font-medium text-slate-700 min-w-0">
                                    <Stethoscope className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                                    <span className="break-words">{event.facility}</span>
                                  </p>
                                )}
                                {event.doctorName && (
                                  <p className="flex items-start gap-1.5 font-medium text-slate-700 min-w-0 sm:text-right shrink-0">
                                    <User className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                                    <span className="break-words">
                                      {event.doctorName.toLowerCase().startsWith('bs') || event.doctorName.toLowerCase().startsWith('bác sĩ')
                                        ? event.doctorName
                                        : `BS. ${event.doctorName}`}
                                    </span>
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                          {/* Diagnoses List */}
                          {event.diagnoses.length > 0 && (
                            <div className="text-xs bg-slate-50 rounded-xl p-2.5 border border-slate-100">
                              <span className="font-bold text-slate-700">Chẩn đoán: </span>
                              <span className="text-slate-800">{event.diagnoses.join('; ')}</span>
                            </div>
                          )}
                          {/* Medications table/list */}
                          {event.medications.length > 0 && (
                            <div className="space-y-1.5">
                              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                                Đơn thuốc điều trị:
                              </span>
                              <div className="grid gap-1.5 sm:grid-cols-2">
                                {event.medications.map((med, idx) => (
                                  <div
                                    key={idx}
                                    className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs space-y-1"
                                  >
                                    <div className="flex items-center justify-between font-bold text-slate-900">
                                      <span>💊 {med.name}</span>
                                      {med.quantity && (
                                        <span className="text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md">
                                          SL: {med.quantity}
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-slate-600 text-[11px] flex flex-wrap gap-x-2 gap-y-0.5">
                                      {[med.dosage, med.frequency, med.duration]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </div>
                                    {med.timing && (
                                      <div className="text-[11px] text-slate-500">
                                        ⏰ {med.timing}
                                      </div>
                                    )}
                                    {med.instructions && (
                                      <div className="text-[11px] text-amber-900/90 bg-amber-50/70 p-1 rounded-md border border-amber-100/80">
                                        👉 {med.instructions}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Vaccination Records */}
                          {event.vaccinations && event.vaccinations.length > 0 && (
                            <div className="space-y-1.5 pt-1">
                              <span className="text-[11px] font-bold text-teal-700 uppercase tracking-wide flex items-center gap-1">
                                <HeartPulse className="w-3.5 h-3.5" />
                                Thông tin tiêm chủng vắc xin:
                              </span>
                              <div className="grid gap-1.5 sm:grid-cols-2">
                                {event.vaccinations.map((vac, idx) => (
                                  <div
                                    key={idx}
                                    className="p-2.5 rounded-xl bg-teal-50/80 border border-teal-200 text-xs space-y-1"
                                  >
                                    <div className="flex items-center justify-between">
                                      <span className="font-bold text-teal-950">💉 {vac.vaccineName}</span>
                                      {vac.doseNumber && (
                                        <span className="px-2 py-0.5 rounded-md bg-teal-600 text-white font-bold text-[10px]">
                                          Mũi {vac.doseNumber}
                                        </span>
                                      )}
                                    </div>
                                    {vac.targetDisease && (
                                      <p className="text-[11px] text-teal-800">
                                        <strong>Phòng bệnh:</strong> {vac.targetDisease}
                                      </p>
                                    )}
                                    <div className="text-[11px] text-slate-600 flex flex-wrap gap-x-2">
                                      {vac.lotNumber && <span>Lô: {vac.lotNumber}</span>}
                                      {vac.manufacturer && <span>SX: {vac.manufacturer}</span>}
                                    </div>
                                    {vac.nextDoseDate && (
                                      <div className="mt-1 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 font-semibold text-[11px] flex items-center gap-1">
                                        <Calendar className="w-3 h-3 text-amber-600" />
                                        <span>Hẹn tiêm tiếp: {formatDateVN(vac.nextDoseDate)}</span>
                                      </div>
                                    )}
                                    {vac.reactionNotes && (
                                      <p className="text-[11px] text-slate-500 italic">
                                        Phản ứng: {vac.reactionNotes}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Hospitalization Record */}
                          {hasMeaningfulHospitalization(event.hospitalization) && event.hospitalization && (
                            <div className="p-3 rounded-2xl bg-indigo-50/70 border border-indigo-200 text-xs space-y-1.5">
                              <span className="text-[11px] font-bold text-indigo-900 uppercase tracking-wide flex items-center gap-1">
                                <FileHeart className="w-3.5 h-3.5" />
                                Thông tin nằm viện & ra viện:
                              </span>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-700">
                                {event.hospitalization.department && (
                                  <span><strong>Khoa:</strong> {event.hospitalization.department}</span>
                                )}
                                {event.hospitalization.admissionDate && (
                                  <span><strong>Nhập viện:</strong> {formatDateVN(event.hospitalization.admissionDate)}</span>
                                )}
                                {event.hospitalization.dischargeDate && (
                                  <span><strong>Ra viện:</strong> {formatDateVN(event.hospitalization.dischargeDate)}</span>
                                )}
                              </div>
                              {event.hospitalization.treatmentSummary && (
                                <p className="text-slate-700">
                                  <strong>Tóm tắt điều trị:</strong> {event.hospitalization.treatmentSummary}
                                </p>
                              )}
                              {event.hospitalization.surgicalNotes && (
                                <p className="text-indigo-900 font-medium">
                                  <strong>Phẫu thuật / Thủ thuật:</strong> {event.hospitalization.surgicalNotes}
                                </p>
                              )}
                            </div>
                          )}
                          {/* Metrics chips: abnormal always visible, normal collapsed by default */}
                          {event.metrics.length > 0 && (() => {
                            const { abnormal, normal } = partitionHealthMetricsForDisplay(
                              event.metrics,
                              selectedMember?.gender,
                            );
                            const isNormalExpanded = Boolean(expandedMetricEventIds[event.id]);
                            const renderMetricChip = (
                              met: typeof event.metrics[number],
                              rangeStatus: ReturnType<typeof getHealthMetricRangeStatus>,
                              isAbnormalChip: boolean,
                              keyIndex: number,
                            ) => {
                              const isCritical = rangeStatus === 'critical_high' || rangeStatus === 'critical_low';
                              const isWarning =
                                isAbnormalChip ||
                                rangeStatus === 'warning_high' ||
                                rangeStatus === 'warning_low';
                              return (
                                <span
                                  key={keyIndex}
                                  aria-label={`${met.name}: ${met.value} ${met.unit}${isCritical ? ', cảnh báo nghiêm trọng' : isWarning ? ', vượt khoảng tham chiếu' : ''}`}
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs tabular-nums ${
                                    isCritical
                                      ? 'bg-rose-100 border-rose-300 text-rose-950 font-bold'
                                      : isWarning
                                        ? 'bg-amber-100 border-amber-300 text-amber-950 font-bold'
                                        : 'bg-teal-50 border-teal-200 text-teal-900 font-semibold'
                                  }`}
                                >
                                  {(isCritical || isWarning) && (
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                  )}
                                  <span>
                                    {met.name}: <strong>{met.value}</strong> {met.unit}
                                    {isWarning && met.refRange ? (
                                      <span className="ml-1 text-[11px] font-normal opacity-80">
                                        ({met.refRange})
                                      </span>
                                    ) : null}
                                  </span>
                                </span>
                              );
                            };

                            return (
                              <div className="space-y-2 pt-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mr-1">
                                    {abnormal.length > 0 ? 'Chỉ số cần chú ý:' : 'Chỉ số đo:'}
                                  </span>
                                  {abnormal.map((item) =>
                                    renderMetricChip(item.metric, item.rangeStatus, true, item.index),
                                  )}
                                  {abnormal.length === 0 && normal.length > 0 && !isNormalExpanded && (
                                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-200 bg-emerald-50/70 text-emerald-800 text-xs font-semibold">
                                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                      Trong ngưỡng bình thường ({normal.length})
                                    </span>
                                  )}
                                </div>

                                {normal.length > 0 && isNormalExpanded && (
                                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-teal-100 bg-teal-50/40 p-2.5">
                                    <span className="w-full text-[11px] font-semibold text-teal-800">
                                      Chỉ số trong ngưỡng bình thường ({normal.length}):
                                    </span>
                                    {normal.map((item) =>
                                      renderMetricChip(item.metric, item.rangeStatus, false, item.index),
                                    )}
                                  </div>
                                )}

                                {normal.length > 0 && (
                                  <button
                                    type="button"
                                    aria-expanded={isNormalExpanded}
                                    onClick={() =>
                                      setExpandedMetricEventIds((prev) => ({
                                        ...prev,
                                        [event.id]: !prev[event.id],
                                      }))
                                    }
                                    className="inline-flex min-h-[44px] w-full sm:w-auto items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 active:bg-slate-200"
                                  >
                                    {isNormalExpanded ? (
                                      <>
                                        <ChevronUp className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                                        Thu gọn {normal.length} chỉ số bình thường
                                      </>
                                    ) : (
                                      <>
                                        <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                                        {abnormal.length > 0
                                          ? `Xem thêm ${normal.length} chỉ số bình thường`
                                          : `Xem chi tiết ${normal.length} chỉ số bình thường`}
                                      </>
                                    )}
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                          {/* Imaging Results */}
                          {event.imagingResults && event.imagingResults.length > 0 && (
                            <div className="space-y-1.5 pt-1.5">
                              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                                Chẩn đoán hình ảnh (Siêu âm / X-quang):
                              </span>
                              <div className="grid gap-1.5 sm:grid-cols-2">
                                {event.imagingResults.map((img, idx) => (
                                  <div key={idx} className="p-2.5 rounded-xl bg-purple-50/80 border border-purple-200 text-xs">
                                    <div className="font-bold text-purple-950 flex items-center gap-1">
                                      <span>🖥️ {img.modality}</span>
                                    </div>
                                    {img.findings && (
                                      <p className="text-[11px] text-slate-600 mt-0.5">{img.findings}</p>
                                    )}
                                    {img.conclusion && (
                                      <p className="text-xs font-semibold text-purple-900 mt-1">
                                        👉 Kết luận: {img.conclusion}
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Dynamic Extracted Data for Other Documents */}
                          {event.extractedData && Object.keys(event.extractedData).length > 0 && (
                            <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
                              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                                Dữ liệu chi tiết trích xuất:
                              </span>
                              <div className="grid gap-1 sm:grid-cols-2">
                                {Object.entries(event.extractedData).map(([key, value], idx) => (
                                  <div key={idx} className="flex items-baseline gap-1 text-[11px]">
                                    <span className="font-semibold text-slate-600">{key}:</span>
                                    <span className="text-slate-800">
                                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Doctor's Advice & Next Follow-up */}
                          {(event.advice || event.nextFollowUp) && (
                            <div className="pt-2 border-t border-slate-100 text-xs space-y-1">
                              {event.advice && (
                                <p className="text-slate-700">
                                  <strong>Lời dặn:</strong> {event.advice}
                                </p>
                              )}
                              {event.nextFollowUp && (
                                <p className="font-semibold text-amber-800 flex items-center gap-1.5">
                                  <Calendar className="w-3.5 h-3.5 text-amber-600" />
                                  <span>Hẹn tái khám: {event.nextFollowUp}</span>
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
            {/* VIEW 3: TRỢ LÝ AI (HEALTH CHAT ASSISTANT) */}
            {activeTab === 'assistant' && (
              <div className={`mx-auto flex h-full min-h-0 w-full max-w-2xl md:max-w-3xl flex-col gap-2.5 ${tabSlideClass}`}>
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
                  <div
                    ref={chatScrollRef}
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                    aria-label="Lịch sử trò chuyện với trợ lý y tế"
                    tabIndex={0}
                    className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4 focus:outline-none"
                  >
                    {chatMessages.length === 0 ? (
                      <div className="flex min-h-full flex-col items-center justify-center px-2 py-5 text-center">
                        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                          <Sparkles className="h-6 w-6" />
                        </div>
                        <p className="text-sm font-bold text-slate-800">Bạn muốn hỏi gì?</p>
                        <p className="mt-1 max-w-xs text-xs text-slate-500">
                          Hỏi về hồ sơ sức khỏe hoặc kiến thức y tế tham khảo (không thay thế bác sĩ).
                        </p>
                        <div className="mt-4 flex max-w-lg flex-wrap justify-center gap-2">
                          {[
                            'Lần gần nhất khám ở đâu?',
                            'Các thuốc gần đây là gì?',
                            'Huyết áp thay đổi thế nào?',
                            'Sắp tới có lịch tái khám không?',
                            'Tăng huyết áp là gì?',
                          ].map((promptText) => (
                            <button
                              key={promptText}
                              type="button"
                              onClick={() => setChatInput(promptText)}
                              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-[11px] font-medium text-slate-600 transition-colors hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800"
                            >
                              {promptText}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      chatMessages.map((msg, index) => (
                        <div
                          key={index}
                          className={`flex max-w-[90%] flex-col sm:max-w-[82%] ${
                            msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                          }`}
                        >
                          <div
                            className={`break-words rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${
                              msg.role === 'user'
                                ? 'rounded-br-md bg-emerald-600 text-white'
                                : 'rounded-bl-md border border-slate-200/70 bg-slate-50 text-slate-800'
                            }`}
                          >
                            {msg.text}
                          </div>
                          {msg.role === 'assistant' && Boolean(msg.citations?.length) && (
                            <div className="mt-1.5 flex flex-wrap gap-1.5 px-1">
                              {msg.citations?.map((citation, citationIndex) => (
                                <a
                                  key={citation.url}
                                  href={citation.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-100 bg-white px-2 py-1 text-[10px] font-medium text-emerald-800 hover:bg-emerald-50"
                                  aria-label={`Nguồn tham khảo ${citationIndex + 1}: ${citation.title}`}
                                >
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{`[${citationIndex + 1}] ${citation.title}`}</span>
                                </a>
                              ))}
                            </div>
                          )}
                          {msg.timestamp && (
                            <span className="mt-1 px-1 text-[10px] text-slate-400">{msg.timestamp}</span>
                          )}
                        </div>
                      ))
                    )}
                    {isChatting && chatMessages[chatMessages.length - 1]?.role !== 'assistant' && (
                      <div role="status" className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        <LoaderCircle className="h-4 w-4 animate-spin text-emerald-600" />
                        <span>Trợ lý đang tổng hợp câu trả lời...</span>
                      </div>
                    )}
                  </div>

                  <form
                    onSubmit={(e) => void handleAskAssistant(e)}
                    className="flex shrink-0 items-end gap-2 border-t border-slate-100 bg-white p-2.5 sm:p-3"
                  >
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Nhập câu hỏi..."
                      aria-label={`Hỏi về hồ sơ sức khỏe của ${selectedMember?.name || 'thành viên'}`}
                      enterKeyHint="send"
                      disabled={isChatting}
                      className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-base sm:text-sm text-slate-900 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500/15 disabled:opacity-60"
                    />
                    <button
                      type="submit"
                      aria-label="Gửi câu hỏi"
                      disabled={isChatting || !chatInput.trim()}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </form>
                </section>
              </div>
            )}
            {/* VIEW 4: GIA ĐÌNH (FAMILY MEMBERS) */}
            {activeTab === 'family' && (
              <div className={`max-w-3xl mx-auto space-y-4 ${tabSlideClass}`}>
                <div className="rounded-3xl border border-slate-200/80 bg-white p-5 sm:p-6 shadow-xs">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                      <Users className="w-5 h-5 text-emerald-600" />
                      <span>Hồ sơ thành viên ({members.length})</span>
                    </h3>
                    {isWorkspaceAdmin && driveAuthorized && hasRemoteWorkspace && (
                      <button
                        type="button"
                        disabled={isLoading || isSyncing}
                        onClick={async () => {
                          const activeWorkspace = workspaceRef.current;
                          if (!activeWorkspace) return;
                          setIsLoading(true);
                          showToast('Đang kiểm tra và đồng bộ lại quyền truy cập Drive/Firestore cho tất cả thành viên...', 'info');
                          try {
                            await syncHealthWorkspaceMemberAssignments(activeWorkspace);
                            const assignments = await listHealthWorkspaceAssignments(activeWorkspace.rootFolderId);
                            const expectedEmails = new Set([
                              activeWorkspace.family.adminEmail.trim().toLowerCase(),
                              ...activeWorkspace.family.members
                                .map((member) => member.email.trim().toLowerCase())
                                .filter(Boolean),
                            ]);
                            const publishedEmails = new Set(
                              assignments.map((assignment) => assignment.memberEmail.trim().toLowerCase()),
                            );
                            const missingEmails = [...expectedEmails].filter((email) => !publishedEmails.has(email));
                            const adminRecord = assignments.find(
                              (assignment) =>
                                assignment.memberEmail.trim().toLowerCase() === activeWorkspace.family.adminEmail.trim().toLowerCase() &&
                                assignment.role === 'ADMIN' &&
                                assignment.migrationComplete,
                            );
                            if (!adminRecord || missingEmails.length > 0) {
                              throw new Error(
                                `Firestore chưa xác nhận đủ bản ghi quyền${missingEmails.length ? ` cho: ${missingEmails.join(', ')}` : ''}. Kiểm tra Rules đã deploy đúng database chưa.`,
                              );
                            }
                            setWorkspaceAssignments(assignments);
                            showToast('Đã đồng bộ quyền truy cập thành công!', 'success');
                          } catch (error) {
                            const msg = error instanceof Error ? error.message : 'Lỗi đồng bộ quyền.';
                            console.error('[Sync] Lỗi đồng bộ:', error);
                            showToast(msg, 'error');
                            setErrorMessage(msg);
                          } finally {
                            setIsLoading(false);
                          }
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold text-[11px] transition-all active:scale-95 disabled:opacity-50"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>Đồng bộ quyền truy cập</span>
                      </button>
                    )}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {members.map((m) => {
                      const prof = profiles[m.id];
                      const genderLabel = m.gender === 'male' ? 'Nam' : m.gender === 'female' ? 'Nữ' : m.gender === 'other' ? 'Khác' : '';
                      const birthDateStr = m.birthDate ? formatDateVN(m.birthDate) : '';
                      const age = m.birthDate ? Math.max(0, new Date().getFullYear() - new Date(m.birthDate).getFullYear()) : null;
                      const subInfo = [
                        genderLabel,
                        birthDateStr ? `Sinh ${birthDateStr}${age !== null ? ` (${age} tuổi)` : ''}` : '',
                        `${prof?.timeline?.length || 0} hồ sơ`,
                      ].filter(Boolean).join(' · ');
                      return (
                        <div
                          key={m.id}
                          className="py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center text-sm shrink-0">
                              {m.name.charAt(0)}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-bold text-slate-900 text-sm">{m.name}</p>
                                {getWorkspaceMemberRole(m, workspace?.family.adminEmail) === 'Admin' ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-black text-white bg-emerald-600 px-1.5 py-0.5 rounded shadow-sm uppercase tracking-tighter">
                                    <ShieldCheck className="w-2.5 h-2.5" />
                                    <span>Admin</span>
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
                                    Member
                                  </span>
                                )}
                                {m.email && (
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200/60">
                                    <Mail className="w-3 h-3 text-emerald-600 shrink-0" />
                                    <span>{m.email}</span>
                                  </span>
                                )}
                              </div>
                              <p className="text-slate-500 mt-0.5">
                                {subInfo}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-auto sm:ml-0">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedMemberId(m.id);
                                setActiveTab('timeline');
                              }}
                              className="px-3 py-1.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold text-xs"
                            >
                              Mở hồ sơ
                            </button>
                            {isWorkspaceAdmin && driveAuthorized && (
                              <button
                                type="button"
                                disabled={isLoading || isSavingMember}
                                onClick={() => setEditingMember(m)}
                                aria-label={`Chỉnh sửa thông tin của ${m.name}`}
                                title="Chỉnh sửa thông tin thành viên"
                                className="p-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}
                            {((isWorkspaceAdmin &&
                              m.email?.trim().toLowerCase() !== workspace?.family.adminEmail?.trim().toLowerCase()) ||
                              (!isWorkspaceAdmin &&
                               (userEmail || getSignedInGoogleEmail()) &&
                               m.email?.trim().toLowerCase() === (userEmail || getSignedInGoogleEmail())?.trim().toLowerCase())) && (
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => void handleDeleteFamilyMember(m)}
                                aria-label={`Xóa vĩnh viễn hồ sơ của ${m.name}`}
                                title={isWorkspaceAdmin ? "Xóa vĩnh viễn thành viên và dữ liệu Drive" : "Xóa hồ sơ bản thân khỏi gia đình"}
                                className="p-2 rounded-xl border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Add Member Form */}
                  <form
                    onSubmit={(e) => void handleAddMember(e)}
                    className="mt-6 pt-5 border-t border-slate-100 space-y-4"
                  >
                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wide flex items-center gap-1.5">
                      <UserPlus className="w-4 h-4 text-emerald-600" />
                      <span>Thêm thành viên mới</span>
                    </h4>
                    
                    <div className="grid gap-3 sm:grid-cols-2">
                      {/* 1. Họ và tên */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Họ và tên *
                        </label>
                        <input
                          type="text"
                          required
                          value={newMemberName}
                          onChange={(e) => setNewMemberName(e.target.value)}
                          placeholder="Họ và tên thành viên..."
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900 bg-white focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>
                      {/* 2. Ngày tháng năm sinh */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Ngày tháng năm sinh
                        </label>
                        <DatePickerVN
                          value={newMemberBirthDate}
                          onChange={(val) => setNewMemberBirthDate(val)}
                        />
                      </div>
                      {/* 3. Giới tính */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Giới tính
                        </label>
                        <select
                          value={newMemberGender}
                          onChange={(e) =>
                            setNewMemberGender(e.target.value as 'male' | 'female' | 'other')
                          }
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900 bg-white font-medium focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        >
                          <option value="male">Nam</option>
                          <option value="female">Nữ</option>
                          <option value="other">Khác</option>
                        </select>
                      </div>
                      {/* 4. Địa chỉ Gmail */}
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Địa chỉ Gmail
                        </label>
                        <input
                          type="email"
                          value={newMemberEmail}
                          onChange={(e) => setNewMemberEmail(e.target.value)}
                          placeholder="nguoithan@gmail.com"
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900 bg-white focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />
                      </div>
                    </div>
                    {/* Nút Tạo hồ sơ */}
                    <button
                      type="submit"
                      disabled={isAddingMember || !newMemberName.trim()}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs active:scale-[0.98] transition-all disabled:opacity-50"
                    >
                      {isAddingMember ? (
                        <LoaderCircle className="w-4 h-4 animate-spin" />
                      ) : (
                        <UserPlus className="w-4 h-4" />
                      )}
                      <span>Tạo hồ sơ</span>
                    </button>
                  </form>
                </div>
              </div>
            )}
          </>
        )}
        {/* Hidden File Input for Image/PDF Document Upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            if (files.length === 0) return;
            void stageFilesAndStart(files, pickedMemberIdForBatchRef.current);
            event.currentTarget.value = '';
          }}
        />
        {queueStatus && (
          <div className="fixed bottom-20 left-4 right-4 z-50 max-w-lg mx-auto bg-white/95 backdrop-blur-xl shadow-2xl rounded-3xl border border-emerald-100 overflow-hidden animate-in slide-in-from-bottom-4 transition-all">
            <div className="p-4 flex flex-col gap-3">
              {/* Header Row */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 border border-emerald-100">
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-extrabold text-sm sm:text-base text-slate-900 tracking-tight truncate">
                      Đang xử lý
                    </h3>
                    <p className="text-xs text-slate-600 font-medium truncate mt-0.5">
                      {trackerState.file?.name || 'Tệp tài liệu'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelBatchQueue}
                  className="px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-black text-xs transition-all shadow-sm active:scale-95 shrink-0 cursor-pointer"
                >
                  Dừng xử lý
                </button>
              </div>
              {/* Status Details Row */}
              <div className="grid grid-cols-2 gap-2 py-1.5 px-3 bg-slate-50 rounded-2xl border border-slate-200 text-[11px]">
                <div className="text-slate-600 font-medium truncate">
                  <span className="text-slate-500 font-normal">Trang xử lý: </span>
                  <span className="text-emerald-700 font-bold">
                    {trackerState.processedPages || 1}/{trackerState.totalPages || 1}
                  </span>
                </div>
                <div className="text-slate-600 font-medium truncate text-right">
                  <span className="text-slate-500 font-normal">Tiếp theo: </span>
                  <span className="text-slate-800 font-semibold truncate">
                    {uploadQueue.length > 0 ? uploadQueue[0].name : 'Hoàn tất...'}
                  </span>
                </div>
              </div>
              {/* Progress Bar Section */}
              <div className="space-y-1.5 pt-0.5">
                <div className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-slate-500 px-0.5">
                  <span>TIẾN ĐỘ TỔNG QUÁT</span>
                  <span className="flex items-center gap-2 shrink-0 normal-case tracking-normal">
                    <span
                      className="inline-flex items-center gap-1 text-slate-600 font-semibold"
                      aria-label={`Thời gian xử lý: ${queueElapsedSeconds} giây`}
                    >
                      <Clock className="w-3 h-3" />
                      {queueElapsedSeconds} giây
                    </span>
                    <span className="text-emerald-700 font-extrabold text-xs">
                      {Math.min(99, Math.round(((queueStatus.current - 1 + (trackerState.progressPercent || 0) / 100) / queueStatus.total) * 100))}%
                    </span>
                  </span>
                </div>
                <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden flex gap-1 p-0.5 border border-slate-200">
                  {Array.from({ length: queueStatus.total }).map((_, i) => {
                    const isDone = i < queueStatus.current - 1;
                    const isCurrent = i === queueStatus.current - 1;
                    const currentProgress = trackerState.progressPercent || 20;
                    return (
                      <div key={i} className="h-full flex-1 bg-slate-200 rounded-full overflow-hidden relative">
                        {isDone && <div className="h-full w-full bg-emerald-500 rounded-full" />}
                        {isCurrent && (
                          <div
                            className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-300 animate-pulse"
                            style={{ width: `${Math.min(100, Math.max(10, currentProgress))}%` }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="bg-slate-50 px-4 py-1.5 border-t border-slate-100">
              <p className="text-[10px] text-slate-500 text-center font-medium">
                Tự động lưu vào Dòng thời gian sau khi xong.
              </p>
            </div>
          </div>
        )}
        {!trackerState.isOpen && ocrRecoveryJobs.some((job) => job.status !== 'processing') && (
          <div
            className={`fixed ${queueStatus ? 'bottom-56' : 'bottom-20'} left-4 right-4 z-40 max-w-md mx-auto rounded-2xl border border-amber-200 bg-amber-50/95 p-3 shadow-xl`}
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-bold text-amber-900">
              <AlertCircle className="h-4 w-4" />
              Cần xử lý lại ({ocrRecoveryJobs.filter((job) => job.status !== 'processing').length})
            </div>
            <div className="max-h-36 space-y-2 overflow-y-auto">
              {ocrRecoveryJobs.filter((job) => job.status !== 'processing').map((job) => {
                const member = members.find((candidate) =>
                  profiles[candidate.id]?.sources.some((source) => source.driveFileId === job.driveFileId),
                );
                const source = member
                  ? profiles[member.id]?.sources.find((item) => item.driveFileId === job.driveFileId)
                  : undefined;
                const displayName = job.fileName || source?.fileName || 'Tài liệu y tế';
                return (
                  <div key={job.driveFileId} className="flex items-center justify-between gap-2 rounded-xl bg-white/80 p-2">
                    <div className="min-w-0">
                      <span className="block truncate text-[11px] font-semibold text-slate-800">
                        {displayName}
                      </span>
                      <span className="block text-[10px] text-slate-500 truncate">
                        {job.status === 'needs_review'
                          ? 'Chưa rõ chủ thể — cần chọn thành viên'
                          : `${member ? `${member.name} · ` : ''}Dừng ở ${job.progressPercent}%`}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={!member || isUploading || Boolean(queueStatus)}
                        onClick={() => void resumeInterruptedOcr(job)}
                        className="rounded-lg bg-emerald-700 px-2.5 py-1.5 text-[10px] font-bold text-white disabled:opacity-50"
                      >
                        OCR lại
                      </button>
                      <button
                        type="button"
                        onClick={() => forgetOcrRecoveryJob(job.driveFileId)}
                        className="text-[10px] font-semibold text-slate-500 hover:text-rose-600"
                      >
                        Ẩn
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
      {/* 2. FIXED BOTTOM TAB BAR (Thumb navigation, Mobile Pattern 1) */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200/90 safe-area-bottom shadow-lg">
        <div className="max-w-md md:max-w-xl mx-auto grid grid-cols-5 items-center h-16 px-2">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`min-h-[44px] flex flex-col items-center justify-center transition-all ${
              activeTab === 'overview'
                ? 'text-emerald-700 font-bold scale-105'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <LayoutGrid className="w-5 h-5" />
            <span className="text-[10px] mt-1 tracking-tight">Tổng quan</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('timeline')}
            className={`min-h-[44px] flex flex-col items-center justify-center transition-all ${
              activeTab === 'timeline'
                ? 'text-emerald-700 font-bold scale-105'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <FolderHeart className="w-5 h-5" />
            <span className="text-[10px] mt-1 tracking-tight">Hồ sơ</span>
          </button>
          {/* Center Upload Button (+) */}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={handleQuickActionTrigger}
              className="w-12 h-12 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-lg shadow-emerald-600/30 active:scale-95 transition-transform"
              title="Thêm hồ sơ mới"
            >
              <Plus className="w-6 h-6 stroke-[2.5]" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('assistant')}
            className={`min-h-[44px] flex flex-col items-center justify-center transition-all ${
              activeTab === 'assistant'
                ? 'text-emerald-700 font-bold scale-105'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Sparkles className="w-5 h-5" />
            <span className="text-[10px] mt-1 tracking-tight">Trợ lý AI</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('family')}
            className={`min-h-[44px] flex flex-col items-center justify-center transition-all ${
              activeTab === 'family'
                ? 'text-emerald-700 font-bold scale-105'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Users className="w-5 h-5" />
            <span className="text-[10px] mt-1 tracking-tight">Gia đình</span>
          </button>
        </div>
      </nav>
      {/* Quick Action Sheet Modal */}
      {showQuickActionModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-3 animate-in fade-in duration-150"
          onClick={() => {
            setShowQuickActionModal(false);
            pickedMemberIdForBatchRef.current = undefined;
          }}
        >
          <div
            className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl space-y-4 animate-in slide-in-from-bottom duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-2" />
            <h3 className="text-base font-extrabold text-slate-900 text-center">
              Ghi nhận tài liệu sức khỏe
            </h3>
            <p className="text-xs text-slate-500 text-center">
              Đang thêm cho: <strong>{selectedMember?.name || 'Thành viên'}</strong>
            </p>
            <div className="grid gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowQuickActionModal(false);
                  void handleCameraCapture(true);
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-emerald-50 hover:bg-emerald-100 text-emerald-950 font-bold text-xs transition-all text-left"
              >
                <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-extrabold">Chụp ảnh tài liệu</div>
                  <div className="text-[11px] text-emerald-700 font-normal">
                    Sổ khám, đơn thuốc, xét nghiệm
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowQuickActionModal(false);
                  setIsFileTriggerActive(false);
                  setIsCameraTriggerActive(false);
                  fileInputRef.current?.click();
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-slate-50 hover:bg-slate-100 text-slate-900 font-bold text-xs transition-all text-left"
              >
                <div className="w-10 h-10 rounded-xl bg-slate-800 text-white flex items-center justify-center shrink-0">
                  <FileUp className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-extrabold">Tải ảnh hoặc tệp PDF</div>
                  <div className="text-[11px] text-slate-500 font-normal">
                    Chọn từ bộ nhớ thiết bị
                  </div>
                </div>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowQuickActionModal(false)}
              className="w-full py-2.5 text-center text-xs font-bold text-slate-400 hover:text-slate-600"
            >
              Hủy bỏ
            </button>
          </div>
        </div>
      )}
      {/* Digitization Progress Tracker Modal */}
      {trackerMember && (
        <DigitizationProgressTrackerModal
          isOpen={trackerState.isOpen}
          file={trackerState.file}
          member={trackerMember}
          step={trackerState.step}
          progressPercent={trackerState.progressPercent}
          progressMessage={trackerState.progressMessage}
          driveFile={trackerState.driveFile}
          modelUsed={trackerState.modelUsed}
          partialExtracted={trackerState.partialExtracted}
          error={trackerState.error}
          totalPages={trackerState.totalPages}
          processedPages={trackerState.processedPages}
          onReview={() => {
            if (trackerState.driveFile) {
              setDigitizationDraft({
                source: trackerState.driveFile,
                extracted: trackerState.partialExtracted,
                contentIndexPages: [],
                contentIndexComplete: false,
              });
            }
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
          }}
          onRetry={() => {
            void retryDigitization();
          }}
          onManualEntry={() => {
            if (trackerState.driveFile) {
              setDigitizationDraft({
                source: trackerState.driveFile,
                extracted: trackerState.partialExtracted,
                contentIndexPages: [],
                contentIndexComplete: false,
              });
            }
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
          }}
          onClose={() => {
            if (trackerState.step !== 'completed' && trackerState.step !== 'error') {
              showToast('Tài liệu vẫn đang được xử lý. Hãy đợi hoàn tất hoặc hủy các tệp còn trong hàng đợi.', 'info');
              return;
            }
            const isError = trackerState.step === 'error';
            const closedContext = trackerState.queueContext;
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
            if (isError && closedContext) {
              processNextInQueue(closedContext);
            }
          }}
        />
      )}
      {/* Digitization Review Modal */}
      {identityResolutionDraft && (
        <UnresolvedSubjectModal
          fileName={identityResolutionDraft.source.name}
          isSaving={isCreatingSubjectMember}
          error={digitizationError}
          members={members}
          adminEmail={workspace?.family.adminEmail}
          batchStatus={queueStatus}
          existingMemberName={pendingSubjectMember?.name}
          suggestedSubjectName={identityResolutionDraft.extracted.patientName}
          onDefer={deferUnresolvedSubject}
          onSelectExistingMember={(member) => void assignUnresolvedSubjectToMember(member)}
          onCreateMember={(name) => void createMemberForUnresolvedSubject(name)}
          onCancelQueue={handleCancelBatchQueue}
        />
      )}
      {digitizationDraft && (
        <DigitizationReviewModal
          draft={digitizationDraft}
          error={digitizationError}
          members={members}
          profiles={profiles}
          selectedMemberId={selectedMemberId}
          onClose={() => {
            const draftContext = digitizationDraft.queueContext;
            setDigitizationDraft(null);
            processNextInQueue(draftContext);
          }}
          onSave={(e, targetMemberId) =>
            void handleSaveDigitization(e, { targetMemberId })
          }
        />
      )}
      {/* App Update Modal */}
      <AppUpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={appVersion}
        updateInfo={updateInfo}
        onClose={() => setIsUpdateModalOpen(false)}
      />
      {/* Raw Files Manager Modal */}
      <RawFilesManagerModal
        isOpen={showRawFilesModal}
        workspace={workspace}
        members={members}
        profiles={profiles}
        selectedMemberId={selectedMember?.id}
        recoveryJobs={ocrRecoveryJobs}
        localOwnerKey={offlineOwnerKey || 'apk-local-device'}
        isBatchBusy={Boolean(queueStatus) || isUploading}
        onClose={() => setShowRawFilesModal(false)}
        onRefreshWorkspace={async () => {
          if (workspace) {
            await reloadProfiles(workspace);
          }
        }}
        onRunOcrForSource={async (member, source) => {
          if (queueStatusRef.current || activeQueueRunIdRef.current !== null || isUploadingRef.current) {
            throw new Error('Hãy đợi hàng đợi xử lý hiện tại hoàn tất rồi chạy lại OCR.');
          }
          const opToken = `raw_rerun_${source.driveFileId}_${Date.now()}`;
          beginUploadOp(opToken);
          try {
            let file: File;
            if (source.driveFileId.startsWith('local_file_')) {
              file = await fileFromLocalSource(
                source.driveFileId,
                offlineOwnerKey || 'apk-local-device',
              );
            } else {
              // Tải tệp từ Drive về làm File object để OCR lại
              const token = await getGoogleAccessToken();
              const response = await fetch(`https://www.googleapis.com/drive/v3/files/${source.driveFileId}?alt=media`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!response.ok) throw new Error('Không thể tải tệp từ Google Drive.');
              const blob = await response.blob();
              file = new File([blob], source.fileName, { type: source.mimeType });
            }
            setTrackerState({
              isOpen: true,
              file,
              memberId: member.id,
              step: 'reading_document',
              progressPercent: 20,
              progressMessage: `Đang chạy lại số hóa cho ${source.fileName}...`,
              driveFile: {
                id: source.driveFileId,
                name: source.fileName,
                mimeType: source.mimeType,
                createdTime: source.uploadedAt,
              },
              modelUsed: 'gemini-3.5-flash-lite',
              partialExtracted: {},
              error: null,
              queueContext: undefined,
            });
            await runDocumentExtraction(file, member, source.driveFileId);
          } finally {
            endUploadOp(opToken);
          }
        }}
        showToast={showToast}
      />
      <WorkspaceAuditModal
        isOpen={showWorkspaceAuditModal}
        workspace={workspace}
        profiles={profiles}
        userEmail={userEmail}
        onClose={() => setShowWorkspaceAuditModal(false)}
        onFactoryReset={handleFactoryReset}
        showToast={showToast}
      />
      <AiResourcesModal
        isOpen={showAiResourcesModal}
        folderId={workspace?.rootFolderId || 'local_offline_workspace'}
        isAdmin={isWorkspaceAdmin}
        onClose={() => setShowAiResourcesModal(false)}
      />
      <UploadMemberPickerModal
        isOpen={showUploadMemberPicker}
        members={members}
        adminEmail={workspace?.family.adminEmail}
        onClose={() => {
          setShowUploadMemberPicker(false);
          setPendingUploadFiles([]);
          setIsFileTriggerActive(false);
          setIsCameraTriggerActive(false);
          setIsQuickActionTriggerActive(false);
          pickedMemberIdForBatchRef.current = undefined;
        }}
        onSelect={(memberId) => {
          setShowUploadMemberPicker(false);
          pickedMemberIdForBatchRef.current = memberId;
          if (memberId) setSelectedMemberId(memberId);
          if (isCameraTriggerActive) {
            setIsCameraTriggerActive(false);
            void handleCameraCapture(true);
            return;
          }
          if (isFileTriggerActive) {
            setIsFileTriggerActive(false);
            fileInputRef.current?.click();
            return;
          }
          if (isQuickActionTriggerActive) {
            setIsQuickActionTriggerActive(false);
            setShowQuickActionModal(true);
            return;
          }
          const files = pendingUploadFiles;
          setPendingUploadFiles([]);
          if (files.length === 0) return;
          void stageFilesAndStart(files, memberId);
        }}
        onAddNew={async (name) => {
          try {
            const newId = await handleQuickAddMember(name);
            setShowUploadMemberPicker(false);
            pickedMemberIdForBatchRef.current = newId;
            setSelectedMemberId(newId);
            if (isCameraTriggerActive) {
              setIsCameraTriggerActive(false);
              void handleCameraCapture(true);
              return;
            }
            if (isFileTriggerActive) {
              setIsFileTriggerActive(false);
              fileInputRef.current?.click();
              return;
            }
            if (isQuickActionTriggerActive) {
              setIsQuickActionTriggerActive(false);
              setShowQuickActionModal(true);
              return;
            }
            const files = pendingUploadFiles;
            setPendingUploadFiles([]);
            if (files.length === 0) return;
            void stageFilesAndStart(files, newId);
          } catch (e) {
            // Error handled in handleQuickAddMember
          }
        }}
      />
      {editingMember && isWorkspaceAdmin && (
        <MemberEditModal
          member={editingMember}
          isSaving={isSavingMember}
          onClose={() => setEditingMember(null)}
          onSave={(updates) => void handleSaveMember(updates)}
        />
      )}
    </div>
  );
}
// -------------------------------------------------------------
// DIGITIZATION REVIEW MODAL (Clean, accessible, touch-friendly)
// -------------------------------------------------------------
interface DigitizationModalProps {
  draft: DigitizationDraft;
  error: string;
  members: FamilyMember[];
  profiles: Record<string, HealthProfile>;
  selectedMemberId: string;
  onClose: () => void;
  onSave: (event: React.FormEvent<HTMLFormElement>, targetMemberId: string) => void;
}
function findBestMemberMatch(
  extracted: Partial<HealthEvent>,
  members: FamilyMember[],
  currentSelectedId: string
): string {
  if (!members.length) return '';
  const result = extracted.patientName
    ? findMemberByOcrPatientName(
        extracted.patientName,
        members,
        extracted.patientBirthDate,
        extracted.patientGender,
      )
    : undefined;
  if (result?.matched) return result.matched.id;
  return currentSelectedId || members[0]?.id || '';
}
function DigitizationReviewModal({
  draft,
  error,
  members,
  profiles,
  selectedMemberId,
  onClose,
  onSave,
}: DigitizationModalProps) {
  useBackHandler(
    true,
    () => {
      onClose();
      return true;
    },
    BackPriority.MODAL,
  );
  const extracted = draft.extracted;
  const [targetMemberId, setTargetMemberId] = useState(() =>
    findBestMemberMatch(extracted, members, selectedMemberId)
  );
  const [duplicateResolution, setDuplicateResolution] = useState<'merge' | 'replace' | 'create_new'>('merge');
  // Kiểm tra trùng lặp sự kiện trong timeline của thành viên mục tiêu
  const targetTimeline = profiles[targetMemberId]?.timeline || [];
  const duplicateMatch = useMemo(() => {
    return detectDuplicateEvent(targetTimeline, {
      ...extracted,
      sourceFileId: draft.source.id,
    });
  }, [targetTimeline, extracted, draft.source.id]);
  const targetMember = members.find((member) => member.id === targetMemberId);
  const subjectMatched = Boolean(targetMember && isOcrSubjectMatchedToMember(
    extracted.patientName,
    targetMember,
    members,
    extracted.patientBirthDate,
    extracted.patientGender,
  ));
  const [metricsText, setMetricsText] = useState(
    (extracted.metrics || [])
      .map((metric) => `${metric.name} | ${metric.value} | ${metric.unit}`)
      .join('\n')
  );
  const [medicationsText, setMedicationsText] = useState(
    (extracted.medications || [])
      .map((m) =>
        [
          m.name,
          m.dosage || '',
          m.frequency || '',
          m.duration || '',
          m.quantity || '',
          m.timing || '',
          m.instructions || '',
        ]
          .filter((_, idx, arr) => idx < 4 || arr.slice(idx).some(Boolean))
          .join(' | ')
      )
      .join('\n')
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-3 overflow-y-auto animate-in fade-in"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="digitize-title"
        className="my-auto max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-5 sm:p-7 shadow-2xl space-y-4"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 id="digitize-title" className="text-lg sm:text-xl font-black text-slate-900">
              Kiểm tra & Ghi nhận hồ sơ y tế
            </h2>
            <p className="text-xs text-slate-500 truncate max-w-sm mt-0.5">
              Tệp gốc: {draft.source.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {error && (
          <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
            {error}
          </div>
        )}
        <div className="p-2.5 rounded-xl bg-emerald-50/60 border border-emerald-100 text-[11px] text-emerald-900">
          Kiểm tra nhanh thông tin OCR trước khi lưu.
        </div>
        {/* Đối chiếu & Ghép thông tin bệnh nhân với thành viên gia đình */}
        <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 space-y-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-slate-800">
              Đối chiếu thông tin nhận dạng trên tài liệu:
            </span>
            {targetMember && (
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold flex items-center gap-1 ${
                subjectMatched
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-100 text-amber-900'
              }`}>
                {subjectMatched && <Check className="w-3 h-3 text-emerald-600" />}
                <span>{subjectMatched ? `Đã khớp: ${targetMember.name}` : `Chưa khớp hồ sơ ${targetMember.name}`}</span>
              </span>
            )}
          </div>
          {!subjectMatched && (
            <p className="text-[11px] font-semibold text-amber-800" role="alert">
              {!isRecognizablePatientName(extracted.patientName)
                ? 'OCR chưa đọc được họ tên hợp lệ. Không thể lưu vào hồ sơ thành viên.'
                : 'Tên hoặc thông tin nhận dạng OCR không khớp hồ sơ đã chọn. Không thể lưu tài liệu.'}
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-white p-2 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-400 block font-bold uppercase tracking-wider">Họ tên trên hồ sơ</span>
              <span className="font-bold text-slate-900 truncate block mt-0.5">
                {extracted.patientName || 'Chưa nhận dạng'}
              </span>
            </div>
            <div className="bg-white p-2 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-400 block font-bold uppercase tracking-wider">Ngày/Năm sinh</span>
              <span className="font-bold text-slate-900 truncate block mt-0.5">
                {formatDateVN(extracted.patientBirthDate) || 'Chưa nhận dạng'}
              </span>
            </div>
            <div className="bg-white p-2 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-400 block font-bold uppercase tracking-wider">Giới tính</span>
              <span className="font-bold text-slate-900 truncate block mt-0.5">
                {extracted.patientGender || 'Chưa nhận dạng'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <label htmlFor="target-member-select" className="text-xs font-bold text-slate-700 shrink-0">
              Gán vào hồ sơ của:
            </label>
            <select
              id="target-member-select"
              value={targetMemberId}
              onChange={(e) => setTargetMemberId(e.target.value)}
              className="flex-1 px-3 py-1.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-900 bg-white"
            >
              {members.map((m) => {
                const gLabel = m.gender === 'male' ? 'Nam' : m.gender === 'female' ? 'Nữ' : 'Khác';
                return (
                  <option key={m.id} value={m.id}>
                    {m.name} ({gLabel}{m.birthDate ? ` · Sinh ${formatDateVN(m.birthDate)}` : ''})
                  </option>
                );
              })}
            </select>
          </div>
        </div>
        {/* Cảnh báo sự kiện tương tự / Trùng lặp & Lựa chọn giải pháp thông minh */}
        {duplicateMatch && (
          <div className="p-3.5 rounded-2xl bg-amber-50/90 border-2 border-amber-300 space-y-3 animate-in fade-in">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <span className="font-extrabold text-amber-950 block text-xs sm:text-sm">
                  Phát hiện sự kiện tương tự đã có trong hồ sơ
                </span>
                <span className="text-[11px] text-amber-900 block mt-0.5">
                  Sự kiện cũ: <b>{duplicateMatch.matchedEvent.title}</b> ({duplicateMatch.matchedEvent.date})
                  {duplicateMatch.matchedEvent.facility && ` tại ${duplicateMatch.matchedEvent.facility}`}
                </span>
                <div className="flex flex-wrap gap-1 mt-1 text-[10px] text-amber-800 font-medium">
                  {duplicateMatch.reasons.map((r, i) => (
                    <span key={i} className="bg-amber-100/90 px-2 py-0.5 rounded-md">
                      • {r}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="pt-2 border-t border-amber-200/80 space-y-2">
              <span className="text-[11px] font-bold text-slate-800 block">
                Chọn phương án lưu để tránh trùng lặp dòng thời gian:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <label
                  className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                    duplicateResolution === 'merge'
                      ? 'bg-emerald-50 border-emerald-500 font-bold text-emerald-950 shadow-xs'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="modal_dup_res"
                    checked={duplicateResolution === 'merge'}
                    onChange={() => setDuplicateResolution('merge')}
                    className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
                  />
                  <div className="text-[11px]">
                    <span className="block font-bold">Hợp nhất (Khuyên dùng)</span>
                    <span className="text-[10px] text-slate-500 block font-normal mt-0.5 leading-snug">
                      Gộp bổ sung thuốc & chỉ số mới vào hồ sơ cũ
                    </span>
                  </div>
                </label>
                <label
                  className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                    duplicateResolution === 'replace'
                      ? 'bg-amber-50 border-amber-500 font-bold text-amber-950 shadow-xs'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="modal_dup_res"
                    checked={duplicateResolution === 'replace'}
                    onChange={() => setDuplicateResolution('replace')}
                    className="mt-0.5 text-amber-600 focus:ring-amber-500"
                  />
                  <div className="text-[11px]">
                    <span className="block font-bold">Ghi đè sự kiện cũ</span>
                    <span className="text-[10px] text-slate-500 block font-normal mt-0.5 leading-snug">
                      Thay thế hoàn toàn bằng dữ liệu mới nhất
                    </span>
                  </div>
                </label>
                <label
                  className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-all ${
                    duplicateResolution === 'create_new'
                      ? 'bg-slate-100 border-slate-400 font-bold text-slate-900 shadow-xs'
                      : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="modal_dup_res"
                    checked={duplicateResolution === 'create_new'}
                    onChange={() => setDuplicateResolution('create_new')}
                    className="mt-0.5 text-slate-600 focus:ring-slate-500"
                  />
                  <div className="text-[11px]">
                    <span className="block font-bold">Lưu sự kiện riêng</span>
                    <span className="text-[10px] text-slate-500 block font-normal mt-0.5 leading-snug">
                      Tạo thành 2 sự kiện riêng biệt (cùng ngày)
                    </span>
                  </div>
                </label>
              </div>
            </div>
          </div>
        )}
        <form onSubmit={(e) => onSave(e, targetMemberId)} className="grid gap-3.5 sm:grid-cols-2 text-xs">
          <input type="hidden" name="duplicateResolution" value={duplicateResolution} />
          <input type="hidden" name="matchedEventId" value={duplicateMatch?.matchedEvent.id || ''} />
          <label className="font-bold text-slate-700 sm:col-span-2">
            Tiêu đề hồ sơ *
            <input
              name="title"
              required
              defaultValue={extracted.title || draft.source.name}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900"
            />
          </label>
          <label className="font-bold text-slate-700">
            Ngày khám / kết quả *
            <input
              name="date"
              type="date"
              required
              defaultValue={validDateOrEmpty(extracted.date)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900"
            />
          </label>
          <label className="font-bold text-slate-700">
            Loại hồ sơ y tế
            <select
              name="type"
              defaultValue={validEventType(extracted.type)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900 bg-white"
            >
              {EVENT_TYPE_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="font-bold text-slate-700 sm:col-span-2">
            Cơ sở y tế / Bác sĩ
            <input
              name="facility"
              defaultValue={extracted.facility || ''}
              placeholder="VD: Bệnh viện Bạch Mai, Phòng khám đa khoa..."
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900"
            />
          </label>
          <label className="font-bold text-slate-700 sm:col-span-2">
            Chẩn đoán & Bệnh lý (mỗi dòng một chẩn đoán)
            <textarea
              name="diagnoses"
              rows={2}
              defaultValue={(extracted.diagnoses || []).join('\n')}
              placeholder="VD: Viêm họng cấp&#10;Tăng huyết áp vô căn..."
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900 font-sans"
            />
          </label>
          <label className="font-bold text-slate-700 sm:col-span-2">
            Đơn thuốc (Mỗi dòng: Tên thuốc | liều dùng | tần suất | thời gian)
            <textarea
              value={medicationsText}
              onChange={(e) => setMedicationsText(e.target.value)}
              name="medications"
              rows={3}
              placeholder="VD: Amlodipin | 5mg | 1 viên sáng | 30 ngày"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900 font-mono text-xs"
            />
          </label>
          <label className="font-bold text-slate-700 sm:col-span-2">
            Chỉ số đo (Mỗi dòng: Tên chỉ số | Giá trị | Đơn vị)
            <textarea
              value={metricsText}
              onChange={(e) => setMetricsText(e.target.value)}
              name="metrics"
              rows={3}
              placeholder="VD: Huyết áp tâm thu | 125 | mmHg&#10;Đường huyết | 5.8 | mmol/L"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900 font-mono text-xs"
            />
          </label>
          <label className="font-bold text-slate-700 sm:col-span-2">
            Lời dặn của Bác sĩ
            <textarea
              name="advice"
              rows={2}
              defaultValue={extracted.advice || ''}
              placeholder="Uống nhiều nước, hạn chế muối..."
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900"
            />
          </label>
          <label className="font-bold text-slate-700">
            Ngày tái khám dự kiến (nếu có)
            <input
              name="nextFollowUp"
              type="date"
              defaultValue={validDateOrEmpty(extracted.nextFollowUp)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900"
            />
          </label>
          <label className="font-bold text-slate-700 sm:col-span-2">
            Ghi chú thêm
            <textarea
              name="notes"
              rows={2}
              defaultValue={extracted.notes || ''}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 font-normal text-slate-900"
            />
          </label>
          <div className="flex items-center justify-end gap-2 pt-3 sm:col-span-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 font-bold text-slate-600 hover:bg-slate-50"
            >
              Để sau
            </button>
            <button
              type="submit"
              disabled={!subjectMatched}
              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-extrabold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-50"
            >
              Lưu vào hồ sơ
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
// -------------------------------------------------------------
// HELPER UTILITIES
// -------------------------------------------------------------
function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function parseMedicationLines(value: string): HealthEvent['medications'] {
  return value
    .split(/\r?\n/)
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter(([name]) => Boolean(name))
    .map(([name, dosage, frequency, duration, quantity, timing, instructions]) => ({
      name,
      dosage: dosage || undefined,
      frequency: frequency || undefined,
      duration: duration || undefined,
      quantity: quantity || undefined,
      timing: timing || undefined,
      instructions: instructions || undefined,
    }));
}
function parseMetricLines(value: string): HealthEvent['metrics'] {
  return value
    .split(/\r?\n/)
    .map((line) => line.split('|').map((part) => part.trim()))
    .flatMap(([name, rawValue, unit]) => {
      const metricValue = Number(rawValue?.replace(',', '.'));
      if (!name || !Number.isFinite(metricValue)) return [];
      return [{ name: sanitizeMetricName(name), value: metricValue, unit: unit || '' }];
    });
}
function validDateOrEmpty(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}
function validEventType(value?: string): HealthEvent['type'] {
  return HEALTH_EVENT_TYPES.includes(value as HealthEvent['type'])
    ? (value as HealthEvent['type'])
    : 'other';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
function UploadMemberPickerModal({
  isOpen,
  members,
  adminEmail,
  onClose,
  onSelect,
  onAddNew,
}: {
  isOpen: boolean;
  members: FamilyMember[];
  adminEmail?: string | null;
  onClose: () => void;
  onSelect: (memberId?: string) => void;
  onAddNew: (name: string) => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  useBackHandler(
    isOpen,
    () => {
      onClose();
      return true;
    },
    BackPriority.MODAL,
  );
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div>
            <h3 className="text-base font-black text-slate-900 tracking-tight">Chọn hồ sơ thao tác</h3>
            <p className="text-[11px] text-slate-500 font-medium">Chọn hồ sơ để gán tài liệu y tế</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-full transition-colors text-slate-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {/* Members List */}
          <div className="grid grid-cols-1 gap-2">
            {members.map((member) => {
              const memberRole = getWorkspaceMemberRole(member, adminEmail);
              return (
              <button
                key={member.id}
                onClick={() => onSelect(member.id)}
                className="flex items-center justify-between gap-3 p-3 rounded-2xl border border-slate-100 bg-white hover:border-emerald-200 hover:bg-emerald-50 transition-all text-left group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 font-bold shrink-0 group-hover:scale-105 transition-transform text-xs">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="font-bold text-slate-800 text-sm truncate">{member.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    memberRole === 'Admin'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-600'
                  }`}>
                    {memberRole}
                  </span>
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-emerald-500 group-hover:translate-x-0.5 transition-all" />
                </div>
              </button>
              );
            })}
          </div>
          <div className="pt-2 space-y-2 border-t border-slate-100 mt-2">
            {/* Auto detect option */}
            <button
              onClick={() => onSelect(undefined)}
              className="w-full flex items-center gap-3 p-3 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/30 hover:bg-emerald-50 text-emerald-700 transition-all text-left font-bold text-xs"
            >
              <div className="w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div>Tự động nhận diện</div>
                <div className="text-[9px] font-normal text-emerald-600/70">AI sẽ tự tìm chủ thể trong tài liệu</div>
              </div>
            </button>
            {/* Add new member trigger */}
            {!showAddForm ? (
              <button
                onClick={() => setShowAddForm(true)}
                className="w-full flex items-center gap-3 p-3 rounded-2xl border border-dashed border-slate-200 hover:border-emerald-300 hover:bg-slate-50 text-slate-600 hover:text-emerald-700 transition-all text-left font-bold text-xs"
              >
                <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center group-hover:text-emerald-600">
                  <Plus className="w-4 h-4" />
                </div>
                <span>Thêm hồ sơ thành viên mới</span>
              </button>
            ) : (
              <div className="p-3 rounded-2xl border border-emerald-200 bg-emerald-50/30 animate-in slide-in-from-top-2 duration-200">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nhập tên thành viên..."
                    className="flex-1 bg-white border border-emerald-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-800 outline-none focus:ring-2 focus:ring-emerald-500/20"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newName.trim()) onAddNew(newName);
                    }}
                  />
                  <button
                    disabled={!newName.trim()}
                    onClick={() => onAddNew(newName)}
                    className="bg-emerald-600 text-white px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-50"
                  >
                    Thêm
                  </button>
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setNewName('');
                    }}
                    className="p-2 text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="p-4 bg-slate-50 flex justify-end border-t border-slate-100">
          <button
            onClick={onClose}
            className="text-xs font-bold text-slate-500 hover:text-slate-800 transition-colors"
          >
            Hủy bỏ
          </button>
        </div>
      </div>
    </div>
  );
}
