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
  Clock,
  Cloud,
  Copy,
  ExternalLink,
  FileHeart,
  FileText,
  FileUp,
  FolderHeart,
  FolderSync,
  Heart,
  HeartPulse,
  History,
  Info,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  MessageSquare,
  MoreVertical,
  Pill,
  Plus,
  RefreshCw,
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
  X,
} from 'lucide-react';
import { CameraResultType, CameraSource } from '@capacitor/camera';
import { Camera as CapacitorCamera } from '@capacitor/camera';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppUpdateModal } from './AppUpdateModal';
import { useAppUpdate } from '../hooks/useAppUpdate';
import { AppLogo } from './AppLogo';
import { AiDeepAnalysisCard } from './AiDeepAnalysisCard';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
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
  createHealthWorkspace,
  deleteDriveFamilyMember,
  downloadDriveFile,
  factoryResetWorkspaceFolder,
  findExistingHealthWorkspace,
  type HealthDriveWorkspace,
  openHealthWorkspace,
  loadHealthProfile,
  saveHealthProfile,
  updateDriveFamilyMember,
  uploadRawHealthFile,
  type DriveFile,
} from '../utils/healthDriveService';
import {
  addHealthSource,
  createHealthProfile,
  digitizeHealthSource,
  parseHealthProfile,
  summarizeTimeline,
} from '../utils/healthProfile';
import {
  analyzeComprehensiveHealth,
  askHealthAssistant,
  extractHealthEvent,
  extractHealthEventWithProgress,
  refineAndOrganizeMemberData,
  summarizeHealthProfile,
  type ExtractionProgressUpdate,
} from '../utils/geminiService';
import { DigitizationProgressTrackerModal, type TrackerStep } from './DigitizationProgressTrackerModal';
import { WorkspaceAuditModal } from './WorkspaceAuditModal';
import {
  computeFileFingerprint,
  detectDuplicateFile,
  detectCrossMemberDuplicateFile,
  detectDuplicateEvent,
  cleanAndDeduplicateEventData,
  mergeHealthEvents,
  type FileDuplicateMatch,
  type EventDuplicateMatch,
} from '../utils/deduplicationService';

import {
  clearOcrRecoveryJobs,
  readOcrRecoveryJobs,
  removeOcrRecoveryJob,
  upsertOcrRecoveryJob,
  type OcrRecoveryJob,
} from '../utils/ocrRecoveryStorage';
import {
  listHealthWorkspaceAssignments,
  publishHealthWorkspaceAssignments,
  readHealthWorkspaceAssignment,
  removeHealthWorkspaceAssignment,
  type HealthWorkspaceAssignment,
  type WorkspaceAccessRole,
} from '../utils/workspaceShareRelay';
import { useConfirmDialog } from '../context/ConfirmDialogContext';
import { clearLegacyHealthDemoData } from '../utils/legacyHealthDemo';
import { compressImageIfNeeded } from '../utils/imageCompressor';
import { auth } from '../utils/googleDriveService';
import { isSamePersonName } from '../utils/formatters';

export type DashboardTab = 'overview' | 'timeline' | 'assistant' | 'family';

interface HealthDashboardProps {
  userEmail: string | null;
  appVersion: string;
  driveAuthorized: boolean;
  onConnectDrive: () => void;
  onLogout: () => void;
  showToast: (message: string, type?: 'success' | 'info' | 'error') => void;
}

interface DigitizationDraft {
  source: DriveFile;
  extracted: Partial<HealthEvent>;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

const PROFILE_ROOT_KEY = 'health_family_drive_root_id';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPDATE_SERVER_URL =
  'https://raw.githubusercontent.com/tuanta3012/suckhoegiadinh/refs/heads/main/version.json';

const EVENT_TYPE_OPTIONS: Array<{
  value: HealthEvent['type'];
  label: string;
  color: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: 'medical_report', label: 'Khám bệnh', color: 'emerald', icon: Stethoscope },
  { value: 'prescription', label: 'Đơn thuốc', color: 'blue', icon: Pill },
  { value: 'test_result', label: 'Xét nghiệm', color: 'purple', icon: Activity },
  { value: 'vaccination', label: 'Tiêm chủng', color: 'teal', icon: HeartPulse },
  { value: 'discharge', label: 'Ra viện', color: 'indigo', icon: FileHeart },
  { value: 'other', label: 'Khác', color: 'slate', icon: FileText },
];

export function HealthDashboard({
  userEmail,
  appVersion,
  driveAuthorized,
  onConnectDrive,
  onLogout,
  showToast,
}: HealthDashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [rootIdInput, setRootIdInput] = useState('');
  const [workspace, setWorkspace] = useState<HealthDriveWorkspace | null>(null);
  const [profiles, setProfiles] = useState<Record<string, HealthProfile>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberBirthDate, setNewMemberBirthDate] = useState('');
  const [newMemberGender, setNewMemberGender] = useState<'male' | 'female' | 'other'>('male');
  const [workspaceAssignments, setWorkspaceAssignments] = useState<HealthWorkspaceAssignment[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceAccessRole>('EDITOR');
  const [digitizationDraft, setDigitizationDraft] = useState<DigitizationDraft | null>(null);
  const [digitizationError, setDigitizationError] = useState('');
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
    detectedMemberMatch: FamilyMember | null;
    isRoutingDecisionRequired: boolean;
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
    detectedMemberMatch: null,
    isRoutingDecisionRequired: false,
  });
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('');
  const [timelineFilter, setTimelineFilter] = useState<string>('all');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [showSettingsDropdown, setShowSettingsDropdown] = useState(false);
  const memberMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

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
  const [showWorkspaceAuditModal, setShowWorkspaceAuditModal] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [queueStatus, setQueueStatus] = useState<{ current: number; total: number } | null>(null);
  const [ocrRecoveryJobs, setOcrRecoveryJobs] = useState<OcrRecoveryJob[]>([]);

  // Refs to maintain fresh data in async queue closure
  const workspaceRef = useRef<HealthDriveWorkspace | null>(null);
  const profilesRef = useRef<Record<string, HealthProfile>>({});
  const selectedMemberIdRef = useRef<string>(selectedMemberId);
  const uploadQueueRef = useRef<File[]>([]);
  const authIdentityRef = useRef({ userEmail, driveAuthorized });
  authIdentityRef.current = { userEmail, driveAuthorized };
  const previousSelectedMemberIdRef = useRef(selectedMemberId);
  const previousWorkspaceRootRef = useRef(workspace?.rootFolderId);

  useEffect(() => {
    if (previousSelectedMemberIdRef.current !== selectedMemberId) {
      previousSelectedMemberIdRef.current = selectedMemberId;
      setChatMessages([]);
      setChatInput('');
      setSelectedMetric('');
      setTimelineFilter('all');
    }
  }, [selectedMemberId]);

  useEffect(() => {
    if (previousWorkspaceRootRef.current !== workspace?.rootFolderId) {
      previousWorkspaceRootRef.current = workspace?.rootFolderId;
      setChatMessages([]);
      setChatInput('');
      setSelectedMetric('');
      setTimelineFilter('all');
    }
  }, [workspace?.rootFolderId]);

  useEffect(() => {
    if (driveAuthorized && userEmail) return;

    workspaceRef.current = null;
    profilesRef.current = {};
    selectedMemberIdRef.current = '';
    uploadQueueRef.current = [];
    setWorkspace(null);
    setProfiles({});
    setProfileErrors({});
    setSelectedMemberId('');
    setRootIdInput('');
    setErrorMessage('');
    setWorkspaceAssignments([]);
    setInviteEmail('');
    setActiveTab('overview');
    setChatMessages([]);
    setChatInput('');
    setDigitizationDraft(null);
    setDigitizationError('');
    setUploadQueue([]);
    setQueueStatus(null);
    setSelectedMetric('');
    setTimelineFilter('all');
    setIsUploading(false);
    setIsLoading(false);
    setIsChatting(false);
    setIsSummarizing(false);
    setIsRefining(false);
    setTrackerState((previous) => ({
      ...previous,
      isOpen: false,
      file: null,
      driveFile: null,
      memberId: '',
      partialExtracted: {},
      error: null,
      detectedMemberMatch: null,
      isRoutingDecisionRequired: false,
    }));
  }, [driveAuthorized, userEmail]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    selectedMemberIdRef.current = selectedMemberId;
  }, [selectedMemberId]);

  useEffect(() => {
    uploadQueueRef.current = uploadQueue;
  }, [uploadQueue]);

  function persistOcrRecoveryJob(
    driveFileId: string,
    status: OcrRecoveryJob['status'],
    progressPercent: number,
  ) {
    if (!workspace) return;
    try {
      setOcrRecoveryJobs(upsertOcrRecoveryJob(workspace.rootFolderId, {
        driveFileId,
        status,
        progressPercent,
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

    showToast(
      `Đang tự động chuẩn hóa danh pháp & phân tích y khoa 4 lớp cho ${targetMember.name}...`,
      'info',
    );
    setIsSummarizing(true);
    try {
      // 1. Tự động Chuẩn hóa & Sắp xếp toàn bộ dữ liệu mới (Batch Refinement)
      const { organizedTimeline } = await refineAndOrganizeMemberData(
        targetMember,
        currentProfile.timeline,
      );
      
      const refinedProfile: HealthProfile = {
        ...currentProfile,
        timeline: organizedTimeline,
      };

      // 2. Tự động Phân tích 4 Lớp Y Khoa Chuyên Sâu (AI 4-Layer Assessment & Schema v2)
      const narrative = await summarizeHealthProfile(targetMember, refinedProfile);
      const deepRes = await analyzeComprehensiveHealth(targetMember, refinedProfile);
      
      const updated: HealthProfile = {
        ...refinedProfile,
        summary: { ...refinedProfile.summary, narrative },
        aiDeepAnalysis: deepRes.result,
        aiAnalysis: deepRes.aiAnalysis,
        updatedAt: new Date().toISOString(),
      };
      
      const saved = await saveHealthProfile(targetMember.profileFileId, updated);
      profilesRef.current = { ...profilesRef.current, [targetMember.id]: saved };
      setProfiles((prev) => ({ ...prev, [targetMember.id]: saved }));
      showToast(`Đã tự động chuẩn hóa & cập nhật phân tích 4 lớp lên trang chính của ${targetMember.name}!`, 'success');
    } catch (error) {
      console.warn('[Auto Family Doctor Summary Warning]:', error);
      showToast(
        error instanceof Error ? error.message : 'Lỗi khi tự động phân tích chuyên sâu.',
        'error',
      );
    } finally {
      setIsSummarizing(false);
    }
  }

  function processNextInQueue() {
    const queue = uploadQueueRef.current.length > 0 ? uploadQueueRef.current : uploadQueue;
    if (queue.length > 0) {
      const nextFile = queue[0];
      const remaining = queue.slice(1);
      uploadQueueRef.current = remaining;
      setUploadQueue(remaining);
      const nextCurrent = (queueStatus?.current || 1) + 1;
      const total = queueStatus?.total || (remaining.length + nextCurrent);
      setQueueStatus({ current: nextCurrent, total });
      showToast(`Hàng đợi tải lên: Đang xử lý tệp ${nextCurrent}/${total} (${nextFile.name})...`, 'info');
      void beginDigitization(nextFile);
    } else {
      uploadQueueRef.current = [];
      if (queueStatus) {
        showToast(`Đã nhập dữ liệu xong toàn bộ ${queueStatus.total} tệp! Bắt đầu tự động chuẩn hóa & phân tích 4 lớp...`, 'success');
      }
      setQueueStatus(null);
      // Tự động kích hoạt toàn bộ luồng chuẩn hóa & phân tích 4 lớp sau khi tất cả các tệp hoàn tất
      void runFamilyDoctorSummaryAfterQueue();
    }
  }

  async function handleFactoryReset() {
    if (!workspace || !userEmail) return;
    const fresh = await factoryResetWorkspaceFolder(workspace, userEmail);
    try {
      clearOcrRecoveryJobs(workspace.rootFolderId);
      setOcrRecoveryJobs([]);
    } catch (error) {
      console.error('[OCR recovery] Could not clear local recovery metadata after reset.', error);
      showToast('Đã xóa Drive nhưng không thể dọn trạng thái OCR cục bộ.', 'error');
    }
    setWorkspace(fresh);
    setProfiles({});
    setSelectedMemberId('');
    setDigitizationDraft(null);
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

  const members = workspace?.family.members || [];
  const isWorkspaceAdmin = Boolean(
    !workspace ||
      (userEmail &&
        workspace?.family.adminEmail &&
        userEmail.trim().toLowerCase() === workspace.family.adminEmail.trim().toLowerCase())
  );

  const selectedMember = members.find((m) => m.id === selectedMemberId) || members[0] || null;
  const selectedProfile = selectedMember ? profiles[selectedMember.id] : null;
  const trackerMember =
    members.find((member) => member.id === trackerState.memberId) || selectedMember;

  // Extract all available vital metrics from selected member's timeline
  const metricNames = useMemo(() => {
    if (!selectedProfile?.timeline) return [];
    const set = new Set<string>();
    for (const event of selectedProfile.timeline) {
      for (const m of event.metrics) {
        if (m.name) set.add(m.name);
      }
    }
    return Array.from(set);
  }, [selectedProfile]);

  useEffect(() => {
    if (metricNames.length > 0 && !metricNames.includes(selectedMetric)) {
      setSelectedMetric(metricNames[0]);
    }
  }, [metricNames, selectedMetric]);

  // Chart data for chosen metric
  const chartData = useMemo(() => {
    if (!selectedProfile?.timeline || !selectedMetric) return [];
    return selectedProfile.timeline
      .filter((event) => event.metrics.some((m) => m.name === selectedMetric))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((event) => {
        const met = event.metrics.find((m) => m.name === selectedMetric);
        return {
          date: event.date,
          value: met?.value,
          unit: met?.unit || '',
          facility: event.facility || '',
        };
      });
  }, [selectedProfile, selectedMetric]);

  // Filtered timeline
  const filteredTimeline = useMemo(() => {
    if (!selectedProfile?.timeline) return [];
    const list = [...selectedProfile.timeline].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    if (timelineFilter === 'all') return list;
    return list.filter((event) => event.type === timelineFilter);
  }, [selectedProfile, timelineFilter]);

  // Upcoming follow-up reminders across all members
  const upcomingFollowUps = useMemo(() => {
    const list: Array<{
      member: FamilyMember;
      event: HealthEvent;
      followUpDate: string;
      daysRemaining: number;
    }> = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (const member of members) {
      const prof = profiles[member.id];
      if (!prof?.timeline) continue;
      for (const event of prof.timeline) {
        if (event.nextFollowUp) {
          const fDate = new Date(event.nextFollowUp);
          if (!isNaN(fDate.getTime())) {
            const diffTime = fDate.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays >= -14) {
              // Show recent and future follow-ups
              list.push({
                member,
                event,
                followUpDate: event.nextFollowUp,
                daysRemaining: diffDays,
              });
            }
          }
        }
      }
    }
    return list.sort((a, b) => a.daysRemaining - b.daysRemaining);
  }, [members, profiles]);

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
    if (!authIdentity.driveAuthorized || !authIdentity.userEmail) return {};

    const entries = await Promise.all(
      nextWorkspace.family.members.map(async (member) => {
        try {
          const remote = await loadHealthProfile(member.profileFileId);
          return [member.id, parseHealthProfile(remote, member), null] as const;
        } catch (error) {
          return [
            member.id,
            null,
            error instanceof Error ? error.message : 'Không tải được hồ sơ.',
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
    setProfiles(nextProfiles);
    setProfileErrors(nextErrors);
    setSelectedMemberId((current) =>
      nextWorkspace.family.members.some((m) => m.id === current)
        ? current
        : nextWorkspace.family.members[0]?.id || ''
    );
    return nextProfiles;
  }, []);

  const openWorkspace = useCallback(
    async (id: string) => {
      const authIdentity = authIdentityRef.current;
      if (!authIdentity.driveAuthorized || !authIdentity.userEmail) return;
      setIsLoading(true);
      setErrorMessage('');
      try {
        const opened = await openHealthWorkspace(id.trim());
        if (
          authIdentityRef.current.userEmail !== authIdentity.userEmail ||
          !authIdentityRef.current.driveAuthorized
        ) {
          return;
        }
        if (userEmail) {
          localStorage.setItem(
            `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`,
            opened.rootFolderId
          );
        }
        localStorage.setItem(PROFILE_ROOT_KEY, opened.rootFolderId);
        setWorkspace(opened);
        setRootIdInput(opened.rootFolderId);
        await reloadProfiles(opened);
        showToast('Đã kết nối thư mục Google Drive thành công.', 'success');
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : 'Không thể mở thư mục Drive.'
        );
      } finally {
        setIsLoading(false);
      }
    },
    [reloadProfiles, showToast, userEmail]
  );

  // Auto-connect workspace on mount
  useEffect(() => {
    if (!driveAuthorized || !userEmail || workspace) return;
    let cancelled = false;
    const savedRootId =
      localStorage.getItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`) ||
      localStorage.getItem(PROFILE_ROOT_KEY);
    if (savedRootId) {
      void openWorkspace(savedRootId);
      return () => {
        cancelled = true;
      };
    }

    void readHealthWorkspaceAssignment(userEmail)
      .then(async (assignment) => {
        if (cancelled) return;
        if (assignment) {
          void openWorkspace(assignment.rootFolderId);
          return;
        }

        // Tự động tìm kiếm thư mục Sức khỏe Gia đình đã có trên Drive của tài khoản
        try {
          const discovered = await findExistingHealthWorkspace();
          if (!cancelled && discovered) {
            if (userEmail) {
              localStorage.setItem(
                `${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`,
                discovered.rootFolderId
              );
            }
            localStorage.setItem(PROFILE_ROOT_KEY, discovered.rootFolderId);
            setWorkspace(discovered);
            setRootIdInput(discovered.rootFolderId);
            await reloadProfiles(discovered);
            showToast('Đã tự động kết nối thư mục Suc khoe gia dinh trên Google Drive.', 'success');
          }
        } catch {
          // Bỏ qua nếu chưa thể truy cập hoặc chưa có thư mục
        }
      })
      .catch((error: unknown) => {
        // Tự động bỏ qua lỗi khi chưa có bản ghi chuyển tiếp từ admin khác.
        // Người dùng đăng nhập như một Admin mới và tự tạo Workspace trên Drive của mình.
        console.info('[Workspace] Chưa có bản ghi chia sẻ folderId từ Admin khác:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [driveAuthorized, openWorkspace, reloadProfiles, showToast, userEmail, workspace]);

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
  const reloadWorkspaceAssignments = useCallback(async () => {
    if (!workspace || !isWorkspaceAdmin) return;
    try {
      setWorkspaceAssignments(await listHealthWorkspaceAssignments(workspace.rootFolderId));
    } catch (error) {
      console.warn('Lỗi tải quyền chia sẻ:', error);
    }
  }, [isWorkspaceAdmin, workspace]);

  useEffect(() => {
    void reloadWorkspaceAssignments();
  }, [reloadWorkspaceAssignments]);

  async function handleCreateWorkspace() {
    if (!driveAuthorized) {
      onConnectDrive();
      return;
    }
    setIsLoading(true);
    setErrorMessage('');
    try {
      const created = await createHealthWorkspace(userEmail || '');
      localStorage.setItem(
        `${PROFILE_ROOT_KEY}_${userEmail?.trim().toLowerCase()}`,
        created.rootFolderId
      );
      localStorage.setItem(PROFILE_ROOT_KEY, created.rootFolderId);
      setWorkspace(created);
      setRootIdInput(created.rootFolderId);
      showToast('Đã tạo thư mục Suc khoe gia dinh trên Google Drive!', 'success');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể tạo thư mục gia đình.'
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAddMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !newMemberName.trim()) return;
    setIsAddingMember(true);
    setErrorMessage('');
    try {
      const memberId = `member_${crypto.randomUUID().slice(0, 12)}`;
      const next = await addDriveFamilyMember(workspace, {
        id: memberId,
        name: newMemberName.trim(),
        birthDate: newMemberBirthDate || undefined,
        gender: newMemberGender,
        role: 'other',
      });
      setWorkspace(next);
      setNewMemberName('');
      setNewMemberBirthDate('');
      setNewMemberGender('male');
      await reloadProfiles(next);
      setSelectedMemberId(memberId);
      setActiveTab('timeline');
      showToast(`Đã thêm thành viên ${newMemberName.trim()} vào hồ sơ gia đình.`, 'success');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể thêm thành viên.');
    } finally {
      setIsAddingMember(false);
    }
  }

  async function handleDeleteFamilyMember(member: FamilyMember) {
    if (!workspace || !driveAuthorized) return;
    const confirmed = await confirm({
      title: `Xóa vĩnh viễn hồ sơ của ${member.name}?`,
      message: `Thao tác này sẽ gỡ thành viên khỏi Workspace và xóa vĩnh viễn hồ sơ JSON cùng toàn bộ tài liệu trong thư mục Drive của họ. Không thể hoàn tác.`,
      confirmLabel: 'Xóa vĩnh viễn',
    });
    if (!confirmed) return;

    setIsLoading(true);
    setErrorMessage('');
    try {
      const { workspace: next } = await deleteDriveFamilyMember(workspace, member.id);
      for (const source of profiles[member.id]?.sources || []) {
        forgetOcrRecoveryJob(source.driveFileId);
      }
      setWorkspace(next);
      setProfiles((previous) => {
        const { [member.id]: _deletedProfile, ...remaining } = previous;
        return remaining;
      });
      setProfileErrors((previous) => {
        const { [member.id]: _deletedError, ...remaining } = previous;
        return remaining;
      });
      setSelectedMemberId(next.family.members[0]?.id || '');
      setChatMessages([]);
      setActiveTab(next.family.members.length ? 'family' : 'overview');
      showToast(`Đã xóa vĩnh viễn thành viên ${member.name} và hồ sơ Drive liên quan.`, 'success');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể xóa thành viên.');
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

  async function beginDigitization(file: File, options?: { forceUpload?: boolean }) {
    if (!workspaceRef.current) {
      showToast('Hãy kết nối Google Drive trước khi tải tài liệu.', 'error');
      return;
    }

    // TỰ ĐỘNG KHỞI TẠO THÀNH VIÊN ĐẦU TIÊN NẾU CHƯA CÓ (Quick Start Flow)
    // SỬ DỤNG REF để lấy danh sách thành viên mới nhất
    const currentWorkspace = workspaceRef.current;
    const currentMembers = currentWorkspace.family.members;
    const targetMemberId = selectedMemberIdRef.current || selectedMemberId;
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
        setIsUploading(false);
        processNextInQueue();
        return;
      }
    }

    // KIỂM TRA HỒ SƠ SẴN SÀNG (Robust Loading for Batch)
    let currentProfile = profilesRef.current[effectiveMember.id] || profiles[effectiveMember.id];
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
            processNextInQueue();
            return;
          }
        }
      }
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('Tệp vượt quá giới hạn cho phép 25 MB.', 'error');
      processNextInQueue();
      return;
    }

    // Kiểm tra trùng lặp tài liệu trước khi tải lên Drive
    let existingDriveFileId: string | undefined = undefined;
    if (!options?.forceUpload) {
      try {
        const { hash, size } = await computeFileFingerprint(file);
        const activeProfile = profiles[effectiveMember.id] || createHealthProfile(effectiveMember);
        const fileDup = detectDuplicateFile({ name: file.name, size }, hash, activeProfile, effectiveMember);
        const crossDup = fileDup ? null : detectCrossMemberDuplicateFile({ name: file.name, size }, hash, profiles, effectiveMember.id);
        const match = fileDup || crossDup;

        if (match) {
          const sourceStatus = match.existingSource.status;
          // 1. Tự động BỎ QUA nếu tệp đã được tải lên và số hóa toàn bộ
          if (sourceStatus === 'processed') {
            const memberMsg = match.memberName && match.memberName !== effectiveMember.name
              ? `trong hồ sơ của ${match.memberName}`
              : `trong hồ sơ của ${effectiveMember.name}`;
            showToast(`Tệp "${file.name}" đã được số hóa hoàn tất trước đó (${memberMsg}). Tự động bỏ qua.`, 'info');
            processNextInQueue();
            return;
          }

          // 2. Tự động LÀM LẠI nếu tệp đã tải lên nhưng chưa số hóa hoàn tất: Tái sử dụng tệp đã có trên Drive, KHÔNG tải bản sao mới
          existingDriveFileId = match.existingSource.driveFileId;
          showToast(`Phát hiện tệp "${file.name}" đã có trên Drive nhưng chưa hoàn tất. Đang tự động quét lại dữ liệu...`, 'info');
        }
      } catch (err) {
        console.warn('[Deduplication Pre-check Failed]:', err);
      }
    }

    setIsUploading(true);
    setDigitizationError('');
    setShowQuickActionModal(false);

    // 1. Tối ưu ảnh chụp phía client
    let processedFile: File;
    try {
      processedFile = await compressImageIfNeeded(file);
    } catch (error) {
      setIsUploading(false);
      showToast(error instanceof Error ? error.message : 'Không thể chuẩn bị tệp hình ảnh.', 'error');
      processNextInQueue();
      return;
    }

    // Mở ngay modal theo dõi tiến trình
    setTrackerState({
      isOpen: true,
      file: processedFile,
      memberId: effectiveMember.id,
      step: 'uploading_drive',
      progressPercent: 25,
      progressMessage: existingDriveFileId
        ? 'Tệp đã có trên Drive. Đang chạy AI Vision quét lại dữ liệu...'
        : 'Đang tải tài liệu lên Drive trước khi bắt đầu số hóa...',
      driveFile: null,
      modelUsed: 'gemini-3.5-flash-lite',
      partialExtracted: {},
      error: null,
      detectedMemberMatch: null,
      isRoutingDecisionRequired: false,
    });

    try {
      if (existingDriveFileId) {
        // Tệp đã có trên Google Drive: Tái sử dụng tệp gốc, KHÔNG tạo bản sao trùng lặp trên Drive
        await runDocumentExtraction(processedFile, effectiveMember, existingDriveFileId);
        const reusedUploaded: DriveFile = {
          id: existingDriveFileId,
          name: processedFile.name,
          mimeType: processedFile.type || 'application/octet-stream',
          createdTime: new Date().toISOString(),
        };
        setTrackerState((prev) => ({ ...prev, driveFile: reusedUploaded }));
      } else {
        const uploaded = await uploadRawHealthFile(effectiveMember, processedFile);
        setTrackerState((prev) => ({ ...prev, driveFile: uploaded }));

        const { hash } = await computeFileFingerprint(processedFile);
        const source: HealthSource = {
          driveFileId: uploaded.id,
          fileName: uploaded.name,
          fileSize: processedFile.size,
          fileHash: hash,
          mimeType: uploaded.mimeType || processedFile.type || 'application/octet-stream',
          uploadedAt: uploaded.createdTime || new Date().toISOString(),
          status: 'pending',
        };
        const current = profilesRef.current[effectiveMember.id] ||
          currentProfile ||
          createHealthProfile(effectiveMember);
        const stagedProfile = addHealthSource(current, source);
        const savedProfile = await saveHealthProfile(effectiveMember.profileFileId, stagedProfile);
        profilesRef.current = { ...profilesRef.current, [effectiveMember.id]: savedProfile };
        setProfiles((previous) => ({ ...previous, [effectiveMember.id]: savedProfile }));

        await runDocumentExtraction(processedFile, effectiveMember, uploaded.id);
      }

    } catch (error) {
      const msg = error instanceof Error
        ? error.message
        : 'Không thể hoàn tất lưu tài liệu vào Google Drive hoặc hồ sơ thành viên.';
      
      // Nếu lỗi do mạng, vẫn thử cho qua để xử lý tệp tiếp theo sau vài giây
      setTrackerState((prev) => ({
        ...prev,
        step: 'error',
        progressMessage: 'Lỗi trong quá trình xử lý',
        error: msg,
      }));
      
      if (uploadQueueRef.current.length > 0 || uploadQueue.length > 0) {
        setTimeout(() => {
          setTrackerState(prev => ({ ...prev, isOpen: false }));
          processNextInQueue();
        }, 3000);
      }
    } finally {
      setIsUploading(false);
    }
  }

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
      };
    });
  }

  async function autoCommitAndRefineDigitization(
    extracted: Partial<HealthEvent>,
    file: File,
    member: FamilyMember,
    driveFileId?: string,
    overrideProfiles?: Record<string, HealthProfile>,
  ) {
    try {
      const currentProfiles = overrideProfiles || profilesRef.current;
      let profile = currentProfiles[member.id] || createHealthProfile(member);
      if (driveFileId && !profile.sources.some((source) => source.driveFileId === driveFileId)) {
        const source = Object.values(currentProfiles)
          .flatMap((candidate) => candidate.sources)
          .find((candidate) => candidate.driveFileId === driveFileId);
        if (!source) {
          throw new Error('Không tìm thấy tài liệu nguồn cần liên kết với hồ sơ thành viên đã chọn.');
        }
        profile = await saveHealthProfile(
          member.profileFileId,
          addHealthSource(profile, source),
        );
        profilesRef.current = { ...profilesRef.current, [member.id]: profile };
        setProfiles((previous) => ({ ...previous, [member.id]: profile }));
      }
      const rawEvent: HealthEvent = {
        id: `event_${crypto.randomUUID()}`,
        sourceFileId: driveFileId,
        sourceFileName: file.name,
        type: validEventType(extracted.type),
        title: extracted.title || file.name || 'Hồ sơ y tế mới',
        date: extracted.date || new Date().toISOString().slice(0, 10),
        facility: extracted.facility,
        diagnoses: extracted.diagnoses || [],
        medications: extracted.medications || [],
        metrics: extracted.metrics || [],
        imagingResults: extracted.imagingResults || [],
        advice: extracted.advice,
        nextFollowUp: extracted.nextFollowUp,
        notes: extracted.notes,
        patientName: extracted.patientName,
        patientBirthDate: extracted.patientBirthDate,
        patientGender: extracted.patientGender,
        extractedData: isRecord(extracted.extractedData)
          ? (extracted.extractedData as Record<string, JsonValue>)
          : undefined,
        recordedAt: new Date().toISOString(),
      };

      // 1. Làm sạch & Khử trùng lặp nội bộ sự kiện
      const cleanEvent = cleanAndDeduplicateEventData(rawEvent);

      // 2. Tự động kiểm tra trùng lặp sự kiện cũ trong profile
      const dupMatch = detectDuplicateEvent(profile.timeline, cleanEvent);
      let updatedProfile: HealthProfile;

      if (dupMatch && dupMatch.score >= 0.7) {
        const mergedEvent = mergeHealthEvents(dupMatch.matchedEvent, cleanEvent);
        const updatedTimeline = profile.timeline.map((item) =>
          item.id === dupMatch.matchedEvent.id ? mergedEvent : item,
        );
        updatedProfile = {
          ...profile,
          timeline: updatedTimeline,
          summary: summarizeTimeline(updatedTimeline, profile.summary.narrative),
          updatedAt: new Date().toISOString(),
        };
      } else {
        updatedProfile = digitizeHealthSource(profile, cleanEvent);
      }

      if (driveFileId) {
        updatedProfile.sources = updatedProfile.sources.map((item) =>
          item.driveFileId === driveFileId
            ? { ...item, status: 'processed' as const, digitizedAt: new Date().toISOString() }
            : item,
        );
        forgetOcrRecoveryJob(driveFileId);
      }

      // Lưu hồ sơ đã số hóa cơ bản (không Refine tại đây)
      const savedProfile = await saveHealthProfile(member.profileFileId, updatedProfile);
      profilesRef.current = { ...profilesRef.current, [member.id]: savedProfile };
      selectedMemberIdRef.current = member.id;
      setProfiles((prev) => ({ ...prev, [member.id]: savedProfile }));
      setSelectedMemberId(member.id);

      setTrackerState((prev) => ({
        ...prev,
        step: 'completed',
        progressPercent: 100,
        progressMessage: `Đã số hóa & lưu tạm thời cho ${member.name}!`,
      }));

      showToast(`Đã số hóa & lưu tệp "${file.name}" cho ${member.name}.`, 'success');

      // Tự động chuyển tiếp tệp tiếp theo
      setTimeout(() => {
        setTrackerState((prev) => ({ ...prev, isOpen: false }));
        processNextInQueue();
      }, 500);
    } catch (error) {
      console.error('[Auto Commit Error]:', error);
      showToast(error instanceof Error ? error.message : 'Lỗi khi tự động lưu hồ sơ.', 'error');
      processNextInQueue();
    }
  }

  async function runDocumentExtraction(file: File, member: FamilyMember, driveFileId?: string) {
    let latestProgress = 45;
    try {
      const reportProgress = (update: ExtractionProgressUpdate) => {
        applyExtractionProgress(update);
        latestProgress = update.progressPercent;
        if (driveFileId) persistOcrRecoveryJob(driveFileId, 'processing', latestProgress);
      };
      const result = await extractHealthEventWithProgress(file, member, reportProgress);
      if (driveFileId) persistOcrRecoveryJob(driveFileId, 'needs_review', 100);

      // SỬ DỤNG REF để lấy danh sách thành viên mới nhất (tránh race condition trong hàng đợi)
      const currentMembers = workspaceRef.current?.family.members || [];
      const patientNameRaw = result.extracted.patientName?.trim() || '';

      // 1. Phân tích đối khớp thành viên bằng thuật toán so khớp tên tiếng Việt thông minh (bỏ dấu, hoa thường, tiền tố y tế BN, Bệnh nhân...)
      let isMatchCurrent = !patientNameRaw || isSamePersonName(patientNameRaw, member.name);

      let matchedMember: FamilyMember | null = null;
      if (!isMatchCurrent && patientNameRaw) {
        matchedMember = currentMembers.find((m) => m.id !== member.id && isSamePersonName(patientNameRaw, m.name)) || null;
      }

      let isMismatch = Boolean(!isMatchCurrent && matchedMember);
      let isNewPerson = Boolean(!isMatchCurrent && !matchedMember && patientNameRaw.length > 3);

      // Tự động gán tên tài liệu cho hồ sơ mặc định đầu tiên nếu thành viên hiện tại là placeholder
      const isPlaceholder = member.name === 'Thành viên mới' || member.name === 'Gia đình' || member.name.toLowerCase().includes('thanh vien');
      if (isNewPerson && isPlaceholder && currentMembers.length === 1 && workspaceRef.current) {
        try {
          const updatedWorkspace = await updateDriveFamilyMember(workspaceRef.current, member.id, {
            name: patientNameRaw,
            birthDate: result.extracted.patientBirthDate || undefined,
            gender: (result.extracted.patientGender === 'Nam' || result.extracted.patientGender === 'male') ? 'male' : (result.extracted.patientGender === 'Nữ' || result.extracted.patientGender === 'female') ? 'female' : member.gender,
          });
          workspaceRef.current = updatedWorkspace;
          setWorkspace(updatedWorkspace);
          member = updatedWorkspace.family.members.find(m => m.id === member.id) || member;
          selectedMemberIdRef.current = member.id;
          setSelectedMemberId(member.id);
          isMatchCurrent = true;
          isMismatch = false;
          isNewPerson = false;
        } catch {
          // Bỏ qua lỗi cập nhật tên và tiếp tục flow bình thường
        }
      }

      setTrackerState((prev) => ({
        ...prev,
        step: 'completed',
        progressPercent: 90,
        progressMessage: 'Bóc tách dữ liệu thành công. Kiểm tra đối khớp thành viên...',
        partialExtracted: result.extracted,
        modelUsed: result.modelUsed || prev.modelUsed,
        detectedMemberMatch: matchedMember,
        isRoutingDecisionRequired: Boolean(isMismatch || isNewPerson),
      }));

      // Nếu khớp hoàn toàn với thành viên hiện tại hoặc không có thông tin người bệnh, cứ tự động lưu
      if (!isMismatch && !isNewPerson) {
        await autoCommitAndRefineDigitization(result.extracted, file, member, driveFileId);
      } else if (isMismatch && matchedMember) {
        // TỰ ĐỘNG CHUYỂN HỒ SƠ nếu phát hiện khớp chính xác với thành viên khác (Mượt mà UX)
        showToast(`Phát hiện tài liệu của ${matchedMember.name}. Hệ thống đang tự động chuyển hồ sơ...`, 'info');
        await autoCommitAndRefineDigitization(result.extracted, file, matchedMember, driveFileId);
      } else {
        // Tạm dừng nếu phát hiện người mới hoàn toàn để người dùng quyết định
        setTrackerState(prev => ({
          ...prev,
          progressMessage: `Phát hiện người bệnh mới: ${result.extracted.patientName || 'Chưa rõ'}. Vui lòng chọn hành động.`,
          step: 'matching_patient'
        }));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Chưa thể phân tích tài liệu bằng Gemini.';
      if (driveFileId) persistOcrRecoveryJob(driveFileId, 'interrupted', latestProgress);
      setDigitizationError(msg);
      setTrackerState((prev) => ({
        ...prev,
        step: 'error',
        progressMessage: 'Lỗi nhận dạng tài liệu',
        error: msg,
      }));
      showToast('Tài liệu đã lưu trên Drive. Bạn có thể nhập thủ công hoặc thử lại.', 'info');
      processNextInQueue();
    }
  }

  async function retryDigitization() {
    const file = trackerState.file;
    const member = members.find((item) => item.id === trackerState.memberId);
    if (!file || !member) return;

    if (!trackerState.driveFile) {
      void beginDigitization(file, { forceUpload: true });
      return;
    }

    setIsUploading(true);
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
      await runDocumentExtraction(file, member, trackerState.driveFile.id);
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
      setIsUploading(false);
    }
  }

  async function resumeInterruptedOcr(job: OcrRecoveryJob) {
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

    setIsUploading(true);
    try {
      const blob = await downloadDriveFile(job.driveFileId);
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new Error('Tài liệu trên Drive vượt quá giới hạn 25 MB.');
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
        isOpen: true,
        file,
        memberId: member.id,
        step: 'reading_document',
        progressPercent: 45,
        progressMessage: 'Đã khôi phục từ Google Drive. Đang chạy lại OCR theo từng phần...',
        driveFile,
        modelUsed: 'gemini-3.5-flash-lite',
        partialExtracted: {},
        error: null,
        detectedMemberMatch: null,
        isRoutingDecisionRequired: false,
      });
      persistOcrRecoveryJob(job.driveFileId, 'processing', 45);
      await runDocumentExtraction(file, member, job.driveFileId);
    } catch (error) {
      persistOcrRecoveryJob(job.driveFileId, 'interrupted', job.progressPercent);
      showToast(error instanceof Error ? error.message : 'Không thể khôi phục OCR từ Google Drive.', 'error');
    } finally {
      setIsUploading(false);
    }
  }

  async function handleCameraCapture() {
    try {
      const photo = await CapacitorCamera.getPhoto({
        quality: 85,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
      });
      if (!photo.webPath) throw new Error('Camera không trả về ảnh.');
      const response = await fetch(photo.webPath);
      if (!response.ok) throw new Error('Không đọc được ảnh chụp từ camera.');
      const blob = await response.blob();
      const file = new File(
        [blob],
        `kham-benh-${new Date().toISOString().slice(0, 10)}.${photo.format || 'jpg'}`,
        { type: blob.type || 'image/jpeg' }
      );
      await beginDigitization(file);
    } catch (error) {
      if (error instanceof Error && !/cancel|cancelled|canceled/i.test(error.message)) {
        showToast(error.message, 'error');
      }
    }
  }

  async function handleSaveDigitization(
    event: React.FormEvent<HTMLFormElement>,
    targetMemberId?: string
  ) {
    event.preventDefault();
    const effectiveMember =
      (targetMemberId && members.find((m) => m.id === targetMemberId)) || selectedMember;
    const effectiveProfile = effectiveMember ? profiles[effectiveMember.id] : selectedProfile;
    if (!digitizationDraft || !effectiveMember || !effectiveProfile) return;
    const form = new FormData(event.currentTarget);
    const date = String(form.get('date') || '');
    const title = String(form.get('title') || '').trim();
    const extracted = digitizationDraft.extracted;
    const duplicateResolution = String(form.get('duplicateResolution') || 'create_new') as
      | 'merge'
      | 'replace'
      | 'create_new';
    const matchedEventId = String(form.get('matchedEventId') || '');

    const rawEvent: HealthEvent = {
      id: `event_${crypto.randomUUID()}`,
      sourceFileId: digitizationDraft.source.id,
      sourceFileName: digitizationDraft.source.name,
      type: validEventType(String(form.get('type') || extracted.type)),
      title: title || 'Hồ sơ y tế mới',
      date: date || new Date().toISOString().slice(0, 10),
      facility: String(form.get('facility') || '').trim() || undefined,
      diagnoses: splitLines(String(form.get('diagnoses') || '')),
      medications: parseMedicationLines(String(form.get('medications') || '')),
      metrics: parseMetricLines(String(form.get('metrics') || '')),
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
    const nextEvent = cleanAndDeduplicateEventData(rawEvent);

    try {
      const existingMatch = matchedEventId
        ? effectiveProfile.timeline.find((item) => item.id === matchedEventId)
        : null;

      if (duplicateResolution === 'merge' && existingMatch) {
        // 1. Hợp nhất thông minh sự kiện cũ và mới (giữ lại chỉ số, thuốc, bổ sung cái mới)
        const mergedEvent = mergeHealthEvents(existingMatch, nextEvent);
        const updatedTimeline = effectiveProfile.timeline.map((item) =>
          item.id === matchedEventId ? mergedEvent : item
        );
        const updatedSources = effectiveProfile.sources.map((item) =>
          item.driveFileId === digitizationDraft.source.id
            ? { ...item, status: 'processed' as const, digitizedAt: new Date().toISOString() }
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
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: saved }));
        forgetOcrRecoveryJob(digitizationDraft.source.id);
        setSelectedMemberId(effectiveMember.id);
        setDigitizationDraft(null);
        setDigitizationError('');
        showToast(
          `Đã hợp nhất dữ liệu vào hồ sơ "${existingMatch.title}" của ${effectiveMember.name}.`,
          'success'
        );
        setActiveTab('timeline');
        processNextInQueue();
        return;
      } else if (duplicateResolution === 'replace' && existingMatch) {
        // 2. Ghi đè toàn bộ sự kiện cũ bằng dữ liệu mới nhất
        const replacedEvent: HealthEvent = { ...nextEvent, id: matchedEventId };
        const updatedTimeline = effectiveProfile.timeline.map((item) =>
          item.id === matchedEventId ? replacedEvent : item
        );
        const updatedSources = effectiveProfile.sources.map((item) =>
          item.driveFileId === digitizationDraft.source.id
            ? { ...item, status: 'processed' as const, digitizedAt: new Date().toISOString() }
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
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: saved }));
        forgetOcrRecoveryJob(digitizationDraft.source.id);
        setSelectedMemberId(effectiveMember.id);
        setDigitizationDraft(null);
        setDigitizationError('');
        showToast(
          `Đã cập nhật ghi đè hồ sơ "${existingMatch.title}" của ${effectiveMember.name}.`,
          'success'
        );
        setActiveTab('timeline');
        processNextInQueue();
        return;
      } else {
        // 3. Tạo sự kiện mới độc lập
        const nextProfile = digitizeHealthSource(effectiveProfile, nextEvent);
        const merged = await saveHealthProfile(effectiveMember.profileFileId, nextProfile);
        setProfiles((prev) => ({ ...prev, [effectiveMember.id]: merged }));
        forgetOcrRecoveryJob(digitizationDraft.source.id);
        setSelectedMemberId(effectiveMember.id);
        setDigitizationDraft(null);
        setDigitizationError('');
        showToast(`Đã lưu hồ sơ sức khỏe cho ${effectiveMember.name} lên Google Drive.`, 'success');
        setActiveTab('timeline');
        processNextInQueue();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu hồ sơ.', 'error');
    }
  }

  async function handleAskAssistant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember || !selectedProfile || !chatInput.trim()) return;
    const question = chatInput.trim();
    const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', text: question, timestamp: timeStr }]);
    setIsChatting(true);
    try {
      const answer = await askHealthAssistant(question, selectedMember, selectedProfile);
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: answer,
          timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text:
            error instanceof Error
              ? error.message
              : 'Không thể kết nối trợ lý AI lúc này. Vui lòng thử lại.',
          timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsChatting(false);
    }
  }

  async function handleAiSummary() {
    if (!selectedMember || !selectedProfile) return;
    setIsSummarizing(true);
    try {
      const narrative = await summarizeHealthProfile(selectedMember, selectedProfile);
      const deepRes = await analyzeComprehensiveHealth(selectedMember, selectedProfile);
      const updated: HealthProfile = {
        ...selectedProfile,
        summary: { ...selectedProfile.summary, narrative },
        aiDeepAnalysis: deepRes.result,
        aiAnalysis: deepRes.aiAnalysis,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveHealthProfile(selectedMember.profileFileId, updated);
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: saved }));
      showToast('Đã phân tích 4 lớp y khoa chuyên sâu bằng Gemini AI!', 'success');
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Không thể tạo tổng kết bệnh án.',
        'error'
      );
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

      const updatedProfile: HealthProfile = {
        ...selectedProfile,
        timeline: organizedTimeline,
        summary: summarizeTimeline(organizedTimeline, selectedProfile.summary.narrative),
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveHealthProfile(selectedMember.profileFileId, updatedProfile);
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: saved }));
      showToast('Đã chuẩn hóa danh pháp y khoa thành công! Đang chạy phân tích 4 lớp y khoa...', 'success');
      void handleAiSummary();
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
          .map((a) => [a.memberEmail, a.role])
      );
      assignments.set(email, inviteRole);
      await publishHealthWorkspaceAssignments(
        workspace.rootFolderId,
        workspace.familyFileId,
        userEmail,
        [...assignments].map(([memberEmail, role]) => ({ email: memberEmail, role }))
      );
      setInviteEmail('');
      await reloadWorkspaceAssignments();
      showToast(
        'Đã gửi lời mời Workspace. Hãy chia sẻ thư mục Drive với email này để cấp quyền tệp.',
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
      await removeHealthWorkspaceAssignment(workspace.rootFolderId, memberEmail);
      await reloadWorkspaceAssignments();
      showToast('Đã thu hồi quyền chia sẻ.', 'success');
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Không thể thu hồi quyền chia sẻ.'
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {/* 1. TOP BAR CONTRACT: One row, clean zones, thumb-friendly safe area */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200/80 safe-area-header shadow-xs">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 py-2 flex items-center justify-between gap-2">
          {/* Zone 1: Brand Wordmark & Logo */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <AppLogo size="sm" />
            <div className="min-w-0">
              <span className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 truncate block">
                Sức Khỏe Gia Đình
              </span>
              <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    driveAuthorized ? 'bg-emerald-500' : 'bg-amber-400'
                  }`}
                />
                <span className="truncate">
                  {driveAuthorized ? 'Drive đã kết nối' : 'Chưa cấp quyền'}
                </span>
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

                  <button
                    type="button"
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      setShowWorkspaceAuditModal(true);
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-teal-50 text-slate-700 hover:text-teal-900 transition-colors text-left text-xs font-semibold"
                  >
                    <FolderSync className="w-4 h-4 text-teal-600 shrink-0" />
                    <span>Kiểm tra thư mục Drive</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      void handleCleanupDriveDuplicates();
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-amber-50 text-slate-700 hover:text-amber-900 transition-colors text-left text-xs font-semibold"
                  >
                    <Trash2 className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>Dọn dẹp tệp trùng trên Drive</span>
                  </button>

                  <button
                    type="button"
                    disabled={isCheckingUpdate}
                    onClick={() => {
                      setShowSettingsDropdown(false);
                      void checkAppUpdate(true);
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-colors text-left text-xs font-semibold"
                  >
                    <div className="flex items-center gap-2.5">
                      <RefreshCw className={`w-4 h-4 text-slate-500 shrink-0 ${isCheckingUpdate ? 'animate-spin text-emerald-600' : ''}`} />
                      <span>Kiểm tra cập nhật</span>
                    </div>
                    <span className="text-[10px] text-slate-400 font-mono">v{appVersion}</span>
                  </button>

                  <div className="pt-1 border-t border-slate-100">
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
                        <span>Đăng xuất</span>
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
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-4 sm:py-6 pb-28">
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
            className="mb-4 flex flex-col gap-2 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="text-sm">
              <p className="font-bold">Chưa tải được hồ sơ của {selectedMember.name}</p>
              <p className="mt-1 text-xs">{profileErrors[selectedMember.id]}</p>
              <p className="mt-1 text-xs">Để tránh ghi đè nhầm bằng hồ sơ rỗng, thao tác số hóa và AI đang bị khóa.</p>
            </div>
            <button
              type="button"
              disabled={isLoading || !workspace}
              onClick={() => workspace && void reloadProfiles(workspace)}
              className="shrink-0 rounded-xl bg-amber-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              Tải lại hồ sơ
            </button>
          </div>
        )}

        {/* Setup Screen if no workspace is opened */}
        {!workspace ? (
          <div className="max-w-xl mx-auto my-6 bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 shadow-sm">
            <div className="text-center mb-6">
              <AppLogo size="xl" className="justify-center mb-4" />
              <h2 className="text-2xl font-black tracking-tight text-slate-900">
                Sức Khỏe Gia Đình
              </h2>
              <p className="mt-2 text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
                Nơi lưu trữ hồ sơ y tế, đơn thuốc, kết quả xét nghiệm an toàn và riêng tư tuyệt đối
                trực tiếp trên Google Drive của chính gia đình bạn.
              </p>
            </div>

            {!driveAuthorized ? (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-950 text-xs leading-relaxed space-y-2">
                  <div className="flex items-center gap-2 font-bold text-emerald-900">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    <span>Quyền riêng tư tuyệt đối</span>
                  </div>
                  <p>
                    Dữ liệu y tế của bạn được mã hóa và lưu trữ trực tiếp trên tài khoản Google Drive cá nhân. Không máy chủ trung gian nào lưu giữ bệnh án của bạn.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onConnectDrive}
                  className="w-full flex items-center justify-center gap-2.5 py-3.5 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-sm shadow-md shadow-emerald-600/20 transition-all"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Đăng nhập Google & Cấp quyền Drive</span>
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-950 text-xs flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-emerald-900">
                      Đăng nhập Quản trị viên (Admin): <span className="font-semibold text-emerald-700">{userEmail}</span>
                    </p>
                    <p className="text-[11px] text-emerald-800 mt-1 leading-relaxed">
                      Chưa phát hiện thư mục gia đình được chia sẻ trước đó. Bạn có thể nhấn nút dưới đây để khởi tạo không gian lưu trữ y tế gia đình mới trên Google Drive của mình.
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
              <div className="space-y-6 animate-in fade-in duration-150">
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
                              Hẹn ngày: {item.followUpDate}
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

                {/* Family Members Health Cards Grid */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                      <Users className="w-4 h-4 text-emerald-600" />
                      <span>Hồ sơ người thân</span>
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
                    <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center">
                      <Users className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      <p className="font-bold text-slate-700">Chưa có hồ sơ thành viên nào</p>
                      <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                        Thêm thành viên trong gia đình để bắt đầu theo dõi và đồng bộ hồ sơ sức khỏe.
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveTab('family')}
                        className="mt-4 px-4 py-2 rounded-xl bg-emerald-600 text-white font-bold text-xs"
                      >
                        Thêm thành viên ngay
                      </button>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {members.map((m) => {
                        const prof = profiles[m.id];
                        const eventCount = prof?.timeline?.length || 0;
                        const isChosen = m.id === selectedMember?.id;
                        const genderLabel = m.gender === 'male' ? 'Nam' : m.gender === 'female' ? 'Nữ' : m.gender === 'other' ? 'Khác' : '';
                        const birthDateStr = m.birthDate ? new Date(m.birthDate).toLocaleDateString('vi-VN') : '';
                        const subInfo = [genderLabel, birthDateStr ? `Sinh ${birthDateStr}` : ''].filter(Boolean).join(' · ');

                        return (
                          <div
                            key={m.id}
                            onClick={() => {
                              setSelectedMemberId(m.id);
                              setActiveTab('timeline');
                            }}
                            className={`group cursor-pointer rounded-2xl p-4 border transition-all text-left bg-white ${
                              isChosen
                                ? 'border-emerald-500 ring-2 ring-emerald-500/20 shadow-md'
                                : 'border-slate-200/80 hover:border-emerald-300 hover:shadow-md'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-11 h-11 rounded-2xl bg-emerald-100/80 text-emerald-800 flex items-center justify-center font-black text-base shrink-0 group-hover:scale-105 transition-transform">
                                  {m.name.charAt(0)}
                                </div>
                                <div className="min-w-0">
                                  <h4 className="font-extrabold text-slate-900 text-sm truncate">
                                    {m.name}
                                  </h4>
                                  <span className="text-xs text-slate-500">
                                    {subInfo || 'Thành viên'}
                                  </span>
                                </div>
                              </div>
                              <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-mono text-xs font-semibold tabular-nums">
                                {eventCount} sự kiện
                              </span>
                            </div>

                            {/* Status or Latest Diagnosis */}
                            <div className="mt-3 pt-3 border-t border-slate-100 text-xs">
                              {prof?.summary?.latestEventDate ? (
                                <>
                                  <div className="text-[11px] text-slate-400">
                                    Khám gần nhất: {prof.summary.latestEventDate}
                                  </div>
                                  <p className="mt-1 font-medium text-slate-700 line-clamp-2">
                                    {prof.summary.latestDiagnoses.length > 0
                                      ? prof.summary.latestDiagnoses.join(', ')
                                      : prof.summary.narrative || 'Đã ghi nhận dữ liệu.'}
                                  </p>
                                </>
                              ) : (
                                <p className="text-slate-400 italic">
                                  Chưa có hồ sơ khám bệnh nào
                                </p>
                              )}
                            </div>

                            <div className="mt-3 flex items-center justify-between text-xs text-emerald-600 font-bold group-hover:text-emerald-700 pt-1">
                              <span>Xem chi tiết dòng thời gian</span>
                              <ChevronDown className="w-3.5 h-3.5 -rotate-90 group-hover:translate-x-0.5 transition-transform" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* AI Assistant Quick Callout banner */}
                <div className="rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 via-teal-50 to-white p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                      <Sparkles className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-extrabold text-slate-900 text-sm">
                        Trợ lý Y Tế AI
                      </h4>
                      <p className="text-xs text-slate-600 mt-0.5 max-w-lg">
                        Tra cứu nhanh lịch sử tiêm phòng, theo dõi dao động huyết áp, tra toa thuốc cũ chỉ bằng ngôn ngữ tự nhiên.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('assistant')}
                    className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shrink-0 active:scale-95 transition-all"
                  >
                    Mở cuộc trò chuyện
                  </button>
                </div>
              </div>
            )}

            {/* VIEW 2: HỒ SƠ Y TẾ (TIMELINE & VITALS) */}
            {activeTab === 'timeline' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* Active Member Bar & Action CTAs */}
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
                            selectedMember.birthDate ? `Sinh ${selectedMember.birthDate}` : '',
                          ].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleCameraCapture}
                      disabled={!driveAuthorized || isUploading}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition-all disabled:opacity-50 shadow-xs active:scale-[0.98]"
                    >
                      <Camera className="w-4 h-4" />
                      <span>Chụp ảnh khám bệnh</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!driveAuthorized || isUploading}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition-all disabled:opacity-50 active:scale-[0.98]"
                    >
                      <FileUp className="w-4 h-4 text-emerald-600" />
                      <span>Tải lên (PDF/Ảnh)</span>
                    </button>
                  </div>
                </div>

                {/* AI 4-Layer Medical Deep-Dive Engine & Summary */}
                <AiDeepAnalysisCard
                  analysis={selectedProfile?.aiDeepAnalysis}
                  aiAnalysis={selectedProfile?.aiAnalysis}
                  medicalHistory={selectedProfile?.medicalHistory}
                  narrativeSummary={selectedProfile?.summary.narrative}
                  isAnalyzing={isSummarizing}
                  onRefresh={() => void handleAiSummary()}
                  onRefine={() => void handleRefineAndOrganize()}
                  isRefining={isRefining}
                />

                {/* Vital Metrics Trend Chart */}
                {metricNames.length > 0 && (
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                      <div>
                        <h4 className="font-extrabold text-slate-900 text-sm flex items-center gap-2">
                          <Activity className="w-4 h-4 text-teal-600" />
                          <span>Diễn biến chỉ số sức khỏe</span>
                        </h4>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Theo dõi biểu đồ thay đổi qua từng đợt khám bệnh
                        </p>
                      </div>

                      {/* Metric Selector Tabs */}
                      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar max-w-full">
                        {metricNames.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => setSelectedMetric(name)}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
                              selectedMetric === name
                                ? 'bg-slate-900 text-white shadow-xs'
                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                            }`}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    </div>

                    {chartData.length > 1 ? (
                      <div className="h-56 w-full pt-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart
                            data={chartData}
                            margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                          >
                            <defs>
                              <linearGradient id="colorMetric" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
                                <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                            <XAxis
                              dataKey="date"
                              tick={{ fontSize: 11, fill: '#64748b' }}
                              stroke="#cbd5e1"
                            />
                            <YAxis
                              tick={{ fontSize: 11, fill: '#64748b' }}
                              stroke="#cbd5e1"
                              domain={['auto', 'auto']}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#0f172a',
                                borderRadius: '12px',
                                color: '#fff',
                                border: 'none',
                                fontSize: '12px',
                                boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)',
                              }}
                              formatter={(value: any) => [
                                `${value} ${chartData[0]?.unit || ''}`,
                                selectedMetric,
                              ]}
                            />
                            <Area
                              type="monotone"
                              dataKey="value"
                              stroke="#059669"
                              strokeWidth={3}
                              fillOpacity={1}
                              fill="url(#colorMetric)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <div className="p-6 text-center text-xs text-slate-500 bg-slate-50 rounded-xl">
                        Cần ghi nhận ít nhất 2 mốc thời gian để vẽ biểu đồ diễn biến {selectedMetric}.
                      </div>
                    )}
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
                      <img
                        src="/src/assets/images/empty_health_records_1793695802950.jpg"
                        alt="Chưa có dữ liệu"
                        className="w-40 h-32 object-cover rounded-2xl mx-auto mb-3 opacity-90"
                      />
                      <h4 className="font-extrabold text-slate-800 text-base">
                        Chưa có sự kiện y tế nào
                      </h4>
                      <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                        Chụp ảnh sổ khám bệnh, đơn thuốc hoặc kết quả xét nghiệm để AI tự động trích xuất và lưu trữ.
                      </p>
                      <button
                        type="button"
                        onClick={handleCameraCapture}
                        className="mt-4 px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-bold text-xs"
                      >
                        Chụp tài liệu ngay
                      </button>
                    </div>
                  ) : (
                    filteredTimeline.map((event) => {
                      const opt =
                        EVENT_TYPE_OPTIONS.find((t) => t.value === event.type) ||
                        EVENT_TYPE_OPTIONS[5];
                      const IconComp = opt.icon;

                      return (
                        <div
                          key={event.id}
                          className="bg-white border border-slate-200/80 rounded-2xl p-4 sm:p-5 shadow-xs hover:border-emerald-300 transition-all space-y-3"
                        >
                          {/* Event Header */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3">
                              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                                <IconComp className="w-5 h-5" />
                              </div>
                              <div>
                                <div className="flex items-center gap-2 text-xs text-slate-500">
                                  <span className="font-bold text-emerald-800">{opt.label}</span>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">{event.date}</span>
                                </div>
                                <h4 className="text-base font-extrabold text-slate-900 mt-0.5">
                                  {event.title}
                                </h4>
                                {event.facility && (
                                  <p className="text-xs text-slate-600 flex items-center gap-1 mt-0.5">
                                    <Stethoscope className="w-3.5 h-3.5 text-slate-400" />
                                    <span>{event.facility}</span>
                                  </p>
                                )}
                              </div>
                            </div>

                            {/* View original file on Drive */}
                            {event.sourceFileId && (
                              <a
                                href={`https://drive.google.com/file/d/${encodeURIComponent(
                                  event.sourceFileId
                                )}/view`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-600 shrink-0"
                                title="Xem tệp gốc trên Google Drive"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Tài liệu gốc</span>
                              </a>
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
                                    className="p-2 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs"
                                  >
                                    <div className="font-bold text-slate-900">{med.name}</div>
                                    <div className="text-slate-500 text-[11px]">
                                      {[med.dosage, med.frequency, med.duration]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Metrics chips */}
                          {event.metrics.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mr-1">
                                Chỉ số đo:
                              </span>
                              {event.metrics.map((met, idx) => (
                                <span
                                  key={idx}
                                  className={`px-2.5 py-1 rounded-lg border text-xs font-semibold tabular-nums ${
                                    met.status === 'critical_high' || met.status === 'critical_low'
                                      ? 'bg-rose-50 border-rose-200 text-rose-900 font-bold'
                                      : 'bg-teal-50 border-teal-200 text-teal-900'
                                  }`}
                                >
                                  {met.name}: <strong>{met.value}</strong> {met.unit}
                                </span>
                              ))}
                            </div>
                          )}

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
              <div className="max-w-2xl mx-auto space-y-4 animate-in fade-in duration-150">
                {/* Assistant Info Banner */}
                <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shrink-0 shadow-sm">
                      <Bot className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-extrabold text-slate-900 text-sm">
                        Trợ lý Y Tế Gia Đình AI
                      </h3>
                      <p className="text-xs text-slate-500">
                        Đang tra cứu hồ sơ của: <strong>{selectedMember?.name}</strong> (
                        {selectedProfile?.timeline.length || 0} hồ sơ đã ghi nhận)
                      </p>
                    </div>
                  </div>
                </div>

                {/* Quick Prompts */}
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 text-xs">
                  {[
                    'Lần gần nhất khám ở đâu và có chẩn đoán gì?',
                    'Các loại thuốc đang uống theo đơn gần đây?',
                    'Chỉ số huyết áp dao động thế nào?',
                    'Có lịch hẹn tái khám nào sắp tới không?',
                  ].map((promptText, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setChatInput(promptText)}
                      className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-emerald-50 hover:border-emerald-300 text-slate-700 font-medium whitespace-nowrap active:scale-95 transition-all text-xs"
                    >
                      {promptText}
                    </button>
                  ))}
                </div>

                {/* Chat Container */}
                <div className="bg-white rounded-3xl border border-slate-200/80 shadow-xs flex flex-col h-[520px] overflow-hidden">
                  <div
                    tabIndex={0}
                    aria-live="polite"
                    aria-label="Lịch sử trò chuyện với trợ lý y tế"
                    className="flex-1 overflow-y-auto p-4 space-y-3.5 focus:outline-none"
                  >
                    {chatMessages.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                        <Sparkles className="w-10 h-10 text-emerald-400 mb-2 animate-bounce" />
                        <p className="font-bold text-slate-700 text-sm">
                          Hỏi bất kỳ điều gì về hồ sơ sức khỏe
                        </p>
                        <p className="text-xs text-slate-500 max-w-sm mt-1 leading-relaxed">
                          AI sẽ tự động đọc lại các đơn thuốc, kết quả xét nghiệm đã lưu trên Drive để trả lời chuẩn xác cho bạn.
                        </p>
                      </div>
                    ) : (
                      chatMessages.map((msg, index) => (
                        <div
                          key={index}
                          className={`flex flex-col max-w-[85%] ${
                            msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'
                          }`}
                        >
                          <div
                            className={`p-3.5 rounded-2xl text-xs sm:text-sm leading-relaxed whitespace-pre-wrap ${
                              msg.role === 'user'
                                ? 'bg-emerald-600 text-white rounded-br-xs'
                                : 'bg-slate-100 text-slate-800 rounded-bl-xs border border-slate-200/60'
                            }`}
                          >
                            {msg.text}
                          </div>
                          {msg.timestamp && (
                            <span className="text-[10px] text-slate-400 mt-1 px-1">
                              {msg.timestamp}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                    {isChatting && (
                      <div className="flex items-center gap-2 text-slate-400 text-xs p-2">
                        <LoaderCircle className="w-4 h-4 animate-spin text-emerald-600" />
                        <span>Trợ lý đang đọc hồ sơ và tổng hợp câu trả lời...</span>
                      </div>
                    )}
                  </div>

                  {/* Chat Input Bar */}
                  <form
                    onSubmit={(e) => void handleAskAssistant(e)}
                    className="p-3 border-t border-slate-100 bg-slate-50 flex items-center gap-2"
                  >
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={`Hỏi về hồ sơ sức khỏe của ${selectedMember?.name}...`}
                      disabled={isChatting}
                      className="flex-1 px-4 py-2.5 rounded-2xl border border-slate-200 bg-white text-xs sm:text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                    />
                    <button
                      type="submit"
                      disabled={isChatting || !chatInput.trim()}
                      className="w-10 h-10 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white flex items-center justify-center shrink-0 shadow-sm transition-all disabled:opacity-40"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* VIEW 4: GIA ĐÌNH & CÀI ĐẶT (FAMILY & WORKSPACE) */}
            {activeTab === 'family' && (
              <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] animate-in fade-in duration-150">
                {/* Column 1: Member Management */}
                <div className="space-y-4">
                  <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs">
                    <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2 mb-3">
                      <Users className="w-4 h-4 text-emerald-600" />
                      <span>Thành viên gia đình ({members.length})</span>
                    </h3>

                    <div className="divide-y divide-slate-100">
                      {members.map((m) => {
                        const prof = profiles[m.id];
                        const genderLabel = m.gender === 'male' ? 'Nam' : m.gender === 'female' ? 'Nữ' : m.gender === 'other' ? 'Khác' : '';
                        const birthDateStr = m.birthDate ? new Date(m.birthDate).toLocaleDateString('vi-VN') : '';
                        const age = m.birthDate ? Math.max(0, new Date().getFullYear() - new Date(m.birthDate).getFullYear()) : null;
                        const subInfo = [
                          genderLabel,
                          birthDateStr ? `Sinh ${birthDateStr}${age !== null ? ` (${age} tuổi)` : ''}` : '',
                          `${prof?.timeline?.length || 0} hồ sơ`,
                        ].filter(Boolean).join(' · ');

                        return (
                          <div
                            key={m.id}
                            className="py-3 flex items-center justify-between gap-3 text-xs"
                          >
                            <div className="flex items-center gap-3">
                              <span className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center text-sm">
                                {m.name.charAt(0)}
                              </span>
                              <div>
                                <p className="font-bold text-slate-900 text-sm">{m.name}</p>
                                <p className="text-slate-500">
                                  {subInfo}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedMemberId(m.id);
                                  setActiveTab('timeline');
                                }}
                                className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 font-bold text-xs"
                              >
                                Mở hồ sơ
                              </button>
                              {driveAuthorized && (
                                <button
                                  type="button"
                                  disabled={isLoading}
                                  onClick={() => void handleDeleteFamilyMember(m)}
                                  aria-label={`Xóa vĩnh viễn hồ sơ của ${m.name}`}
                                  title="Xóa vĩnh viễn thành viên và dữ liệu Drive"
                                  className="p-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
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
                    {isWorkspaceAdmin && (
                      <form
                        onSubmit={(e) => void handleAddMember(e)}
                        className="mt-4 pt-4 border-t border-slate-100 space-y-3"
                      >
                        <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wide">
                          Thêm thành viên mới
                        </h4>
                        <div className="grid gap-2.5 sm:grid-cols-3">
                          <div>
                            <label className="block text-[11px] font-bold text-slate-600 mb-1">
                              Họ và tên *
                            </label>
                            <input
                              type="text"
                              required
                              value={newMemberName}
                              onChange={(e) => setNewMemberName(e.target.value)}
                              placeholder="Họ và tên..."
                              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-bold text-slate-600 mb-1">
                              Ngày tháng năm sinh
                            </label>
                            <input
                              type="date"
                              value={newMemberBirthDate}
                              onChange={(e) => setNewMemberBirthDate(e.target.value)}
                              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900 bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-bold text-slate-600 mb-1">
                              Giới tính
                            </label>
                            <select
                              value={newMemberGender}
                              onChange={(e) =>
                                setNewMemberGender(e.target.value as 'male' | 'female' | 'other')
                              }
                              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs sm:text-sm text-slate-900 bg-white font-medium"
                            >
                              <option value="male">Nam</option>
                              <option value="female">Nữ</option>
                              <option value="other">Khác</option>
                            </select>
                          </div>
                        </div>
                        <button
                          type="submit"
                          disabled={isAddingMember || !newMemberName.trim()}
                          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs active:scale-[0.98] transition-all disabled:opacity-50"
                        >
                          {isAddingMember ? (
                            <LoaderCircle className="w-4 h-4 animate-spin" />
                          ) : (
                            <UserPlus className="w-4 h-4" />
                          )}
                          <span>Tạo hồ sơ thành viên trên Drive</span>
                        </button>
                      </form>
                    )}
                  </div>
                </div>

                {/* Column 2: Google Drive Workspace & Sharing */}
                <div className="space-y-4">
                  {/* Drive Folder ID info */}
                  <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cloud className="w-4 h-4 text-emerald-600" />
                        <h4 className="font-extrabold text-slate-900 text-sm">
                          Thư mục Google Drive
                        </h4>
                      </div>
                      <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                        Đang kết nối
                      </span>
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed">
                      Mã định danh thư mục gốc (Root Folder ID) dùng để chia sẻ quyền truy cập cho người thân trong gia đình:
                    </p>

                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200 font-mono text-xs text-slate-700 break-all">
                      <span className="flex-1 truncate">{workspace.rootFolderId}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(workspace.rootFolderId)
                            .then(() => showToast('Đã sao chép mã thư mục.', 'success'))
                        }
                        className="p-1.5 rounded-lg hover:bg-white text-slate-500 hover:text-slate-800 shrink-0"
                        title="Sao chép"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>

                    {/* 3-Year Retention Policy notice */}
                    <div className="p-3 rounded-2xl bg-slate-50 border border-slate-100 text-[11px] text-slate-600 space-y-1">
                      <div className="flex items-center gap-1.5 font-bold text-slate-800">
                        <Info className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Chính sách lưu trữ thông minh:</span>
                      </div>
                      <p>
                        Các tệp ảnh chụp/PDF gốc đã được số hóa sẽ được dọn dẹp tự động sau 3 năm để tiết kiệm dung lượng Google Drive. Toàn bộ chỉ số, đơn thuốc và lịch sử bệnh án số hóa vẫn được lưu trữ vĩnh viễn trong tệp JSON hồ sơ.
                      </p>
                    </div>
                  </div>

                  {/* Share Workspace with family members */}
                  {isWorkspaceAdmin && (
                    <div className="rounded-3xl border border-slate-200/80 bg-white p-5 shadow-xs space-y-3">
                      <div className="flex items-center gap-2">
                        <Share2 className="w-4 h-4 text-teal-600" />
                        <h4 className="font-extrabold text-slate-900 text-sm">
                          Chia sẻ quyền truy cập cho người thân
                        </h4>
                      </div>

                      <p className="text-xs text-slate-600 leading-relaxed">
                        Nhập email Google của người thân để liên kết nhanh:
                      </p>

                      <form
                        onSubmit={(e) => void handleInviteWorkspaceMember(e)}
                        className="space-y-2"
                      >
                        <div className="flex gap-2">
                          <input
                            type="email"
                            required
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder="email.nguoi.than@gmail.com"
                            className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-xs"
                          />
                          <select
                            value={inviteRole}
                            onChange={(e) =>
                              setInviteRole(e.target.value as WorkspaceAccessRole)
                            }
                            className="px-2.5 py-2 rounded-xl border border-slate-200 text-xs bg-white"
                          >
                            <option value="EDITOR">Editor</option>
                            <option value="VIEWER">Viewer</option>
                          </select>
                        </div>
                        <button
                          type="submit"
                          disabled={isLoading || !inviteEmail.trim()}
                          className="w-full py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs active:scale-[0.98] transition-all disabled:opacity-50"
                        >
                          Gửi liên kết chia sẻ
                        </button>
                      </form>

                      {workspaceAssignments.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">
                            Đã chia sẻ ({workspaceAssignments.length})
                          </span>
                          <div className="divide-y divide-slate-100">
                            {workspaceAssignments.map((a) => (
                              <div
                                key={a.memberEmail}
                                className="py-2 flex items-center justify-between gap-2 text-xs"
                              >
                                <span className="truncate text-slate-700">
                                  {a.memberEmail} · <strong>{a.role}</strong>
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void handleRevokeWorkspaceMember(a.memberEmail)}
                                  className="text-rose-600 hover:text-rose-700 font-bold"
                                >
                                  Thu hồi
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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
            if (files.length === 1) {
              uploadQueueRef.current = [];
              setUploadQueue([]);
              setQueueStatus({ current: 1, total: 1 });
              showToast(`Đang tự động xử lý tệp tài liệu y tế "${files[0].name}"...`, 'info');
              void beginDigitization(files[0]);
            } else {
              const remaining = files.slice(1);
              uploadQueueRef.current = remaining;
              setUploadQueue(remaining);
              setQueueStatus({ current: 1, total: files.length });
              showToast(`Đã chọn ${files.length} tệp. Đang xử lý tệp 1/${files.length} (${files[0].name})...`, 'info');
              void beginDigitization(files[0]);
            }
            event.currentTarget.value = '';
          }}
        />

        {queueStatus && (
          <div className="fixed bottom-24 left-4 right-4 z-40 max-w-lg mx-auto bg-slate-900 shadow-2xl rounded-3xl border border-slate-700/50 overflow-hidden animate-in slide-in-from-bottom-4">
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-500/20">
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  </div>
                  <div className="min-w-0">
                    <span className="font-black text-sm text-white block">
                      Đang xử lý hàng đợi y tế ({queueStatus.current}/{queueStatus.total})
                    </span>
                    <span className="text-[11px] text-slate-400 truncate block">
                      {uploadQueue.length > 0 ? `Tiếp theo: ${uploadQueue[0].name}` : 'Đang xử lý tệp cuối cùng...'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    uploadQueueRef.current = [];
                    setUploadQueue([]);
                    setQueueStatus(null);
                    showToast('Đã hủy hàng đợi tải lên.', 'info');
                  }}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-rose-900/40 text-slate-400 hover:text-rose-400 font-bold text-xs transition-colors"
                >
                  Dừng xử lý
                </button>
              </div>

              {/* Enhanced Progress Bar for the entire Queue */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-500 px-0.5">
                  <span>Tiến độ tổng quát</span>
                  <span>{Math.round((queueStatus.current / queueStatus.total) * 100)}%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex gap-0.5 p-0.5">
                  {Array.from({ length: queueStatus.total }).map((_, i) => (
                    <div
                      key={i}
                      className={`h-full flex-1 rounded-full transition-all duration-500 ${
                        i < queueStatus.current - 1
                          ? 'bg-emerald-500'
                          : i === queueStatus.current - 1
                          ? 'bg-emerald-400 animate-pulse'
                          : 'bg-slate-700'
                      }`}
                    />
                  ))}
                </div>
              </div>
            </div>
            
            <div className="bg-slate-950/50 px-4 py-2 border-t border-slate-800/50">
              <p className="text-[10px] text-slate-500 italic text-center">
                AI xử lý tự động; kết quả sẽ xuất hiện trong Dòng thời gian sau khi hoàn tất.
              </p>
            </div>
          </div>
        )}
        {!trackerState.isOpen && ocrRecoveryJobs.some((job) => job.status !== 'processing') && (
          <div
            className={`fixed ${queueStatus ? 'bottom-40' : 'bottom-20'} left-4 right-4 z-40 max-w-md mx-auto rounded-2xl border border-amber-200 bg-amber-50/95 p-3 shadow-xl`}
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-bold text-amber-900">
              <AlertCircle className="h-4 w-4" />
              Có tài liệu OCR cần tiếp tục ({ocrRecoveryJobs.filter((job) => job.status !== 'processing').length})
            </div>
            <div className="max-h-36 space-y-2 overflow-y-auto">
              {ocrRecoveryJobs.filter((job) => job.status !== 'processing').map((job) => {
                const member = members.find((candidate) =>
                  profiles[candidate.id]?.sources.some((source) => source.driveFileId === job.driveFileId),
                );
                return (
                  <div key={job.driveFileId} className="flex items-center justify-between gap-2 rounded-xl bg-white/80 p-2">
                    <div className="min-w-0">
                      <span className="block truncate text-[11px] font-semibold text-slate-800">
                        {member ? `Hồ sơ ${member.name}` : 'Tài liệu trong Google Drive'}
                      </span>
                      <span className="block text-[10px] text-slate-500">
                        Tiến độ trước đó {job.progressPercent}%. Kết quả OCR không lưu trên thiết bị; chạy lại từ Drive để tiếp tục.
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={!member || isUploading}
                        onClick={() => void resumeInterruptedOcr(job)}
                        className="rounded-lg bg-emerald-700 px-2.5 py-1.5 text-[10px] font-bold text-white disabled:opacity-50"
                      >
                        Chạy lại OCR
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
            <p className="mt-2 text-[9px] text-amber-800">
              Chỉ trạng thái và ID tệp được lưu cục bộ; không lưu nội dung PDF, kết quả y tế hay API key.
            </p>
          </div>
        )}
      </main>

      {/* 2. FIXED BOTTOM TAB BAR (Thumb navigation, Mobile Pattern 1) */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200/90 safe-area-bottom shadow-lg">
        <div className="max-w-md mx-auto grid grid-cols-4 items-center h-16 px-2">
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

      {/* Floating Action Menu (Mobile FAB for Scan/Upload) */}
      {workspace && (
        <div className="fixed bottom-20 right-4 sm:right-8 z-30">
          <button
            type="button"
            onClick={() => setShowQuickActionModal(true)}
            className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-lg shadow-emerald-600/30 active:scale-95 transition-transform"
            aria-label="Thêm hồ sơ mới"
          >
            <Plus className="w-6 h-6 stroke-[2.5]" />
          </button>
        </div>
      )}

      {/* Quick Action Sheet Modal */}
      {showQuickActionModal && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-3 animate-in fade-in duration-150"
          onClick={() => setShowQuickActionModal(false)}
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
                  void handleCameraCapture();
                }}
                className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-emerald-50 hover:bg-emerald-100 text-emerald-950 font-bold text-xs transition-all text-left"
              >
                <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-extrabold">Chụp ảnh bằng Camera</div>
                  <div className="text-[11px] text-emerald-700 font-normal">
                    Chụp trực tiếp sổ khám, hóa đơn, kết quả xét nghiệm
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowQuickActionModal(false);
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
                    Chọn tệp tài liệu y tế sẵn có từ máy
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
          members={members}
          step={trackerState.step}
          progressPercent={trackerState.progressPercent}
          progressMessage={trackerState.progressMessage}
          driveFile={trackerState.driveFile}
          modelUsed={trackerState.modelUsed}
          partialExtracted={trackerState.partialExtracted}
          error={trackerState.error}
          detectedMemberMatch={trackerState.detectedMemberMatch}
          isRoutingDecisionRequired={trackerState.isRoutingDecisionRequired}
          onReview={() => {
            if (trackerState.driveFile) {
              setDigitizationDraft({
                source: trackerState.driveFile,
                extracted: trackerState.partialExtracted,
              });
            }
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
          }}
          onSaveToDetected={async () => {
            if (trackerState.detectedMemberMatch && trackerState.driveFile) {
              const matched = trackerState.detectedMemberMatch;
              const file = trackerState.file!;
              const driveFileId = trackerState.driveFile.id;
              
              setTrackerState(prev => ({
                ...prev,
                progressMessage: `Đang chuyển hồ sơ sang: ${matched.name}...`,
                progressPercent: 92,
                step: 'matching_patient'
              }));
              
              try {
                await autoCommitAndRefineDigitization(trackerState.partialExtracted, file, matched, driveFileId);
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Lỗi khi chuyển hồ sơ.', 'error');
                processNextInQueue();
              }
            } else {
              processNextInQueue();
            }
          }}
          onCreateNewMember={async () => {
            if (!workspace || !trackerState.partialExtracted.patientName || !trackerState.driveFile) {
              setTrackerState(prev => ({ ...prev, isOpen: false }));
              processNextInQueue();
              return;
            }
            const name = trackerState.partialExtracted.patientName;
            const birthDate = trackerState.partialExtracted.patientBirthDate;
            const genderRaw = trackerState.partialExtracted.patientGender as any;
            const gender = (genderRaw === 'Nam' || genderRaw === 'male') ? 'male' : (genderRaw === 'Nữ' || genderRaw === 'female') ? 'female' : 'other';
            const file = trackerState.file!;
            const driveFileId = trackerState.driveFile.id;

            setTrackerState(prev => ({
              ...prev,
              progressMessage: `Đang khởi tạo hồ sơ cho: ${name}...`,
              progressPercent: 92,
              step: 'matching_patient'
            }));
            
            try {
              const currentMemberId = trackerState.memberId;
              const currentMember = members.find(m => m.id === currentMemberId);
              const currentProfile = currentMember ? profiles[currentMember.id] : null;
              
              let targetMember: FamilyMember | null = null;
              let freshProfiles: Record<string, HealthProfile> | undefined;

              // Tối ưu: Nếu thành viên hiện tại chỉ là placeholder vừa tạo (chưa có sự kiện nào)
              // thì cập nhật thông tin luôn cho mượt, tránh tạo người thứ 2 dư thừa
              if (currentMember && currentProfile && currentProfile.timeline.length <= 0 && members.length === 1) {
                const next = await updateDriveFamilyMember(workspace, currentMember.id, {
                  name: name.trim(),
                  birthDate: birthDate || undefined,
                  gender,
                });
                workspaceRef.current = next;
                setWorkspace(next);
                targetMember = next.family.members.find(m => m.id === currentMemberId) || null;
                freshProfiles = await reloadProfiles(next);
                if (freshProfiles) {
                  profilesRef.current = freshProfiles;
                }
                selectedMemberIdRef.current = currentMemberId;
                setSelectedMemberId(currentMemberId);
              } else {
                // Tạo người mới bình thường
                const memberId = `member_${crypto.randomUUID().slice(0, 12)}`;
                const next = await addDriveFamilyMember(workspace, {
                  id: memberId,
                  name: name.trim(),
                  birthDate: birthDate || undefined,
                  gender,
                  role: 'other',
                });
                workspaceRef.current = next;
                setWorkspace(next);
                targetMember = next.family.members.find(m => m.id === memberId) || null;
                freshProfiles = await reloadProfiles(next);
                if (freshProfiles) {
                  profilesRef.current = freshProfiles;
                }
                selectedMemberIdRef.current = memberId;
                setSelectedMemberId(memberId);
              }

              if (targetMember) {
                await autoCommitAndRefineDigitization(trackerState.partialExtracted, file, targetMember, driveFileId, freshProfiles);
              } else {
                throw new Error('Không thể xác định hồ sơ đích sau khi khởi tạo.');
              }
            } catch (err) {
              console.error('[Create New Member Error]:', err);
              showToast(err instanceof Error ? err.message : 'Không thể xử lý hồ sơ mới.', 'error');
              setTrackerState(prev => ({ ...prev, isOpen: false }));
              processNextInQueue();
            }
          }}
          onRetry={() => {
            void retryDigitization();
          }}
          onManualEntry={() => {
            if (trackerState.driveFile) {
              setDigitizationDraft({
                source: trackerState.driveFile,
                extracted: trackerState.partialExtracted,
              });
            }
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
          }}
          onClose={() => {
            if (trackerState.step !== 'completed' && trackerState.step !== 'error') {
              showToast('Tài liệu vẫn đang được xử lý. Hãy đợi hoàn tất hoặc hủy các tệp còn trong hàng đợi.', 'info');
              return;
            }
            if (trackerState.step === 'completed' && trackerState.driveFile) {
              forgetOcrRecoveryJob(trackerState.driveFile.id);
            }
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
            if (queueStatus) processNextInQueue();
          }}
        />
      )}

      {/* Digitization Review Modal */}
      {digitizationDraft && (
        <DigitizationReviewModal
          draft={digitizationDraft}
          error={digitizationError}
          members={members}
          profiles={profiles}
          selectedMemberId={selectedMemberId}
          onClose={() => {
            if (digitizationDraft) forgetOcrRecoveryJob(digitizationDraft.source.id);
            setDigitizationDraft(null);
            processNextInQueue();
          }}
          onSave={(e, targetMemberId) => void handleSaveDigitization(e, targetMemberId)}
        />
      )}

      {/* App Update Modal */}
      <AppUpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={appVersion}
        updateInfo={updateInfo}
        onClose={() => setIsUpdateModalOpen(false)}
      />

      {/* Workspace Audit & Factory Reset Modal */}
      <WorkspaceAuditModal
        isOpen={showWorkspaceAuditModal}
        workspace={workspace}
        profiles={profiles}
        userEmail={userEmail}
        onClose={() => setShowWorkspaceAuditModal(false)}
        onFactoryReset={handleFactoryReset}
        showToast={showToast}
      />
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
  const patientName = extracted.patientName?.trim();
  const patientGender = extracted.patientGender?.trim().toLowerCase();
  const patientBirth = extracted.patientBirthDate?.trim();

  if (patientName) {
    const matched = members.find((m) => isSamePersonName(patientName, m.name));
    if (matched) return matched.id;
  }

  if (patientBirth) {
    const isMale = patientGender ? (patientGender.includes('nam') || patientGender === 'male') : false;
    const isFemale = patientGender ? (patientGender.includes('nữ') || patientGender === 'female') : false;
    const matched = members.find((m) => {
      const birthMatch = m.birthDate && (m.birthDate === patientBirth || patientBirth.startsWith(m.birthDate.slice(0, 4)));
      const genderMatch = isMale ? m.gender === 'male' : isFemale ? m.gender === 'female' : true;
      return Boolean(birthMatch && genderMatch);
    });
    if (matched) return matched.id;
  }

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

  const [metricsText, setMetricsText] = useState(
    (extracted.metrics || [])
      .map((metric) => `${metric.name} | ${metric.value} | ${metric.unit}`)
      .join('\n')
  );
  const [medicationsText, setMedicationsText] = useState(
    (extracted.medications || [])
      .map((m) => `${m.name} | ${m.dosage || ''} | ${m.frequency || ''} | ${m.duration || ''}`)
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

        <div className="p-3 rounded-2xl bg-emerald-50/60 border border-emerald-100 text-[11px] text-emerald-900">
          AI đã tự động trích xuất thông tin từ tài liệu. Bạn có thể kiểm tra họ tên, ngày sinh, giới tính đối chiếu với thành viên gia đình trước khi lưu.
        </div>

        {/* Đối chiếu & Ghép thông tin bệnh nhân với thành viên gia đình */}
        <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 space-y-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-bold text-slate-800">
              Đối chiếu thông tin nhận dạng trên tài liệu:
            </span>
            {targetMemberId && (
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold flex items-center gap-1">
                <Check className="w-3 h-3 text-emerald-600" />
                <span>Khớp với: {members.find((m) => m.id === targetMemberId)?.name}</span>
              </span>
            )}
          </div>

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
                {extracted.patientBirthDate || 'Chưa nhận dạng'}
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
                    {m.name} ({gLabel}{m.birthDate ? ` · Sinh ${m.birthDate}` : ''})
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
              defaultValue={validDate(extracted.date)}
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
              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-extrabold shadow-sm transition-all"
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
    .map(([name, dosage, frequency, duration]) => ({
      name,
      dosage: dosage || undefined,
      frequency: frequency || undefined,
      duration: duration || undefined,
    }));
}

function parseMetricLines(value: string): HealthEvent['metrics'] {
  return value
    .split(/\r?\n/)
    .map((line) => line.split('|').map((part) => part.trim()))
    .flatMap(([name, rawValue, unit]) => {
      const metricValue = Number(rawValue?.replace(',', '.'));
      if (!name || !Number.isFinite(metricValue)) return [];
      return [{ name, value: metricValue, unit: unit || '' }];
    });
}

function validDate(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 10);
}

function validDateOrEmpty(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function validEventType(value?: string): HealthEvent['type'] {
  return EVENT_TYPE_OPTIONS.some((item) => item.value === value)
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
