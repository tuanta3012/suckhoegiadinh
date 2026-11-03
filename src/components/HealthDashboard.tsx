import { Camera, FileUp, HeartPulse, LoaderCircle, MessageCircle, Plus, RefreshCw, ShieldAlert, Users } from 'lucide-react';
import { CameraResultType, CameraSource } from '@capacitor/camera';
import { Camera as CapacitorCamera } from '@capacitor/camera';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppUpdateModal } from './AppUpdateModal';
import { useAppUpdate } from '../hooks/useAppUpdate';
import {
  CartesianGrid,
  Line,
  LineChart,
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
  type HealthDriveWorkspace,
  openHealthWorkspace,
  loadHealthProfile,
  saveHealthProfile,
  uploadRawHealthFile,
} from '../utils/healthDriveService';
import {
  addHealthSource,
  createHealthProfile,
  digitizeHealthSource,
  parseHealthProfile,
} from '../utils/healthProfile';
import { askHealthAssistant, extractHealthEvent, summarizeHealthProfile } from '../utils/geminiService';
import type { DriveFile } from '../utils/healthDriveService';
import {
  listHealthWorkspaceAssignments,
  publishHealthWorkspaceAssignments,
  readHealthWorkspaceAssignment,
  removeHealthWorkspaceAssignment,
  type HealthWorkspaceAssignment,
  type WorkspaceAccessRole,
} from '../utils/workspaceShareRelay';

type ViewName = 'overview' | 'timeline' | 'assistant' | 'family';

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
}

const PROFILE_ROOT_KEY = 'health_family_drive_root_id';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPDATE_SERVER_URL = 'https://raw.githubusercontent.com/tuanta3012/suckhoegiadinh/refs/heads/main/version.json';
const EVENT_TYPES: Array<{ value: HealthEvent['type']; label: string }> = [
  { value: 'medical_report', label: 'Khám bệnh' },
  { value: 'prescription', label: 'Đơn thuốc' },
  { value: 'test_result', label: 'Kết quả xét nghiệm' },
  { value: 'vaccination', label: 'Tiêm chủng' },
  { value: 'discharge', label: 'Ra viện' },
  { value: 'other', label: 'Khác' },
];

export function HealthDashboard({
  userEmail,
  appVersion,
  driveAuthorized,
  onConnectDrive,
  onLogout,
  showToast,
}: HealthDashboardProps) {
  const [rootIdInput, setRootIdInput] = useState('');
  const [workspace, setWorkspace] = useState<HealthDriveWorkspace | null>(null);
  const [profiles, setProfiles] = useState<Record<string, HealthProfile>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [view, setView] = useState<ViewName>('overview');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<FamilyMember['role']>('other');
  const [workspaceAssignments, setWorkspaceAssignments] = useState<HealthWorkspaceAssignment[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceAccessRole>('EDITOR');
  const [digitizationDraft, setDigitizationDraft] = useState<DigitizationDraft | null>(null);
  const [digitizationError, setDigitizationError] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('');
  const [isSummarizing, setIsSummarizing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupInFlight = useRef(false);
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
    userEmail && workspace?.family.adminEmail &&
    userEmail.trim().toLowerCase() === workspace.family.adminEmail.trim().toLowerCase(),
  );
  const selectedMember = members.find((member) => member.id === selectedMemberId) || members[0] || null;
  const selectedProfile = selectedMember ? profiles[selectedMember.id] : null;
  const metricNames = useMemo(
    () => [...new Set(selectedProfile?.timeline.flatMap((event) => event.metrics.map((metric) => metric.name)) || [])],
    [selectedProfile],
  );
  const chartData = useMemo(
    () =>
      selectedProfile?.timeline
        .filter((event) => event.metrics.some((metric) => metric.name === selectedMetric))
        .map((event) => ({
          date: event.date,
          value: event.metrics.find((metric) => metric.name === selectedMetric)?.value,
          unit: event.metrics.find((metric) => metric.name === selectedMetric)?.unit,
        })) || [],
    [selectedProfile, selectedMetric],
  );

  useEffect(() => {
    if (metricNames.length && !metricNames.includes(selectedMetric)) setSelectedMetric(metricNames[0]);
  }, [metricNames, selectedMetric]);

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
      }),
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
      nextWorkspace.family.members.some((member) => member.id === current)
        ? current
        : nextWorkspace.family.members[0]?.id || '',
    );
  }, []);

  const openWorkspace = useCallback(async (id: string) => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      const opened = await openHealthWorkspace(id.trim());
      if (userEmail) localStorage.setItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`, opened.rootFolderId);
      localStorage.setItem(PROFILE_ROOT_KEY, opened.rootFolderId);
      setWorkspace(opened);
      setRootIdInput(opened.rootFolderId);
      await reloadProfiles(opened);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể mở thư mục Drive.');
    } finally {
      setIsLoading(false);
    }
  }, [reloadProfiles, userEmail]);

  useEffect(() => {
    if (!driveAuthorized || !userEmail || workspace) return;
    let cancelled = false;
    const savedRootId = localStorage.getItem(`${PROFILE_ROOT_KEY}_${userEmail.trim().toLowerCase()}`)
      || localStorage.getItem(PROFILE_ROOT_KEY);
    if (savedRootId) {
      void openWorkspace(savedRootId);
      return () => { cancelled = true; };
    }

    void readHealthWorkspaceAssignment(userEmail)
      .then((assignment) => {
        if (!cancelled && assignment) void openWorkspace(assignment.rootFolderId);
      })
      .catch((error: unknown) => {
        if (!cancelled) setErrorMessage(error instanceof Error ? `Không tải được Workspace được chia sẻ: ${error.message}` : 'Không tải được Workspace được chia sẻ.');
      });
    return () => { cancelled = true; };
  }, [driveAuthorized, openWorkspace, userEmail, workspace]);

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
          showToast(`Đã xóa ${result.deleted} tài liệu gốc quá 3 năm đã được số hóa.`, 'info');
          await reloadProfiles(workspace);
        }
        if (result.retained) {
          showToast(`Giữ lại ${result.retained} tài liệu quá hạn chưa có bản ghi số hóa đầy đủ.`, 'info');
        }
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? `Dọn dữ liệu cũ thất bại: ${error.message}` : 'Dọn dữ liệu cũ thất bại.');
      })
      .finally(() => {
        cleanupInFlight.current = false;
      });
  }, [driveAuthorized, reloadProfiles, showToast, workspace]);

  const reloadWorkspaceAssignments = useCallback(async () => {
    if (!workspace || !isWorkspaceAdmin) return;
    try {
      setWorkspaceAssignments(await listHealthWorkspaceAssignments(workspace.rootFolderId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? `Không tải được danh sách chia sẻ: ${error.message}` : 'Không tải được danh sách chia sẻ.');
    }
  }, [isWorkspaceAdmin, workspace]);

  useEffect(() => {
    void reloadWorkspaceAssignments();
  }, [reloadWorkspaceAssignments]);

  async function handleInviteWorkspaceMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !userEmail || !isWorkspaceAdmin) return;
    const email = inviteEmail.trim().toLowerCase();
    setIsLoading(true);
    setErrorMessage('');
    try {
      const assignments = new Map(
        workspaceAssignments
          .filter((assignment) => assignment.memberEmail !== email)
          .map((assignment) => [assignment.memberEmail, assignment.role]),
      );
      assignments.set(email, inviteRole);
      await publishHealthWorkspaceAssignments(
        workspace.rootFolderId,
        workspace.familyFileId,
        userEmail,
        [...assignments].map(([memberEmail, role]) => ({ email: memberEmail, role })),
      );
      setInviteEmail('');
      await reloadWorkspaceAssignments();
      showToast('Đã gửi lời mời Workspace. Hãy chia sẻ thư mục Drive với email này để cấp quyền truy cập tệp.', 'success');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể gửi lời mời Workspace.');
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
      showToast('Đã thu hồi lời mời Workspace.', 'success');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể thu hồi lời mời Workspace.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCreateWorkspace() {
    if (!driveAuthorized) {
      onConnectDrive();
      return;
    }
    setIsLoading(true);
    setErrorMessage('');
    try {
      const created = await createHealthWorkspace(userEmail || '');
      localStorage.setItem(`${PROFILE_ROOT_KEY}_${userEmail?.trim().toLowerCase()}`, created.rootFolderId);
      localStorage.setItem(`${PROFILE_ROOT_KEY}_${userEmail?.trim().toLowerCase()}`, created.rootFolderId);
      localStorage.setItem(PROFILE_ROOT_KEY, created.rootFolderId);
      setWorkspace(created);
      setRootIdInput(created.rootFolderId);
      if (created.relayRegistrationError) {
        showToast(`Đã tạo thư mục Drive, nhưng chưa bật được lời mời Firestore: ${created.relayRegistrationError}`, 'error');
      } else {
        showToast('Đã tạo Workspace. Hãy chia sẻ thư mục Drive với các thành viên được mời.', 'success');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể tạo thư mục gia đình.');
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
        role: newMemberRole,
      });
      setWorkspace(next);
      setNewMemberName('');
      await reloadProfiles(next);
      setSelectedMemberId(memberId);
      setView('timeline');
      showToast('Đã thêm thành viên và tạo hồ sơ JSON trên Drive.', 'success');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không thể thêm thành viên.');
    } finally {
      setIsAddingMember(false);
    }
  }

  async function beginDigitization(file: File) {
    if (!workspace || !selectedMember) {
      showToast('Hãy tạo hoặc chọn hồ sơ thành viên trước khi tải tài liệu.', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('Tệp vượt quá giới hạn 25 MB.', 'error');
      return;
    }
    setIsUploading(true);
    setDigitizationError('');
    try {
      const uploaded = await uploadRawHealthFile(selectedMember, file);
      const source: HealthSource = {
        driveFileId: uploaded.id,
        fileName: uploaded.name,
        mimeType: uploaded.mimeType || file.type || 'application/octet-stream',
        uploadedAt: uploaded.createdTime || new Date().toISOString(),
        status: 'pending',
      };
      const current = profiles[selectedMember.id] || createHealthProfile(selectedMember);
      const stagedProfile = addHealthSource(current, source);
      const savedStagedProfile = await saveHealthProfile(selectedMember.profileFileId, stagedProfile);
      setProfiles((previous) => ({ ...previous, [selectedMember.id]: savedStagedProfile }));
      setDigitizationDraft({ source: uploaded, extracted: {} });

      try {
        const extracted = await extractHealthEvent(file, selectedMember);
        setDigitizationDraft({ source: uploaded, extracted });
        showToast('Đã tải tài liệu lên Drive và trích xuất thông tin. Hãy kiểm tra trước khi ghi hồ sơ.', 'success');
      } catch (error) {
        setDigitizationError(error instanceof Error ? error.message : 'Chưa thể phân tích tài liệu bằng Gemini.');
        showToast('Tài liệu đã lưu trên Drive. Bạn có thể nhập thông tin thủ công.', 'info');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Không tải được tài liệu lên Drive.');
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
      if (!photo.webPath) throw new Error('Camera không trả về đường dẫn ảnh.');
      const response = await fetch(photo.webPath);
      if (!response.ok) throw new Error('Không đọc được ảnh vừa chụp.');
      const blob = await response.blob();
      const file = new File([blob], `ho-so-${new Date().toISOString().slice(0, 10)}.${photo.format || 'jpg'}`, {
        type: blob.type || 'image/jpeg',
      });
      await beginDigitization(file);
    } catch (error) {
      if (error instanceof Error && !/cancel|cancelled|canceled/i.test(error.message)) {
        showToast(error.message, 'error');
      }
    }
  }

  async function handleSaveDigitization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!digitizationDraft || !selectedMember || !selectedProfile) return;
    const form = new FormData(event.currentTarget);
    const date = String(form.get('date') || '');
    const title = String(form.get('title') || '').trim();
    const extracted = digitizationDraft.extracted;
    const nextEvent: HealthEvent = {
      id: `event_${crypto.randomUUID()}`,
      sourceFileId: digitizationDraft.source.id,
      sourceFileName: digitizationDraft.source.name,
      type: validEventType(String(form.get('type') || extracted.type)),
      title,
      date,
      facility: String(form.get('facility') || '').trim() || undefined,
      diagnoses: splitLines(String(form.get('diagnoses') || '')),
      medications: parseMedicationLines(String(form.get('medications') || '')),
      metrics: parseMetricLines(String(form.get('metrics') || '')),
      advice: String(form.get('advice') || '').trim() || undefined,
      nextFollowUp: String(form.get('nextFollowUp') || '').trim() || undefined,
      notes: String(form.get('notes') || '').trim() || undefined,
      extractedData: isRecord(extracted.extractedData) ? extracted.extractedData as Record<string, JsonValue> : undefined,
      recordedAt: new Date().toISOString(),
    };

    try {
      const nextProfile = digitizeHealthSource(selectedProfile, nextEvent);
      const merged = await saveHealthProfile(selectedMember.profileFileId, nextProfile);
      setProfiles((previous) => ({ ...previous, [selectedMember.id]: merged }));
      setDigitizationDraft(null);
      setDigitizationError('');
      showToast('Đã ghi sự kiện vào hồ sơ sức khỏe trên Drive.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu sự kiện sức khỏe.', 'error');
    }
  }

  async function handleAskAssistant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMember || !selectedProfile || !chatInput.trim()) return;
    const question = chatInput.trim();
    setChatInput('');
    setChatMessages((previous) => [...previous, { role: 'user', text: question }]);
    setIsChatting(true);
    try {
      const answer = await askHealthAssistant(question, selectedMember, selectedProfile);
      setChatMessages((previous) => [...previous, { role: 'assistant', text: answer }]);
    } catch (error) {
      setChatMessages((previous) => [
        ...previous,
        { role: 'assistant', text: error instanceof Error ? error.message : 'Không thể kết nối trợ lý sức khỏe.' },
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
      const updated = { ...selectedProfile, summary: { ...selectedProfile.summary, narrative }, updatedAt: new Date().toISOString() };
      const saved = await saveHealthProfile(selectedMember.profileFileId, updated);
      setProfiles((previous) => ({ ...previous, [selectedMember.id]: saved }));
      showToast('Đã cập nhật tổng kết sức khỏe.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể tạo tổng kết sức khỏe.', 'error');
    } finally {
      setIsSummarizing(false);
    }
  }

  const showWorkspaceSetup = !workspace;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
              <HeartPulse className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-base font-extrabold sm:text-lg">Sức khỏe gia đình</h1>
              <p className="text-xs text-slate-500">{userEmail || 'Hồ sơ sức khỏe riêng tư trên Google Drive'} · v{appVersion}</p>
            </div>
          </div>
          {userEmail ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void checkAppUpdate(true)}
                disabled={isCheckingUpdate}
                aria-label="Kiểm tra cập nhật ứng dụng"
                title="Kiểm tra cập nhật ứng dụng"
                className="flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${isCheckingUpdate ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Kiểm tra cập nhật</span>
              </button>
              <button
                type="button"
                onClick={onConnectDrive}
                className={`rounded-xl px-3 py-2 text-xs font-bold ${driveAuthorized ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-900 text-white'}`}
              >
                {driveAuthorized ? 'Drive đã kết nối' : 'Cấp quyền Drive'}
              </button>
              <button type="button" onClick={onLogout} className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600">
                Đăng xuất
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void checkAppUpdate(true)}
                disabled={isCheckingUpdate}
                aria-label="Kiểm tra cập nhật ứng dụng"
                title="Kiểm tra cập nhật ứng dụng"
                className="rounded-xl border border-slate-300 p-2 text-slate-600 disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${isCheckingUpdate ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={onConnectDrive} className="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white">
                Đăng nhập Google
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 pb-24">
        {errorMessage && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {showWorkspaceSetup ? (
          <section className="mx-auto mt-8 max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h2 className="text-xl font-extrabold">Kết nối hồ sơ gia đình</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Tạo thư mục dùng chung trên Google Drive hoặc nhập ID thư mục đã được Admin chia sẻ cho bạn.
              Thành viên trong gia đình cần có quyền truy cập thư mục trên Drive.
            </p>
            {!driveAuthorized && (
              <button onClick={onConnectDrive} className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white">
                Đăng nhập và cấp quyền Google Drive
              </button>
            )}
            {driveAuthorized && (
              <>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleCreateWorkspace()}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-60"
                >
                  {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Tạo thư mục “Sức khỏe Gia đình”
                </button>
                <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
                  <span className="h-px flex-1 bg-slate-200" /> HOẶC <span className="h-px flex-1 bg-slate-200" />
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void openWorkspace(rootIdInput);
                  }}
                  className="space-y-3"
                >
                  <label htmlFor="root-folder-id" className="block text-sm font-semibold">ID thư mục Drive dùng chung</label>
                  <input
                    id="root-folder-id"
                    value={rootIdInput}
                    onChange={(event) => setRootIdInput(event.target.value)}
                    required
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    placeholder="Dán ID trong URL thư mục Google Drive"
                  />
                  <button disabled={isLoading} className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-bold disabled:opacity-60">
                    Mở thư mục đã chia sẻ
                  </button>
                </form>
              </>
            )}
          </section>
        ) : (
          <>
            <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
              {([
                ['overview', 'Tổng quan'],
                ['timeline', 'Hồ sơ thành viên'],
                ['assistant', 'Trợ lý AI'],
                ['family', 'Thành viên'],
              ] as Array<[ViewName, string]>).map(([name, label]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setView(name)}
                  className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold ${view === name ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 shadow-sm'}`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => void openWorkspace(workspace.rootFolderId)}
                className="ml-auto flex shrink-0 items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm"
                aria-label="Tải lại dữ liệu Drive"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Đồng bộ</span>
              </button>
            </div>

            {view === 'overview' && (
              <section>
                <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-extrabold">Sức khỏe gia đình</h2>
                    <p className="mt-1 text-sm text-slate-500">Tổng hợp từ các sự kiện đã ghi nhận trong hồ sơ.</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={handleCameraCapture} disabled={!driveAuthorized || isUploading || !members.length} className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                      <Camera className="h-4 w-4" /> Chụp tài liệu
                    </button>
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!driveAuthorized || isUploading || !members.length} className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold disabled:opacity-50">
                      {isUploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Tải lên
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*,.pdf"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void beginDigitization(file);
                        event.currentTarget.value = '';
                      }}
                    />
                  </div>
                </div>

                {!members.length && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
                    <Users className="mx-auto h-9 w-9 text-slate-400" />
                    <p className="mt-3 font-bold">Chưa có thành viên</p>
                    <p className="mt-1 text-sm text-slate-500">Thêm người thân để tạo hồ sơ sức khỏe.</p>
                    <button onClick={() => setView('family')} className="mt-4 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white">Thêm thành viên</button>
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {members.map((member) => {
                    const profile = profiles[member.id];
                    return (
                      <button
                        key={member.id}
                        type="button"
                        onClick={() => { setSelectedMemberId(member.id); setView('timeline'); }}
                        className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-emerald-300 hover:shadow-md"
                      >
                        <div className="flex items-center justify-between">
                          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-lg font-bold text-emerald-800">{member.name.slice(0, 1)}</span>
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{profile?.timeline.length || 0} sự kiện</span>
                        </div>
                        <h3 className="mt-4 text-lg font-extrabold">{member.name}</h3>
                        {profileErrors[member.id] ? (
                          <p className="mt-2 text-sm text-rose-700">Lỗi tải hồ sơ: {profileErrors[member.id]}</p>
                        ) : profile?.summary.latestEventDate ? (
                          <>
                            <p className="mt-2 text-sm text-slate-500">Cập nhật gần nhất: {profile.summary.latestEventDate}</p>
                            <p className="mt-2 line-clamp-2 text-sm text-slate-700">
                              {profile.summary.latestDiagnoses.join(', ') || profile.summary.narrative || 'Chưa có chẩn đoán được ghi nhận.'}
                            </p>
                          </>
                        ) : (
                          <p className="mt-2 text-sm text-slate-500">Chưa có dữ liệu sức khỏe được ghi nhận.</p>
                        )}
                        {profile?.summary.nextFollowUp && <p className="mt-3 text-xs font-semibold text-amber-700">Tái khám: {profile.summary.nextFollowUp}</p>}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-5 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  Thông tin trong ứng dụng được ghi từ tài liệu gia đình cung cấp, không thay thế chẩn đoán hoặc tư vấn của nhân viên y tế.
                </p>
              </section>
            )}

            {view === 'timeline' && (
              <section>
                {!members.length ? (
                  <EmptyState title="Chưa có hồ sơ thành viên" action={() => setView('family')} />
                ) : (
                  <>
                    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <label htmlFor="member-picker" className="text-xs font-bold uppercase tracking-wide text-slate-500">Thành viên</label>
                        <select
                          id="member-picker"
                          value={selectedMember?.id || ''}
                          onChange={(event) => setSelectedMemberId(event.target.value)}
                          className="mt-1 block rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base font-bold"
                        >
                          {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" onClick={handleCameraCapture} disabled={!driveAuthorized || isUploading} className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                          <Camera className="h-4 w-4" /> Chụp
                        </button>
                        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!driveAuthorized || isUploading} className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold disabled:opacity-50">
                          <FileUp className="h-4 w-4" /> Tải tài liệu
                        </button>
                      </div>
                    </div>
                    {profileErrors[selectedMember?.id || ''] && <p role="alert" className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{profileErrors[selectedMember?.id || '']}</p>}
                    <HealthTimeline
                      profile={selectedProfile}
                      metricNames={metricNames}
                      selectedMetric={selectedMetric}
                      chartData={chartData}
                      onMetricChange={setSelectedMetric}
                      onOpenSource={(id) => window.open(`https://drive.google.com/file/d/${encodeURIComponent(id)}/view`, '_blank', 'noopener,noreferrer')}
                      onSummarize={() => void handleAiSummary()}
                      isSummarizing={isSummarizing}
                    />
                  </>
                )}
              </section>
            )}

            {view === 'assistant' && (
              <section className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-5">
                  <h2 className="flex items-center gap-2 text-lg font-extrabold"><MessageCircle className="h-5 w-5 text-emerald-600" /> Trợ lý sức khỏe</h2>
                  <p className="mt-1 text-sm text-slate-500">Câu trả lời chỉ dựa trên hồ sơ thành viên đang chọn.</p>
                </div>
                <div className="p-5">
                  <label htmlFor="chat-member" className="text-xs font-bold uppercase tracking-wide text-slate-500">Hồ sơ tra cứu</label>
                  <select id="chat-member" value={selectedMember?.id || ''} onChange={(event) => { setSelectedMemberId(event.target.value); setChatMessages([]); }} className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2.5">
                    {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                  <div aria-live="polite" className="mt-4 min-h-56 space-y-3 rounded-xl bg-slate-50 p-4">
                    {!chatMessages.length && <p className="text-sm text-slate-500">Ví dụ: “Lần gần nhất Mẹ khám ở đâu?” hoặc “Chỉ số đường huyết thay đổi thế nào?”</p>}
                    {chatMessages.map((message, index) => (
                      <div key={`${message.role}-${index}`} className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2.5 text-sm ${message.role === 'user' ? 'ml-auto bg-emerald-100 text-emerald-950' : 'bg-white text-slate-800 shadow-sm'}`}>
                        {message.text}
                      </div>
                    ))}
                    {isChatting && <LoaderCircle className="h-5 w-5 animate-spin text-emerald-600" />}
                  </div>
                  <form onSubmit={(event) => void handleAskAssistant(event)} className="mt-3 flex gap-2">
                    <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} disabled={!members.length || isChatting} className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-3 text-sm" placeholder="Nhập câu hỏi về hồ sơ..." />
                    <button disabled={!members.length || isChatting || !chatInput.trim()} className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">Gửi</button>
                  </form>
                </div>
              </section>
            )}

            {view === 'family' && (
              <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="flex items-center gap-2 text-lg font-extrabold"><Users className="h-5 w-5 text-emerald-600" /> Thành viên gia đình</h2>
                  <ul className="mt-4 divide-y divide-slate-100">
                    {members.map((member) => (
                      <li key={member.id} className="flex items-center justify-between gap-3 py-3">
                        <div>
                          <p className="font-bold">{member.name}</p>
                          <p className="text-xs text-slate-500">{member.role} · {profiles[member.id]?.timeline.length || 0} sự kiện</p>
                        </div>
                        <button type="button" onClick={() => { setSelectedMemberId(member.id); setView('timeline'); }} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold">Mở hồ sơ</button>
                      </li>
                    ))}
                  </ul>
                  {isWorkspaceAdmin && <form onSubmit={(event) => void handleAddMember(event)} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                    <label htmlFor="new-member-name" className="block text-sm font-bold">Thêm thành viên</label>
                    <input id="new-member-name" value={newMemberName} onChange={(event) => setNewMemberName(event.target.value)} required className="w-full rounded-xl border border-slate-300 px-3 py-2.5" placeholder="Tên thành viên" />
                    <select value={newMemberRole} onChange={(event) => setNewMemberRole(event.target.value as FamilyMember['role'])} className="w-full rounded-xl border border-slate-300 px-3 py-2.5">
                      <option value="father">Bố</option><option value="mother">Mẹ</option><option value="child">Con</option><option value="other">Khác</option>
                    </select>
                    <button disabled={isAddingMember} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-50">
                      {isAddingMember && <LoaderCircle className="h-4 w-4 animate-spin" />} Tạo hồ sơ thành viên
                    </button>
                  </form>}
                </div>
                <div className="h-fit rounded-2xl border border-amber-200 bg-amber-50 p-5">
                  <h3 className="font-extrabold text-amber-950">Chia sẻ an toàn</h3>
                  <p className="mt-2 text-sm leading-6 text-amber-900">
                    Chia sẻ thư mục gốc trên Google Drive với tài khoản Google của các thành viên. Chỉ cấp quyền cho người cần truy cập.
                    ID thư mục: <code className="break-all">{workspace.rootFolderId}</code>
                  </p>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(workspace.rootFolderId).then(() => showToast('Đã sao chép ID thư mục.', 'success')).catch(() => showToast('Không sao chép được ID thư mục.', 'error'))} className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-950">
                    Sao chép ID thư mục
                  </button>
                  {isWorkspaceAdmin ? (
                    <div className="mt-5 border-t border-amber-200 pt-4">
                      <h4 className="font-bold text-amber-950">Mời tài khoản Google</h4>
                      <p className="mt-1 text-xs leading-5 text-amber-900">
                        Lời mời chỉ chuyển ID Workspace qua Firestore; bạn vẫn phải chia sẻ thư mục Drive với cùng email.
                        Vai trò ở đây là thông tin, quyền đọc/ghi thực tế do Google Drive quyết định.
                      </p>
                      <form onSubmit={(event) => void handleInviteWorkspaceMember(event)} className="mt-3 space-y-2">
                        <input
                          type="email"
                          required
                          value={inviteEmail}
                          onChange={(event) => setInviteEmail(event.target.value)}
                          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm"
                          placeholder="email@gmail.com"
                        />
                        <select
                          value={inviteRole}
                          onChange={(event) => setInviteRole(event.target.value as WorkspaceAccessRole)}
                          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm"
                        >
                          <option value="EDITOR">Editor</option>
                          <option value="VIEWER">Viewer</option>
                        </select>
                        <button disabled={isLoading} className="w-full rounded-lg bg-amber-900 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
                          Gửi lời mời
                        </button>
                      </form>
                      {workspaceAssignments.length > 0 && (
                        <ul className="mt-4 divide-y divide-amber-200">
                          {workspaceAssignments.map((assignment) => (
                            <li key={assignment.memberEmail} className="flex items-center justify-between gap-2 py-2 text-sm">
                              <span className="min-w-0 break-all">{assignment.memberEmail} · {assignment.role}</span>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => void handleRevokeWorkspaceMember(assignment.memberEmail)}
                                className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-bold"
                              >
                                Thu hồi
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : !workspace.family.adminEmail ? (
                    <p className="mt-4 border-t border-amber-200 pt-3 text-xs leading-5 text-amber-900">
                      Workspace cũ chưa xác định Admin; để tránh chiếm quyền, tính năng mời qua Firestore chỉ áp dụng cho Workspace mới.
                    </p>
                  ) : null}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {digitizationDraft && (
        <DigitizationModal
          draft={digitizationDraft}
          error={digitizationError}
          onClose={() => setDigitizationDraft(null)}
          onSave={(event) => void handleSaveDigitization(event)}
        />
      )}
      <AppUpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={appVersion}
        updateInfo={updateInfo}
        onClose={() => setIsUpdateModalOpen(false)}
      />
    </div>
  );
}

interface TimelineProps {
  profile: HealthProfile | null;
  metricNames: string[];
  selectedMetric: string;
  chartData: Array<{ date: string; value?: number; unit?: string }>;
  onMetricChange: (metric: string) => void;
  onOpenSource: (id: string) => void;
  onSummarize: () => void;
  isSummarizing: boolean;
}

function HealthTimeline({
  profile,
  metricNames,
  selectedMetric,
  chartData,
  onMetricChange,
  onOpenSource,
  onSummarize,
  isSummarizing,
}: TimelineProps) {
  if (!profile) return <p className="rounded-xl bg-white p-5 text-sm text-slate-500">Đang tải hồ sơ...</p>;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-extrabold">Tóm tắt gần nhất</h3>
            <button type="button" onClick={onSummarize} disabled={isSummarizing} className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold disabled:opacity-50">
              {isSummarizing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Tổng hợp bằng AI
            </button>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-700">{profile.summary.narrative || 'Chưa có tổng kết AI. Hồ sơ chỉ hiển thị thông tin đã được ghi nhận, không tự đưa ra chẩn đoán.'}</p>
          {profile.summary.latestDiagnoses.length > 0 && <p className="mt-3 text-sm"><strong>Chẩn đoán gần nhất:</strong> {profile.summary.latestDiagnoses.join(', ')}</p>}
          {profile.summary.latestEventDate && <p className="mt-2 text-xs text-slate-500">Ngày ghi nhận: {profile.summary.latestEventDate}</p>}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-extrabold">Diễn biến chỉ số</h3>
            {metricNames.length > 0 && <select value={selectedMetric || metricNames[0]} onChange={(event) => onMetricChange(event.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">{metricNames.map((name) => <option key={name}>{name}</option>)}</select>}
          </div>
          {chartData.length > 1 ? (
            <div className="mt-3 h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: 0, right: 12, top: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis width={48} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#059669" strokeWidth={2.5} dot={{ r: 4 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Cần ít nhất hai lần ghi nhận cùng chỉ số để hiển thị xu hướng.</p>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-4 font-extrabold">Dòng thời gian ({profile.timeline.length})</h3>
        {!profile.timeline.length ? (
          <p className="py-8 text-center text-sm text-slate-500">Chưa có sự kiện. Tải lên tài liệu để tạo bản ghi đầu tiên.</p>
        ) : (
          <ol className="space-y-4">
            {[...profile.timeline].reverse().map((event) => (
              <li key={event.id} className="relative border-l-2 border-emerald-200 pb-2 pl-5">
                <span className="absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-white bg-emerald-600" />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold text-emerald-700">{event.date} · {eventTypeLabel(event.type)}</p>
                    <h4 className="mt-1 font-bold">{event.title}</h4>
                    {event.facility && <p className="mt-1 text-sm text-slate-600">{event.facility}</p>}
                  </div>
                  <button type="button" onClick={() => onOpenSource(event.sourceFileId)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600">
                    Tài liệu gốc
                  </button>
                </div>
                {event.diagnoses.length > 0 && <p className="mt-2 text-sm"><strong>Chẩn đoán:</strong> {event.diagnoses.join('; ')}</p>}
                {event.medications.length > 0 && <p className="mt-2 text-sm"><strong>Thuốc:</strong> {event.medications.map((medication) => `${medication.name}${medication.dosage ? ` (${medication.dosage})` : ''}`).join('; ')}</p>}
                {event.metrics.length > 0 && <p className="mt-2 text-sm"><strong>Chỉ số:</strong> {event.metrics.map((metric) => `${metric.name}: ${metric.value} ${metric.unit}`).join(' · ')}</p>}
                {event.advice && <p className="mt-2 text-sm text-slate-700"><strong>Lời dặn:</strong> {event.advice}</p>}
                {event.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{event.notes}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

interface DigitizationModalProps {
  draft: DigitizationDraft;
  error: string;
  onClose: () => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
}

function DigitizationModal({ draft, error, onClose, onSave }: DigitizationModalProps) {
  const extracted = draft.extracted;
  const [metricsText, setMetricsText] = useState((extracted.metrics || []).map((metric) => `${metric.name} | ${metric.value} | ${metric.unit}`).join('\n'));
  const [medicationsText, setMedicationsText] = useState((extracted.medications || []).map((item) => `${item.name} | ${item.dosage || ''} | ${item.frequency || ''} | ${item.duration || ''}`).join('\n'));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="digitize-title" className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-7">
        <h2 id="digitize-title" className="text-xl font-extrabold">Ghi nhận tài liệu y tế</h2>
        <p className="mt-1 break-all text-xs text-slate-500">{draft.source.name}</p>
        {error && <div role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error}</div>}
        <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
          Kiểm tra thông tin trước khi lưu. Bản gốc chỉ được tự động xóa sau 3 năm khi sự kiện đã có trong hồ sơ.
        </p>
        <form onSubmit={onSave} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold">Tiêu đề *
            <input name="title" required defaultValue={extracted.title || draft.source.name} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-semibold">Ngày khám / tài liệu *
            <input name="date" type="date" required defaultValue={validDate(extracted.date)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-semibold">Loại tài liệu
            <select name="type" defaultValue={validEventType(extracted.type)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal">
              {EVENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="text-sm font-semibold">Cơ sở y tế
            <input name="facility" defaultValue={extracted.facility || ''} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">Chẩn đoán
            <textarea name="diagnoses" rows={2} defaultValue={(extracted.diagnoses || []).join('\n')} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" placeholder="Mỗi dòng một thông tin" />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">Thuốc · liều · tần suất · thời gian
            <textarea value={medicationsText} onChange={(event) => setMedicationsText(event.target.value)} name="medications" rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" placeholder="Mỗi dòng: Tên thuốc | liều | tần suất | thời gian" />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">Chỉ số · giá trị · đơn vị
            <textarea value={metricsText} onChange={(event) => setMetricsText(event.target.value)} name="metrics" rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" placeholder="Mỗi dòng: Huyết áp tâm thu | 120 | mmHg" />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">Lời dặn / tái khám
            <textarea name="advice" rows={2} defaultValue={extracted.advice || ''} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-semibold">Ngày tái khám
            <input name="nextFollowUp" type="date" defaultValue={validDateOrEmpty(extracted.nextFollowUp)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-semibold sm:col-span-2">Ghi chú
            <textarea name="notes" rows={3} defaultValue={extracted.notes || ''} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          <div className="flex justify-end gap-2 pt-2 sm:col-span-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold">Để sau</button>
            <button className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white">Xác nhận và ghi hồ sơ</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function EmptyState({ title, action }: { title: string; action: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="font-bold">{title}</p>
      <button onClick={action} className="mt-3 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">Quản lý thành viên</button>
    </div>
  );
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function parseMedicationLines(value: string): HealthEvent['medications'] {
  return value.split(/\r?\n/).map((line) => line.split('|').map((part) => part.trim())).filter(([name]) => Boolean(name)).map(([name, dosage, frequency, duration]) => ({
    name,
    dosage: dosage || undefined,
    frequency: frequency || undefined,
    duration: duration || undefined,
  }));
}

function parseMetricLines(value: string): HealthEvent['metrics'] {
  return value.split(/\r?\n/).map((line) => line.split('|').map((part) => part.trim())).flatMap(([name, rawValue, unit]) => {
    const metricValue = Number(rawValue?.replace(',', '.'));
    if (!name || !Number.isFinite(metricValue)) return [];
    return [{ name, value: metricValue, unit: unit || '' }];
  });
}

function validDate(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10);
}

function validDateOrEmpty(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function validEventType(value?: string): HealthEvent['type'] {
  return EVENT_TYPES.some((item) => item.value === value) ? value as HealthEvent['type'] : 'other';
}

function eventTypeLabel(value: HealthEvent['type']): string {
  return EVENT_TYPES.find((item) => item.value === value)?.label || 'Khác';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
