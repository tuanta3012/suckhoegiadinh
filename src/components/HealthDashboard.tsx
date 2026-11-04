import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bot,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  Clock,
  Cloud,
  Copy,
  Cpu,
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
  cleanupExpiredRawFiles,
  createHealthWorkspace,
  deleteDriveFamilyMember,
  factoryResetWorkspaceFolder,
  findExistingHealthWorkspace,
  type HealthDriveWorkspace,
  openHealthWorkspace,
  loadHealthProfile,
  saveHealthProfile,
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
} from '../utils/geminiService';
import { DigitizationProgressTrackerModal, type TrackerStep } from './DigitizationProgressTrackerModal';
import { GeminiPoolModal } from './GeminiPoolModal';
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
import { DuplicateDocumentModal } from './DuplicateDocumentModal';
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
    step: TrackerStep;
    progressPercent: number;
    progressMessage: string;
    driveFile: DriveFile | null;
    modelUsed: string;
    partialExtracted: Partial<HealthEvent>;
    error: string | null;
  }>({
    isOpen: false,
    file: null,
    step: 'uploading_drive',
    progressPercent: 0,
    progressMessage: '',
    driveFile: null,
    modelUsed: 'gemini-3.5-flash-lite',
    partialExtracted: {},
    error: null,
  });
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('');
  const [timelineFilter, setTimelineFilter] = useState<string>('all');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [showQuickActionModal, setShowQuickActionModal] = useState(false);
  const [showGeminiPoolModal, setShowGeminiPoolModal] = useState(false);
  const [showWorkspaceAuditModal, setShowWorkspaceAuditModal] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [fileDuplicateCandidate, setFileDuplicateCandidate] = useState<{
    file: File;
    match: FileDuplicateMatch;
  } | null>(null);
  const [uploadQueue, setUploadQueue] = useState<File[]>([]);
  const [queueStatus, setQueueStatus] = useState<{ current: number; total: number } | null>(null);

  function processNextInQueue() {
    if (uploadQueue.length > 0) {
      const nextFile = uploadQueue[0];
      const remaining = uploadQueue.slice(1);
      const nextCurrent = (queueStatus?.current || 1) + 1;
      const total = queueStatus?.total || (remaining.length + nextCurrent);
      setUploadQueue(remaining);
      setQueueStatus({ current: nextCurrent, total });
      showToast(`Hàng đợi tải lên: Đang xử lý tệp ${nextCurrent}/${total} (${nextFile.name})...`, 'info');
      void beginDigitization(nextFile);
    } else {
      if (queueStatus) {
        showToast(`Đã hoàn tất xử lý hàng đợi ${queueStatus.total} tệp tài liệu y tế!`, 'success');
      }
      setQueueStatus(null);
    }
  }

  async function handleFactoryReset() {
    if (!workspace || !userEmail) return;
    const fresh = await factoryResetWorkspaceFolder(workspace, userEmail);
    setWorkspace(fresh);
    setProfiles({});
    setSelectedMemberId('');
    setDigitizationDraft(null);
    setFileDuplicateCandidate(null);
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

  const reloadProfiles = useCallback(async (nextWorkspace: HealthDriveWorkspace) => {
    const entries = await Promise.all(
      nextWorkspace.family.members.map(async (member) => {
        try {
          const remote = await loadHealthProfile(member.profileFileId);
          return [member.id, parseHealthProfile(remote, member), null] as const;
        } catch (error) {
          return [
            member.id,
            createHealthProfile(member),
            error instanceof Error ? error.message : 'Không tải được hồ sơ.',
          ] as const;
        }
      })
    );
    const nextProfiles: Record<string, HealthProfile> = {};
    const nextErrors: Record<string, string> = {};
    for (const [memberId, profile, error] of entries) {
      nextProfiles[memberId] = profile;
      if (error) nextErrors[memberId] = error;
    }
    setProfiles(nextProfiles);
    setProfileErrors(nextErrors);
    setSelectedMemberId((current) =>
      nextWorkspace.family.members.some((m) => m.id === current)
        ? current
        : nextWorkspace.family.members[0]?.id || ''
    );
  }, []);

  const openWorkspace = useCallback(
    async (id: string) => {
      setIsLoading(true);
      setErrorMessage('');
      try {
        const opened = await openHealthWorkspace(id.trim());
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
      const { workspace: next, cleanupError } = await deleteDriveFamilyMember(workspace, member.id);
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
      if (cleanupError) {
        setErrorMessage(cleanupError);
      } else {
        showToast(`Đã xóa vĩnh viễn thành viên ${member.name} và hồ sơ Drive liên quan.`, 'success');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể xóa thành viên.');
    } finally {
      setIsLoading(false);
    }
  }

  async function beginDigitization(file: File, options?: { forceUpload?: boolean }) {
    if (!workspace || !selectedMember) {
      showToast('Hãy chọn hoặc tạo hồ sơ thành viên trước khi tải tài liệu.', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('Tệp vượt quá giới hạn cho phép 25 MB.', 'error');
      return;
    }

    // Kiểm tra trùng lặp tài liệu trước khi tải lên Drive (tránh tốn dung lượng và hạn ngạch AI)
    if (!options?.forceUpload) {
      try {
        const { hash, size } = await computeFileFingerprint(file);
        const currentProfile = profiles[selectedMember.id] || createHealthProfile(selectedMember);
        const fileDup = detectDuplicateFile({ name: file.name, size }, hash, currentProfile, selectedMember);
        if (fileDup) {
          setFileDuplicateCandidate({ file, match: fileDup });
          return;
        }

        const crossDup = detectCrossMemberDuplicateFile({ name: file.name, size }, hash, profiles, selectedMember.id);
        if (crossDup) {
          setFileDuplicateCandidate({ file, match: crossDup });
          return;
        }
      } catch (err) {
        console.warn('[Deduplication Pre-check Failed]:', err);
      }
    }

    setIsUploading(true);
    setDigitizationError('');
    setShowQuickActionModal(false);

    // Mở ngay modal theo dõi tiến trình và nội dung đang nhận dạng trực quan
    setTrackerState({
      isOpen: true,
      file,
      step: 'uploading_drive',
      progressPercent: 20,
      progressMessage: 'Đang tải tệp lên thư mục "Suc khoe gia dinh" trên Google Drive...',
      driveFile: null,
      modelUsed: 'gemini-3.5-flash-lite',
      partialExtracted: {},
      error: null,
    });

    try {
      const uploaded = await uploadRawHealthFile(selectedMember, file);
      const { hash } = await computeFileFingerprint(file);
      const source: HealthSource = {
        driveFileId: uploaded.id,
        fileName: uploaded.name,
        fileSize: file.size,
        fileHash: hash,
        mimeType: uploaded.mimeType || file.type || 'application/octet-stream',
        uploadedAt: uploaded.createdTime || new Date().toISOString(),
        status: 'pending',
      };
      const current = profiles[selectedMember.id] || createHealthProfile(selectedMember);
      const stagedProfile = addHealthSource(current, source);
      const savedStagedProfile = await saveHealthProfile(
        selectedMember.profileFileId,
        stagedProfile
      );
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: savedStagedProfile }));

      setTrackerState((prev) => ({
        ...prev,
        driveFile: uploaded,
        step: 'reading_document',
        progressPercent: 42,
        progressMessage: 'Đã lưu tệp vào Google Drive. Khởi động AI Vision đọc tài liệu...',
      }));

      try {
        const result = await extractHealthEventWithProgress(file, selectedMember, (update) => {
          setTrackerState((prev) => {
            const nextStep: TrackerStep =
              update.stage === 'reading_document'
                ? 'reading_document'
                : update.stage === 'extracting_content'
                ? 'extracting_content'
                : update.stage === 'matching_patient'
                ? 'matching_patient'
                : update.stage === 'completed'
                ? 'completed'
                : prev.step;

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
        });

        setTrackerState((prev) => ({
          ...prev,
          step: 'completed',
          progressPercent: 100,
          progressMessage: 'AI đã bóc tách xong toàn bộ dữ liệu y khoa từ tài liệu!',
          partialExtracted: result.extracted,
          modelUsed: result.modelUsed || prev.modelUsed,
        }));

        showToast('AI đã trích xuất xong thông tin từ tài liệu.', 'success');
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Chưa thể phân tích tài liệu bằng Gemini.';
        setDigitizationError(msg);
        setTrackerState((prev) => ({
          ...prev,
          step: 'error',
          progressMessage: 'Lỗi nhận dạng tài liệu',
          error: msg,
        }));
        showToast('Tài liệu đã lưu trên Drive. Bạn có thể bấm "Nhập thủ công" để tiếp tục.', 'info');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Không tải được tài liệu lên Google Drive.';
      setErrorMessage(msg);
      setTrackerState((prev) => ({
        ...prev,
        step: 'error',
        progressMessage: 'Lỗi tải tệp lên Google Drive',
        error: msg,
      }));
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
      const updated: HealthProfile = {
        ...selectedProfile,
        summary: { ...selectedProfile.summary, narrative },
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveHealthProfile(selectedMember.profileFileId, updated);
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: saved }));
      showToast('Đã tạo tóm tắt bệnh án thông minh bằng AI.', 'success');
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
    if (!selectedMember || !selectedProfile || !selectedProfile.timeline.length) {
      showToast('Chưa có sự kiện y tế nào để hiệu chỉnh.', 'info');
      return;
    }
    setIsRefining(true);
    try {
      const { organizedTimeline, refinementNotes } = await refineAndOrganizeMemberData(
        selectedMember,
        selectedProfile.timeline
      );
      const updated: HealthProfile = {
        ...selectedProfile,
        timeline: organizedTimeline,
        updatedAt: new Date().toISOString(),
      };
      const saved = await saveHealthProfile(selectedMember.profileFileId, updated);
      setProfiles((prev) => ({ ...prev, [selectedMember.id]: saved }));
      showToast(
        `Đã dùng AI Flash-Lite chuẩn hóa & sắp xếp dữ liệu (${refinementNotes[0] || 'Hoàn tất'})`,
        'success'
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
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          {/* Zone 1: Brand Wordmark & Logo */}
          <div className="flex items-center gap-2.5 min-w-0">
            <AppLogo size="sm" />
            <div className="min-w-0">
              <span className="text-base font-extrabold tracking-tight text-slate-900 truncate block">
                Sức Khỏe Gia Đình
              </span>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="truncate">
                  {driveAuthorized ? 'Google Drive đã kết nối' : 'Chưa cấp quyền Drive'}
                </span>
              </div>
            </div>
          </div>

          {/* Zone 2: Active Member Switcher Dropdown (Mobile-first ergonomics) */}
          {members.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowMemberDropdown(!showMemberDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:scale-[0.98] transition-all text-xs font-bold text-slate-800"
              >
                <span className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[10px] font-bold">
                  {selectedMember?.name.charAt(0) || 'U'}
                </span>
                <span className="max-w-[85px] sm:max-w-[120px] truncate">
                  {selectedMember?.name || 'Thành viên'}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {showMemberDropdown && (
                <div
                  className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-2xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 duration-150"
                  onClick={() => setShowMemberDropdown(false)}
                >
                  <div className="px-3 py-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    Chọn thành viên
                  </div>
                  {members.map((m) => {
                    const isCurrent = m.id === selectedMember?.id;
                    const count = profiles[m.id]?.timeline?.length || 0;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedMemberId(m.id)}
                        className={`w-full flex items-center justify-between p-2 rounded-xl text-xs font-semibold transition-colors ${
                          isCurrent
                            ? 'bg-emerald-50 text-emerald-800 font-bold'
                            : 'hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-[11px]">
                            {m.name.charAt(0)}
                          </span>
                          <span className="truncate">{m.name}</span>
                        </div>
                        <span className="text-[10px] text-slate-400 font-mono tabular-nums">
                          {count} mục
                        </span>
                      </button>
                    );
                  })}
                  <div className="mt-1 pt-1 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => setActiveTab('family')}
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

          {/* Zone 3: Sync & Quick Action Trigger */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowWorkspaceAuditModal(true)}
              title="Kiểm tra trùng lặp thư mục Drive & Khởi tạo lại"
              className="p-2 rounded-xl text-slate-600 hover:text-teal-600 hover:bg-teal-50 active:scale-95 transition-all"
            >
              <FolderSync className="w-4 h-4 text-teal-600" />
            </button>
            <button
              type="button"
              onClick={() => setShowGeminiPoolModal(true)}
              title="Trạng thái Hệ thống AI Gemini Server (Tự động cân bằng tải & phân luồng)"
              className="p-2 rounded-xl text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 active:scale-95 transition-all relative"
            >
              <Cpu className="w-4 h-4 text-indigo-600" />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            </button>
            <button
              type="button"
              onClick={() => void checkAppUpdate(true)}
              disabled={isCheckingUpdate}
              title="Kiểm tra bản cập nhật mới"
              className="p-2 rounded-xl text-slate-600 hover:bg-slate-100 active:scale-95 transition-all"
            >
              <RefreshCw className={`w-4 h-4 ${isCheckingUpdate ? 'animate-spin text-emerald-600' : ''}`} />
            </button>
            {userEmail ? (
              <button
                type="button"
                onClick={onLogout}
                title="Đăng xuất tài khoản"
                className="p-2 rounded-xl text-slate-500 hover:text-rose-600 hover:bg-rose-50 active:scale-95 transition-all"
              >
                <LogOut className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onConnectDrive}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-bold shadow-xs active:scale-95 transition-all"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Đăng nhập</span>
              </button>
            )}
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
                        Trợ lý Y Tế AI (Gemini Flash)
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
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-black text-lg">
                      {selectedMember?.name.charAt(0) || 'U'}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-extrabold text-slate-900 text-base">
                          {selectedMember?.name}
                        </h3>
                        {selectedMember && (
                          <span className="text-xs text-slate-500 font-normal">
                            {[
                              selectedMember.gender === 'male' ? 'Nam' : selectedMember.gender === 'female' ? 'Nữ' : selectedMember.gender === 'other' ? 'Khác' : '',
                              selectedMember.birthDate ? `Sinh ${selectedMember.birthDate}` : '',
                            ].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">
                        Hồ sơ: {selectedProfile?.timeline.length || 0} tài liệu · Cập nhật gần nhất:{' '}
                        {selectedProfile?.summary.latestEventDate || 'Chưa có'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCameraCapture}
                      disabled={!driveAuthorized || isUploading}
                      className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>Chụp tài liệu</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!driveAuthorized || isUploading}
                      className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:scale-95 text-slate-800 font-bold text-xs transition-all disabled:opacity-50"
                    >
                      <FileUp className="w-3.5 h-3.5" />
                      <span>Tải tệp</span>
                    </button>
                  </div>
                </div>

                {/* AI Summary Card (Tóm tắt bệnh án thông minh) */}
                <div className="rounded-2xl border border-emerald-200/80 bg-white p-5 shadow-xs">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-emerald-600" />
                      <div>
                        <h4 className="font-extrabold text-slate-900 text-sm">
                          Đánh giá y khoa & Phân tích chuyên sâu (AI Flash)
                        </h4>
                        <span className="text-[10px] text-slate-400">
                          Tier 3.8 / 3.6 / 3 Flash • Tự động failover qua 6 key
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRefineAndOrganize()}
                        disabled={isRefining || !selectedProfile?.timeline.length}
                        title="Dùng AI Flash-Lite chuẩn hóa danh pháp, liều lượng và sắp xếp thông minh"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-700 hover:bg-slate-50 active:scale-95 transition-all disabled:opacity-40"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${isRefining ? 'animate-spin text-indigo-600' : ''}`}
                        />
                        <span>{isRefining ? 'Đang chuẩn hóa...' : 'Chuẩn hóa & sắp xếp (Lite)'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAiSummary()}
                        disabled={isSummarizing || !selectedProfile?.timeline.length}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs active:scale-95 transition-all disabled:opacity-40"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${isSummarizing ? 'animate-spin' : ''}`}
                        />
                        <span>{isSummarizing ? 'Đang phân tích...' : 'Đánh giá hồ sơ (Flash)'}</span>
                      </button>
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-slate-700 leading-relaxed">
                    {selectedProfile?.summary.narrative ||
                      'Chưa có bản tổng hợp AI. Hãy tải lên tài liệu y tế hoặc bấm "Cập nhật tóm tắt" để AI tóm tắt tiền sử bệnh, thuốc và các chẩn đoán quan trọng.'}
                  </p>

                  {selectedProfile?.summary.latestDiagnoses &&
                    selectedProfile.summary.latestDiagnoses.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mr-1">
                          Chẩn đoán gần nhất:
                        </span>
                        {selectedProfile.summary.latestDiagnoses.map((diag, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-800 text-xs font-semibold"
                          >
                            {diag}
                          </span>
                        ))}
                      </div>
                    )}
                </div>

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
                                  className="px-2.5 py-1 rounded-lg bg-teal-50 border border-teal-200 text-teal-900 text-xs font-semibold tabular-nums"
                                >
                                  {met.name}: <strong>{met.value}</strong> {met.unit}
                                </span>
                              ))}
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
              setUploadQueue([]);
              setQueueStatus(null);
              void beginDigitization(files[0]);
            } else {
              setUploadQueue(files.slice(1));
              setQueueStatus({ current: 1, total: files.length });
              showToast(`Đã chọn ${files.length} tệp. Đang xử lý tệp 1/${files.length} (${files[0].name})...`, 'info');
              void beginDigitization(files[0]);
            }
            event.currentTarget.value = '';
          }}
        />

        {/* Upload Queue Floating Status Banner */}
        {queueStatus && (
          <div className="fixed bottom-20 left-4 right-4 z-40 max-w-md mx-auto bg-slate-900/95 text-white px-4 py-3 rounded-2xl shadow-2xl border border-slate-700 flex items-center justify-between gap-3 animate-in slide-in-from-bottom-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-teal-500/20 text-teal-400 flex items-center justify-center shrink-0">
                <RefreshCw className="w-4 h-4 animate-spin" />
              </div>
              <div>
                <span className="font-bold text-xs block">
                  Đang xử lý hàng đợi tải lên ({queueStatus.current}/{queueStatus.total})
                </span>
                <span className="text-[10px] text-slate-400">
                  Tự động xử lý tuần tự từng tệp tài liệu y tế
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setUploadQueue([]);
                setQueueStatus(null);
                showToast('Đã hủy hàng đợi tải lên.', 'info');
              }}
              className="text-xs text-rose-400 hover:text-rose-300 font-bold px-2 py-1"
            >
              Hủy
            </button>
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
            className="w-13 h-13 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-lg shadow-emerald-600/30 active:scale-95 transition-transform"
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
      {selectedMember && (
        <DigitizationProgressTrackerModal
          isOpen={trackerState.isOpen}
          file={trackerState.file}
          member={selectedMember}
          members={members}
          step={trackerState.step}
          progressPercent={trackerState.progressPercent}
          progressMessage={trackerState.progressMessage}
          driveFile={trackerState.driveFile}
          modelUsed={trackerState.modelUsed}
          partialExtracted={trackerState.partialExtracted}
          error={trackerState.error}
          onReview={() => {
            if (trackerState.driveFile) {
              setDigitizationDraft({
                source: trackerState.driveFile,
                extracted: trackerState.partialExtracted,
              });
            }
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
          }}
          onRetry={() => {
            if (trackerState.file) {
              void beginDigitization(trackerState.file);
            }
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
            setTrackerState((prev) => ({ ...prev, isOpen: false }));
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
            setDigitizationDraft(null);
            processNextInQueue();
          }}
          onSave={(e, targetMemberId) => void handleSaveDigitization(e, targetMemberId)}
        />
      )}

      {/* Duplicate Document Pre-Upload Modal */}
      <DuplicateDocumentModal
        isOpen={Boolean(fileDuplicateCandidate)}
        file={fileDuplicateCandidate?.file || null}
        match={fileDuplicateCandidate?.match || null}
        currentMemberName={selectedMember?.name || ''}
        onViewExisting={(linkedEvent, memberId) => {
          if (memberId && memberId !== selectedMember?.id) {
            setSelectedMemberId(memberId);
          }
          setFileDuplicateCandidate(null);
          setActiveTab('timeline');
          showToast(`Đã chuyển tới hồ sơ: ${linkedEvent.title}`, 'info');
          processNextInQueue();
        }}
        onProceedReScan={() => {
          if (fileDuplicateCandidate) {
            const targetFile = fileDuplicateCandidate.file;
            setFileDuplicateCandidate(null);
            void beginDigitization(targetFile, { forceUpload: true });
          }
        }}
        onProceedForceNew={() => {
          if (fileDuplicateCandidate) {
            const targetFile = fileDuplicateCandidate.file;
            setFileDuplicateCandidate(null);
            void beginDigitization(targetFile, { forceUpload: true });
          }
        }}
        onCancel={() => {
          setFileDuplicateCandidate(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
          processNextInQueue();
        }}
      />

      {/* App Update Modal */}
      <AppUpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={appVersion}
        updateInfo={updateInfo}
        onClose={() => setIsUpdateModalOpen(false)}
      />

      {/* Gemini 6-Key Pool Management Modal */}
      <GeminiPoolModal
        isOpen={showGeminiPoolModal}
        onClose={() => setShowGeminiPoolModal(false)}
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
  const patientName = extracted.patientName?.trim().toLowerCase();
  const patientGender = extracted.patientGender?.trim().toLowerCase();
  const patientBirth = extracted.patientBirthDate?.trim();

  if (patientName) {
    const matched = members.find((m) => {
      const mName = m.name.trim().toLowerCase();
      return mName === patientName || patientName.includes(mName) || mName.includes(patientName);
    });
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
