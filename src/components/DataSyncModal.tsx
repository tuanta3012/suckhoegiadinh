import React, { useState, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import { useConfirmDialog } from '../context/ConfirmDialogContext';
import {
  CheckCircle,
  CheckCircle2,
  X,
  ExternalLink,
  RefreshCw,
  FileSpreadsheet,
  ShieldCheck,
  Trash2,
  Cloud,
  AlertCircle,
  AlertTriangle,
  Globe,
  Link2,
  Unlink,
  Download,
  Upload,
  HardDrive,
  Plus,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { SavingsBook, AppSettings, AuthUser, SettlementAdjustment, WorkspaceMember, canChangeDriveFile } from '../types';
import { exportSavingsBooksToExcel, parseExcelFile } from '../utils/excelParser';
import { Capacitor } from '@capacitor/core';
import { getDynamicAnnualInterestHistory, getDynamicBalanceGrowthHistory, clearStaticHistoryFromStorage } from '../data/historicalGrowth';
import { formatVND } from '../utils/formatters';
import { getVietnamDateISO } from '../utils/date';

import {
  initGoogleAuth,
  signInWithGoogle,
  signInWithGoogleRedirect,
  getGoogleAccessToken,
  validateAndEnsureToken,
  listRealGoogleDriveFiles,
  downloadRealGoogleDriveFile,
  createRealGoogleDriveFile,
  deleteRealGoogleDriveFile,
  getRealGoogleDriveFileMetadata,
  assertWorkspaceMembership,
  getMasterSyncStateFromDrive,
  setMasterSyncLinked,
  setMasterSyncUnlinked,
  autoDiscoverLatestCentralHub,
  setExplicitlyUnlinked,
  isExplicitlyUnlinked,
  isDefaultTestName,
  markDriveFileAsManagedByApp,
  saveLocalMasterPointerFileId,
  saveLocalMasterPointerState,
  RealDriveFile,
} from '../utils/googleDriveService';
import { resolveUserRole } from '../utils/roleHelper';

interface DataSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  books: SavingsBook[];
  settlements?: SettlementAdjustment[];
  onImportBooks: (newBooks: SavingsBook[], mode: 'replace' | 'append') => void;
  onClearBooks: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: Partial<AppSettings>) => void;
  appUser?: AuthUser | null;
  onLoginOnline?: (user: AuthUser, accessToken?: string) => void;
  onTriggerManualSync?: () => Promise<void>;
  onDriveFileNotFound?: () => void;
  onMarkAsRemoteUpdate?: (
    newBooks?: SavingsBook[],
    newAdjs?: SettlementAdjustment[],
    newUrl?: string,
    newModifiedTime?: string
  ) => void;
  onStartFileSwitch?: () => void;
  onFinishFileSwitch?: (
    newBooks: SavingsBook[],
    newAdjs?: SettlementAdjustment[],
    newUrl?: string,
    newFileName?: string,
    stampTime?: string,
    fileModTime?: string,
    readOnly?: boolean
  ) => void;
  onCancelFileSwitch?: () => void;
}

export const DataSyncModal: React.FC<DataSyncModalProps> = ({
  isOpen,
  onClose,
  books,
  settlements = [],
  onImportBooks,
  onClearBooks,
  settings,
  onUpdateSettings,
  appUser,
  onLoginOnline,
  onTriggerManualSync,
  onDriveFileNotFound,
  onMarkAsRemoteUpdate,
  onStartFileSwitch,
  onFinishFileSwitch,
  onCancelFileSwitch,
}) => {
  // Google Auth state
  const { showToast } = useToast();
  const { confirm } = useConfirmDialog();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(getGoogleAccessToken());
  const hasGoogleToken = Boolean(accessToken || getGoogleAccessToken());
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);

  // Offline file overwrite confirmation state
  const [pendingOfflineFile, setPendingOfflineFile] = useState<File | null>(null);
  const [showOverwriteWarning, setShowOverwriteWarning] = useState<boolean>(false);

  // Drive state
  const [realFiles, setRealFiles] = useState<RealDriveFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(false);
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [selectedFileName, setSelectedFileName] = useState<string>(
    settings.googleSheetName || (settings.googleSheetUrl?.includes('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms') ? 'Example Spreadsheet' : '')
  );
  const [isFetchingFileName, setIsFetchingFileName] = useState<boolean>(false);
  const [sheetUrl, setSheetUrl] = useState<string>(settings.googleSheetUrl || '');
  const [isChoosingDifferentFile, setIsChoosingDifferentFile] = useState<boolean>(false);
  const [, setDiscoveredHub] = useState<{ id: string; name: string; webViewLink?: string; mimeType?: string; linkedTimestamp?: string } | null>(null);
  const [, setIsDiscoveringHub] = useState<boolean>(false);
  
  // Sync messages & steps
  const [syncStatusStep, setSyncStatusStep] = useState<string | null>(null);
  const [googleSyncMessage, setGoogleSyncMessage] = useState<string | null>(null);
  const [syncErrorMessage, setSyncErrorMessage] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(settings.lastSyncTime || null);

  // Sync messages toast effect (only when modal is open and user performs actions)
  useEffect(() => {
    if (isOpen && googleSyncMessage) {
      showToast(googleSyncMessage, 'success');
    }
  }, [isOpen, googleSyncMessage, showToast]);

  useEffect(() => {
    if (isOpen && syncErrorMessage) {
      showToast(syncErrorMessage, 'error');
    }
  }, [isOpen, syncErrorMessage, showToast]);
  const [isCreatingNewFile, setIsCreatingNewFile] = useState<boolean>(false);
  const [showCreateFileDialog, setShowCreateFileDialog] = useState<boolean>(false);
  const [newFileNameInput, setNewFileNameInput] = useState<string>('So_Tiet_Kiem_Gia_Dinh');
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);

  // Clear confirmation
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);
  const [isUnlinking, setIsUnlinking] = useState<boolean>(false);
  const [fileIsDeleted, setFileIsDeleted] = useState<boolean>(false);
  const [isManualSyncing, setIsManualSyncing] = useState<boolean>(false);

  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  const onUpdateSettingsRef = React.useRef(onUpdateSettings);
  onUpdateSettingsRef.current = onUpdateSettings;

  const isLoadingFilesRef = React.useRef(false);

  // Sync settings when modified externally
  useEffect(() => {
    setSelectedFileName(settings.googleSheetName || '');
    setSheetUrl(settings.googleSheetUrl || '');
    setLastSyncTime(settings.lastSyncTime || null);
    if (!settings.googleSheetUrl) {
      setSelectedFileId('');
    }
  }, [settings.googleSheetName, settings.googleSheetUrl, settings.lastSyncTime]);

  // Extract file ID from URL if present
  useEffect(() => {
    if (sheetUrl) {
      const match = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) || sheetUrl.match(/id=([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        setSelectedFileId(match[1]);
      } else if (sheetUrl.length > 20 && !sheetUrl.includes('/')) {
        setSelectedFileId(sheetUrl);
      }
    }
  }, [sheetUrl]);

  // Listen to Google Auth
  useEffect(() => {
    const unsubscribe = initGoogleAuth(
      (user, token) => {
        setCurrentUser(user);
        if (token) setAccessToken(token);
      },
      () => {
        setCurrentUser(null);
        setAccessToken(null);
        setRealFiles([]);
      }
    );
    return () => unsubscribe();
  }, []);

  // Kiểm tra liên kết file trung tâm từ Google Drive khi mở modal
  useEffect(() => {
    let isMounted = true;
    const token = accessToken || getGoogleAccessToken();
    if (isOpen && token) {
      (async () => {
        try {
          const currentSettings = settingsRef.current;
          const currentFileId =
            currentSettings.googleSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
            currentSettings.googleSheetUrl?.match(/id=([a-zA-Z0-9-_]+)/)?.[1];
          const master = await getMasterSyncStateFromDrive(token, currentFileId, { strict: true });
          if (!isMounted) return;
          const cur = settingsRef.current;
          const linkedFileId =
            cur.googleSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
            cur.googleSheetUrl?.match(/id=([a-zA-Z0-9-_]+)/)?.[1];
          if (
            master?.status === 'unlinked' &&
            master.activeFileId &&
            linkedFileId === master.activeFileId
          ) {
            if (cur.googleSheetUrl || cur.googleSheetName) {
              console.info('[DataSyncModal] Master xác nhận file đang liên kết đã bị unlink.');
              setSelectedFileName('');
              setSheetUrl('');
              setSelectedFileId('');
              setLastSyncTime(null);
              onUpdateSettingsRef.current({
                googleSheetUrl: undefined,
                googleSheetName: undefined,
                lastSyncTime: undefined,
              });
            }
          } else if (master?.status === 'active' && master.activeFileId) {
            const masterUrl = master.activeFileUrl || `https://docs.google.com/spreadsheets/d/${master.activeFileId}/edit`;
            const masterName = master.activeFileName || 'Bảng tính tiết kiệm';
            if (cur.googleSheetUrl !== masterUrl || cur.googleSheetName !== masterName) {
              setSelectedFileName(masterName);
              setSheetUrl(masterUrl);
              setSelectedFileId(master.activeFileId);
              onUpdateSettingsRef.current({
                googleSheetUrl: masterUrl,
                googleSheetName: masterName,
                workspaceOwnerEmail: master.adminEmail,
                members: master.members || [],
              });
            }
          }
        } catch (err) {
          console.warn('[DataSyncModal] Không xác minh được master workspace; giữ nguyên liên kết local:', err);
        }
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [isOpen, accessToken]);

  // Tự động kiểm tra và lấy tên file thật từ Google Drive khi modal mở hoặc có token
  useEffect(() => {
    let isMounted = true;
    const token = accessToken || getGoogleAccessToken();
    if (selectedFileId && token && isOpen) {
      setIsFetchingFileName(true);
      getRealGoogleDriveFileMetadata(token, selectedFileId)
        .then((meta) => {
          if (isMounted) {
            if (meta?.isDeleted) {
              setFileIsDeleted(true);
            } else if (meta?.name) {
              if (settingsRef.current.googleSheetName !== meta.name) {
                setSelectedFileName(meta.name);
                onUpdateSettingsRef.current({ googleSheetName: meta.name });
              }
              setFileIsDeleted(false);
            } else {
              setFileIsDeleted(false);
            }
          }
        })
        .catch((err) => {
          console.warn('Lỗi kiểm tra tên file trên Google Drive:', err);
        })
        .finally(() => {
          if (isMounted) setIsFetchingFileName(false);
        });
    } else {
      setFileIsDeleted(false);
    }
    return () => {
      isMounted = false;
    };
  }, [selectedFileId, accessToken, isOpen]);

  const loadGoogleDriveFiles = async (token: string): Promise<'loaded' | 'auth-error' | 'error'> => {
    if (isLoadingFilesRef.current) return 'error';
    isLoadingFilesRef.current = true;
    setIsLoadingFiles(true);
    setSyncErrorMessage(null);
    try {
      const files = await listRealGoogleDriveFiles(token);
      setRealFiles(files);
      if (selectedFileId && !selectedFileName) {
        const found = files.find((f) => f.id === selectedFileId);
        if (found && settingsRef.current.googleSheetName !== found.name) {
          setSelectedFileName(found.name);
          onUpdateSettingsRef.current({ googleSheetName: found.name });
        }
      }
      return 'loaded';
    } catch (err: any) {
      const message = err?.message || '';
      const isAuthError = /hết hạn|đăng nhập lại|chưa cấp quyền|authentication|credential|scope/i.test(message);
      if (isAuthError) {
        console.warn('Lỗi phiên Google Drive:', err.message);
        setAccessToken(null);
        setSyncErrorMessage(message || 'Phiên Google Drive cần được cấp quyền lại.');
      } else {
        console.error('Lỗi khi tải file Google Drive:', err);
        setSyncErrorMessage(message || 'Không thể tải danh sách file từ Google Drive của bạn.');
      }
      return isAuthError ? 'auth-error' : 'error';
    } finally {
      isLoadingFilesRef.current = false;
      setIsLoadingFiles(false);
    }
  };

  const handleRefreshDriveFiles = async () => {
    if (isAuthenticating || isLoadingFilesRef.current) return;
    const token = await validateTokenOrPrompt();
    if (!token) return;

    const result = await loadGoogleDriveFiles(token);
    if (result === 'auth-error') {
      const refreshedToken = await validateTokenOrPrompt();
      if (refreshedToken) await loadGoogleDriveFiles(refreshedToken);
    }
  };

  const hasAttemptedDriveLoadOnOpenRef = React.useRef(false);
  useEffect(() => {
    if (!isOpen) {
      hasAttemptedDriveLoadOnOpenRef.current = false;
      return;
    }
    const hasOnlineAccount = Boolean((appUser && !appUser.isOffline) || currentUser);
    if (!hasOnlineAccount) return;
    if (hasAttemptedDriveLoadOnOpenRef.current) return;
    hasAttemptedDriveLoadOnOpenRef.current = true;
    void handleRefreshDriveFiles();
  }, [isOpen, appUser, currentUser]);

  const validateTokenOrPrompt = async (): Promise<string | null> => {
    setIsAuthenticating(true);
    setSyncErrorMessage(null);
    try {
      const validToken = await validateAndEnsureToken();
      setAccessToken(validToken);
      // Synchronize online user profile if we have one
      if (currentUser) {
        const onlineUser: AuthUser = {
          email: currentUser.email || '',
          name: currentUser.displayName || 'Chủ Tài Khoản',
          role: 'admin',
          title: 'Quản trị viên (Admin)',
          isOffline: false,
        };
        onLoginOnline?.(onlineUser, validToken);
      }
      return validToken;
    } catch (err: any) {
      setSyncErrorMessage(err.message || 'Xác thực Google Drive không thành công hoặc bị hủy.');
      return null;
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleManualSyncClick = async () => {
    if (isManualSyncing) return;
    setIsManualSyncing(true);
    setSyncErrorMessage(null);
    setGoogleSyncMessage(null);
    setSyncStatusStep('Đang khởi động đồng bộ thủ công 2 chiều...');
    try {
      const token = await validateTokenOrPrompt();
      if (!token) {
        setIsManualSyncing(false);
        setSyncStatusStep(null);
        return;
      }

      // Check file name & existence
      if (selectedFileId) {
        setIsFetchingFileName(true);
        try {
          const meta = await getRealGoogleDriveFileMetadata(token, selectedFileId);
          if (meta?.isDeleted) {
            setFileIsDeleted(true);
            setSheetUrl('');
            setSelectedFileName('');
            setSelectedFileId(null);
            onUpdateSettings({ googleSheetUrl: undefined, googleSheetName: undefined });
            setExplicitlyUnlinked(true);
            setSyncErrorMessage(`❌ Đồng bộ thất bại: File liên kết đã bị xóa trên Google Drive. Đã tự động hủy liên kết!`);
            onDriveFileNotFound();
            return;
          } else if (meta?.name) {
            setSelectedFileName(meta.name);
            onUpdateSettings({ googleSheetName: meta.name });
            setFileIsDeleted(false);
          }
        } catch (err) {
          console.warn('Không lấy được metadata file khi đồng bộ thủ công:', err);
        } finally {
          setIsFetchingFileName(false);
        }
      }

      // Trigger the actual manual 2-way sync
      if (onTriggerManualSync) {
        setSyncStatusStep('Đang tải dữ liệu và cập nhật 2 chiều với Google Drive...');
        await onTriggerManualSync();
        const nowStr = new Date().toLocaleString('vi-VN');
        setLastSyncTime(nowStr);
        setGoogleSyncMessage(`✅ Đã hoàn tất đồng bộ thủ công 2 chiều thành công (${nowStr})!`);
      }
    } catch (err: any) {
      setSyncErrorMessage(`Lỗi đồng bộ thủ công: ${err.message || 'Không thể kết nối.'}`);
    } finally {
      setIsManualSyncing(false);
      setSyncStatusStep(null);
    }
  };

  const handleSignInGoogle = async () => {
    setIsAuthenticating(true);
    setSyncErrorMessage(null);
    try {
      const res = await signInWithGoogle();
      setCurrentUser(res.user);
      setAccessToken(res.accessToken);
      setGoogleSyncMessage(`Đã đăng nhập Google: ${res.user.email}`);

      // Update AuthUser in App.tsx to Online
      const onlineUser: AuthUser = {
        email: res.user.email || '',
        name: res.user.displayName || 'Chủ Tài Khoản',
        role: 'admin',
        title: 'Quản trị viên (Admin)',
        isOffline: false,
      };
      onLoginOnline?.(onlineUser, res.accessToken);

      await loadGoogleDriveFiles(res.accessToken);
    } catch (err: any) {
      setSyncErrorMessage(err.message || 'Đăng nhập Google thất bại. Vui lòng thử lại.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleSelectRealFile = async (file: RealDriveFile) => {
    const token = await validateTokenOrPrompt();
    if (!token) return;
    const signedInEmail = (currentUser?.email || appUser?.email || '').trim().toLowerCase();
    if (!signedInEmail) {
      setSyncErrorMessage('Không xác định được tài khoản Google để kiểm tra thành viên Nhóm thành viên.');
      return;
    }
    let verifiedMaster: Awaited<ReturnType<typeof assertWorkspaceMembership>>;
    try {
      verifiedMaster =
        file.mimeType === 'application/vnd.google-apps.spreadsheet'
          ? await assertWorkspaceMembership(token, file.id, signedInEmail, { allowUnlinked: true })
          : null;
    } catch (err) {
      setSyncErrorMessage(err instanceof Error ? err.message : 'Không thể xác minh thành viên Nhóm thành viên.');
      return;
    }
    const verifiedRole = verifiedMaster
      ? resolveUserRole(signedInEmail, undefined, verifiedMaster.members, verifiedMaster.adminEmail)
      : settings.currentRole?.toUpperCase() || 'VIEWER';
    if (verifiedRole !== 'ADMIN' && verifiedRole !== 'EDITOR' && verifiedRole !== 'VIEWER') {
      setSyncErrorMessage('Tài khoản không có vai trò hợp lệ trong Nhóm thành viên này.');
      return;
    }
    if (!verifiedMaster && verifiedRole !== 'ADMIN') {
      setSyncErrorMessage(
        'File này chưa có File liên kết đang hoạt động mà tài khoản của bạn tham gia. Chỉ Admin mới có thể khởi tạo liên kết.'
      );
      return;
    }
    // Nếu app đang có dữ liệu và chưa có sheetUrl, xác nhận trước khi nạp thay thế
    if (books.length > 0 && (!sheetUrl || isChoosingDifferentFile)) {
      const confirmReplace = await confirm({
        title: 'Thay thế dữ liệu hiện có?',
        message: `Dữ liệu ${books.length} sổ trên máy sẽ bị thay bằng file "${file.name}".`,
        confirmLabel: 'Thay thế',
      });
      if (!confirmReplace) return;
    }

    const previousFileId =
      selectedFileId ||
      (settings.googleSheetUrl
        ? (settings.googleSheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) || settings.googleSheetUrl.match(/id=([a-zA-Z0-9-_]+)/) || [])[1]
        : null);

    setIsChoosingDifferentFile(false);
    // Kích hoạt khóa chuyển đổi file triệt để để chặn vòng lặp
    onStartFileSwitch?.();
    setSelectedFileId(file.id);
    setSelectedFileName(file.name);
    setFileIsDeleted(false);
    const link = file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`;

    let stampTime = '';
    // Auto 2-way sync: Pull real data from the selected file into the app
    setSyncStatusStep(`Đang tự động đồng bộ dữ liệu từ file "${file.name}" trên Google Drive...`);
    setGoogleSyncMessage(null);
    setSyncErrorMessage(null);

    try {
      const parseResult = await downloadRealGoogleDriveFile(
        token,
        file.id,
        file.mimeType,
        signedInEmail
      );
      const nowStr = new Date().toLocaleString('vi-VN');

      if (parseResult.success && parseResult.books.length > 0) {
        const remoteMaster = verifiedMaster;
        const isWorkspaceViewer = verifiedRole === 'VIEWER';
        const isWorkspaceEditor = verifiedRole === 'EDITOR';
        setExplicitlyUnlinked(false);
        setSheetUrl(link);

        if (isWorkspaceViewer || isWorkspaceEditor) {
          if (
            remoteMaster?.status !== 'active' ||
            remoteMaster.activeFileId !== file.id ||
            remoteMaster.lastAction === 'unlink'
          ) {
            throw new Error('Chỉ thành viên của Nhóm thành viên đang hoạt động mới được liên kết file này.');
          }
          stampTime = remoteMaster.linkedTimestamp || new Date().toISOString();
          onUpdateSettings({
            currentRole: isWorkspaceViewer ? 'VIEWER' : 'EDITOR',
            workspaceOwnerEmail: remoteMaster.adminEmail,
            members: remoteMaster.members,
          });
          saveLocalMasterPointerFileId(file.id);
          saveLocalMasterPointerState(remoteMaster);
          try {
            await markDriveFileAsManagedByApp(token, file.id);
          } catch {}
        } else {
          stampTime = await setMasterSyncLinked(
            token,
            file.id,
            signedInEmail,
            previousFileId && previousFileId !== file.id ? previousFileId : undefined,
            file.name,
            link,
            previousFileId === file.id ? settings.lastLocalLinkTimestamp : undefined
          );
        }

        let fileModTime: string | undefined;
        try {
          const meta = await getRealGoogleDriveFileMetadata(token, file.id);
          fileModTime = meta?.modifiedTime;
        } catch {}

        if (onFinishFileSwitch) {
          onFinishFileSwitch(
            parseResult.books,
            parseResult.settlements,
            link,
            file.name,
            stampTime || new Date().toISOString(),
            fileModTime,
            isWorkspaceViewer
          );
        } else {
          onMarkAsRemoteUpdate?.(parseResult.books, parseResult.settlements, link, fileModTime);
          onImportBooks(parseResult.books, 'replace');
          onUpdateSettings({
            googleSheetUrl: link,
            googleSheetName: file.name,
            lastSyncTime: nowStr,
            autoSync: true,
            lastLocalLinkTimestamp: stampTime || new Date().toISOString(),
          });
        }
        setLastSyncTime(nowStr);
        setGoogleSyncMessage(
          isWorkspaceViewer
            ? `Đã tải ${parseResult.books.length} sổ từ "${file.name}" (chỉ đọc, ${nowStr})`
            : `⚡ Đã liên kết và đồng bộ thành công ${parseResult.books.length} sổ tiết kiệm từ file "${file.name}" trên Google Drive (${nowStr})`
        );
      } else {
        onCancelFileSwitch?.();
        setSyncErrorMessage(
          `File "${file.name}" không chứa dữ liệu sổ tiết kiệm hợp lệ hoặc rỗng. File trên Drive vẫn được giữ nguyên vẹn 100%.`
        );
      }
    } catch (err: any) {
      onCancelFileSwitch?.();
      setSyncErrorMessage(`Lỗi đọc file Google Drive: ${err.message || 'Không thể đọc nội dung file.'}`);
    } finally {
      setSyncStatusStep(null);
    }
  };

  // Auto-discover latest central hub file (A1) on login or mount if no sheetUrl is linked yet
  useEffect(() => {
    let isMounted = true;
    const token = accessToken || getGoogleAccessToken();
    if (token && !sheetUrl && !isChoosingDifferentFile && isOpen) {
      setIsDiscoveringHub(true);
      autoDiscoverLatestCentralHub(token, currentUser?.email || appUser?.email)
        .then(async (discovery) => {
          if (!isMounted) return;
          setIsDiscoveringHub(false);
          // Nếu modal hoặc máy đã có file liên kết hoặc vừa hủy liên kết, bỏ qua
          if (sheetUrl || selectedFileId || settingsRef.current.googleSheetUrl || isExplicitlyUnlinked()) {
            setDiscoveredHub(null);
            return;
          }
          if (discovery.status === 'multiple') {
            const workspaceNames = discovery.hubs
              .map((hub) => hub.name)
              .filter(Boolean)
              .map((name) => `"${name}"`)
              .join(', ');
            setSyncErrorMessage(
              `Tìm thấy ${discovery.hubs.length} File liên kết phù hợp${
                workspaceNames ? `: ${workspaceNames}` : ''
              }. Ứng dụng không tự chọn để tránh nhầm dữ liệu; hãy chọn đúng file từ danh sách bảng tính bên dưới.`
            );
            setDiscoveredHub(null);
            return;
          }
          if (discovery.status === 'error') {
            const candidateNames = discovery.candidates?.map((hub) => hub.name).join(', ');
            setSyncErrorMessage(
              `Không thể dò File liên kết: ${discovery.message}${
                candidateNames ? ` Ứng viên đã xác minh được: ${candidateNames}; hãy chọn thủ công.` : ''
              }`
            );
            setDiscoveredHub(null);
            return;
          }
          const latestHub = discovery.status === 'found' ? discovery.hub : null;
          if (latestHub) {
            try {
              const signedInEmail = (currentUser?.email || appUser?.email || '').trim().toLowerCase();
              const workspaceMaster = await assertWorkspaceMembership(
                token,
                latestHub.id,
                signedInEmail,
                { allowUnlinked: true }
              );
              if (!workspaceMaster) {
                throw new Error('Không thể xác minh thành viên của File liên kết đã phát hiện.');
              }
              const role = resolveUserRole(
                signedInEmail,
                undefined,
                workspaceMaster.members,
                workspaceMaster.adminEmail
              );
              const isViewer = role === 'VIEWER';
              if (!['ADMIN', 'EDITOR', 'VIEWER'].includes(role)) {
                throw new Error('Tài khoản không có vai trò hợp lệ trong Nhóm thành viên này.');
              }

              const link =
                latestHub.webViewLink ||
                `https://docs.google.com/spreadsheets/d/${latestHub.id}/edit`;
              setSyncStatusStep(`Đang tự động đồng bộ dữ liệu từ file trung tâm "${latestHub.name}"...`);

              const parseResult = await downloadRealGoogleDriveFile(
                token,
                latestHub.id,
                latestHub.mimeType,
                signedInEmail
              );
              if (!parseResult.success || !parseResult.books?.length) {
                throw new Error(
                  parseResult.errors?.[0] ||
                    'File liên kết đã xác minh nhưng không đọc được danh sách sổ tiết kiệm.'
                );
              }

              setExplicitlyUnlinked(false);
              setSelectedFileId(latestHub.id);
              setSelectedFileName(latestHub.name);
              setSheetUrl(link);
              onUpdateSettings({
                currentRole: role,
                workspaceOwnerEmail: workspaceMaster.adminEmail,
                members: workspaceMaster.members,
              });
              const nowStr = new Date().toLocaleString('vi-VN');
              if (onFinishFileSwitch) {
                onFinishFileSwitch(
                  parseResult.books,
                  parseResult.settlements,
                  link,
                  latestHub.name,
                  workspaceMaster.linkedTimestamp || latestHub.linkedTimestamp,
                  undefined,
                  isViewer
                );
              } else {
                onImportBooks(parseResult.books, 'replace');
                onUpdateSettings({
                  googleSheetUrl: link,
                  googleSheetName: latestHub.name,
                  lastSyncTime: nowStr,
                  autoSync: true,
                  lastLocalLinkTimestamp:
                    workspaceMaster.linkedTimestamp || latestHub.linkedTimestamp,
                  currentRole: role,
                  workspaceOwnerEmail: workspaceMaster.adminEmail,
                  members: workspaceMaster.members,
                });
              }
              setLastSyncTime(nowStr);
              setGoogleSyncMessage(
                isViewer
                  ? `⚡ Đã tự động kết nối và tải ${parseResult.books.length} sổ từ "${latestHub.name}" (chế độ chỉ xem, ${nowStr})`
                  : `⚡ Đã tự động kết nối và đồng bộ file trung tâm "${latestHub.name}" (${nowStr})`
              );
            } catch (err: any) {
              if (isMounted) {
                setSyncErrorMessage(
                  err instanceof Error
                    ? err.message
                    : 'Không thể tự động kết nối File liên kết. Hãy chọn file và thử lại.'
                );
              }
              console.warn('Auto-sync discovered hub download failed:', err);
            } finally {
              if (isMounted) setSyncStatusStep(null);
            }
          }
          setDiscoveredHub(null);
        })
        .catch((err) => {
          if (isMounted) {
            setIsDiscoveringHub(false);
            setDiscoveredHub(null);
          }
          console.warn('Auto-discover central hub failed:', err);
        });
    } else {
      setDiscoveredHub(null);
    }
    return () => {
      isMounted = false;
    };
  }, [accessToken, sheetUrl, isOpen]);

  // Create a brand new Excel file on the user's real Google Drive
  const handleCreateNewDriveFile = async () => {
    if (!canChangeDriveFile(settings.currentRole)) {
      setSyncErrorMessage('🔒 Chỉ Admin mới có quyền tạo file liên kết mới.');
      return;
    }
    if (!newFileNameInput.trim()) return;

    const token = await validateTokenOrPrompt();
    if (!token) return;

    setIsCreatingNewFile(true);
    setSyncErrorMessage(null);
    try {
      const userEmail = (currentUser?.email || appUser?.email || '').trim().toLowerCase();
      const userName = currentUser?.displayName || appUser?.name || 'Admin';
      const created = await createRealGoogleDriveFile(
        token,
        newFileNameInput.trim(),
        books,
        settlements,
        userEmail
      );

      onMarkAsRemoteUpdate?.(books, settlements, created.webViewLink);

      setSelectedFileId(created.id);
      setSelectedFileName(created.name);
      setSheetUrl(created.webViewLink);
      setShowCreateFileDialog(false);
      const nowStr = new Date().toLocaleString('vi-VN');
      setLastSyncTime(nowStr);
      const initialMember: WorkspaceMember = {
        id: `owner-${Date.now()}`,
        email: userEmail,
        name: userName,
        role: 'ADMIN',
        addedAt: new Date().toISOString(),
      };

      onUpdateSettings({
        googleSheetUrl: created.webViewLink,
        googleSheetName: created.name,
        lastSyncTime: nowStr,
        autoSync: true,
        currentRole: 'ADMIN',
        workspaceOwnerEmail: userEmail,
        members: userEmail ? [initialMember] : [],
        lastLocalLinkTimestamp: created.linkedTimestamp || new Date().toISOString(),
      });

      setGoogleSyncMessage(
        `✅ Đã tạo file "${created.name}" trên Google Drive và kích hoạt đồng bộ 2 chiều tự động (${nowStr}).`
      );
      await loadGoogleDriveFiles(accessToken);
    } catch (err: any) {
      setSyncErrorMessage(`Lỗi tạo file trên Google Drive: ${err.message}`);
    } finally {
      setIsCreatingNewFile(false);
    }
  };

  // Delete a specific file from Google Drive
  const handleDeleteDriveFile = async (e: React.MouseEvent, file: RealDriveFile) => {
    e.stopPropagation();
    if (!canChangeDriveFile(settings.currentRole)) {
      setSyncErrorMessage('🔒 Chỉ Admin mới có quyền xóa file trên Google Drive.');
      return;
    }

    const confirmDelete = await confirm({
      title: 'Xóa file trên Drive?',
      message: `Xóa vĩnh viễn "${file.name}". Không thể hoàn tác.`,
    });
    if (!confirmDelete) return;

    const token = await validateTokenOrPrompt();
    if (!token) return;

    setDeletingFileId(file.id);
    setSyncErrorMessage(null);
    try {
      await deleteRealGoogleDriveFile(token, file.id);

      // If deleted file was currently linked, clear link
      if (selectedFileId === file.id) {
        setSelectedFileId('');
        setSelectedFileName('');
        setSheetUrl('');
        onUpdateSettings({
          googleSheetUrl: '',
          googleSheetName: '',
        });
      }

      setGoogleSyncMessage(`Đã xóa file "${file.name}" khỏi Google Drive.`);
      await loadGoogleDriveFiles(token);
    } catch (err: any) {
      setSyncErrorMessage(`Lỗi khi xóa file: ${err.message}`);
    } finally {
      setDeletingFileId(null);
    }
  };

  // Safeguarded disconnect and clear
  const handleSafeguardedDisconnectAndClear = async () => {
    if (!canChangeDriveFile(settings.currentRole)) {
      setShowClearConfirm(false);
      setSyncErrorMessage('Chỉ Admin mới có thể hủy liên kết nhóm. Thành viên có thể rời nhóm trong mục Quản lý thành viên.');
      return;
    }

    onStartFileSwitch?.();
    setIsUnlinking(true);
    setSyncStatusStep('Đang hủy liên kết và làm sạch dữ liệu trên ứng dụng...');

    // Lấy File ID từ selectedFileId hoặc fallback qua settings.googleSheetUrl để đảm bảo tính chính xác tuyệt đối
    const currentUrl = settings.googleSheetUrl;
    let fileIdToUnlink = selectedFileId;
    if (!fileIdToUnlink && currentUrl) {
      const match = currentUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) || currentUrl.match(/id=([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        fileIdToUnlink = match[1];
      }
    }

    const token = accessToken || getGoogleAccessToken();
    let permissionFailures: string[] = [];

    if (token && fileIdToUnlink) {
      try {
        permissionFailures = await setMasterSyncUnlinked(
          token,
          currentUser?.email || appUser?.email,
          fileIdToUnlink
        );
      } catch (driveErr) {
        console.warn('Lỗi khi cập nhật trạng thái hủy trên Google Drive (tiếp tục dọn sạch cục bộ):', driveErr);
      }
    }

    // ĐẢM BẢO TUYỆT ĐỐI: Làm sạch toàn bộ dữ liệu nội bộ và ngắt liên kết trên thiết bị này
    onClearBooks();
    try {
      localStorage.setItem('savings_books_v3', JSON.stringify([]));
      localStorage.setItem('savings_settlements_v3', JSON.stringify([]));
      localStorage.setItem('savings_books_cleared', 'true');
      localStorage.removeItem('savings_master_pointer_file_id');
      localStorage.removeItem('savings_master_pointer_state');
      localStorage.removeItem('last_linked_file_id_v2');
      localStorage.removeItem('master_sync_state_local_v2');
      clearStaticHistoryFromStorage();
      setExplicitlyUnlinked(true);
    } catch (storageError) {
      console.warn('Không thể dọn toàn bộ dữ liệu cục bộ sau khi hủy liên kết:', storageError);
    }

    saveLocalMasterPointerFileId(null);
    saveLocalMasterPointerState(null);
    setExplicitlyUnlinked(true);

    if (onFinishFileSwitch) {
      onFinishFileSwitch([], [], '', '', '', '');
    }
    onUpdateSettings({
      googleSheetUrl: undefined,
      googleSheetName: undefined,
      lastSyncTime: undefined,
      lastLocalLinkTimestamp: undefined,
      autoSync: true,
      currentRole: 'ADMIN',
      workspaceOwnerEmail: currentUser?.email || appUser?.email || undefined,
      isPersonalWorkspace: true,
      members: [],
    });
    setSheetUrl('');
    setSelectedFileId('');
    setSelectedFileName('');
    setLastSyncTime(null);
    setShowClearConfirm(false);
    setIsChoosingDifferentFile(false);
    const nowStr = new Date().toLocaleString('vi-VN');
    setGoogleSyncMessage(
      permissionFailures.length
        ? `Đã hủy liên kết thành công. Chưa thu hồi được quyền Drive của: ${permissionFailures.join(', ')}.`
        : `✅ Đã hủy liên kết thành công. Dữ liệu trên Google Drive được giữ nguyên (${nowStr}).`
    );
    setIsUnlinking(false);
    setSyncStatusStep(null);
  };

  // CHẾ ĐỘ OFFLINE: Xuất bản sao lưu Excel về máy tính/điện thoại
  const handleExportBackup = async () => {
    try {
      const today = getVietnamDateISO();
      const annualHistory = getDynamicAnnualInterestHistory(books, settlements);
      const balanceHistory = getDynamicBalanceGrowthHistory(books, settlements);
      await exportSavingsBooksToExcel(books, `So_Tiet_Kiem_Backup_${today}.xlsx`, annualHistory, balanceHistory, settlements);
      setGoogleSyncMessage(`✅ Đã tải bản sao lưu Excel (.xlsx) về máy thành công.`);
    } catch (err: any) {
      setSyncErrorMessage('Lỗi khi xuất file sao lưu: ' + err.message);
    }
  };

  // CHẾ ĐỘ OFFLINE: Khôi phục dữ liệu từ file sao lưu trên máy (có cảnh báo chống xung đột ghi đè)
  const handleSelectOfflineFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Nếu app đang có dữ liệu, hiển thị cảnh báo xác nhận nạp đè
    if (books.length > 0) {
      setPendingOfflineFile(file);
      setShowOverwriteWarning(true);
    } else {
      executeImportOfflineFile(file);
    }
    e.target.value = '';
  };

  const executeImportOfflineFile = async (file: File) => {
    setSyncStatusStep('Đang đọc file sao lưu từ thiết bị...');
    setSyncErrorMessage(null);
    setShowOverwriteWarning(false);
    setPendingOfflineFile(null);
    try {
      const res = await parseExcelFile(file);
      if (res.success && res.books.length > 0) {
        onImportBooks(res.books, 'replace');
        setGoogleSyncMessage(`✅ Đã nạp thành công ${res.books.length} sổ tiết kiệm từ file "${file.name}"!`);
      } else {
        setSyncErrorMessage('File không hợp lệ hoặc không tìm thấy cấu trúc sổ tiết kiệm.');
      }
    } catch (err: any) {
      setSyncErrorMessage('Lỗi khi nạp file sao lưu: ' + err.message);
    } finally {
      setSyncStatusStep(null);
    }
  };

  if (!isOpen) return null;

  const isOnlineUser = Boolean(
    (appUser && !appUser.isOffline) ||
    Boolean(currentUser) ||
    Boolean(getGoogleAccessToken())
  );
  const totalPrincipal = books.reduce((sum, b) => sum + (b.principal || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/70 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center space-x-2.5 min-w-0">
            <span className={`p-1.5 rounded-lg shrink-0 ${
              isOnlineUser
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-amber-500/20 text-amber-400'
            }`}>
              {isOnlineUser ? <Cloud className="w-4 h-4" /> : <HardDrive className="w-4 h-4" />}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="text-sm font-bold text-white truncate">
                  {isOnlineUser ? 'Đồng Bộ Google Drive' : 'Dữ Liệu & Sao Lưu'}
                </h2>
                <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold shrink-0 ${
                  isOnlineUser ? 'bg-emerald-600 text-emerald-50' : 'bg-amber-500 text-slate-950'
                }`}>
                  {isOnlineUser ? 'Online' : 'Offline'}
                </span>
              </div>
              {isOnlineUser && (
                <p className="text-[11px] text-slate-400 truncate">
                  {appUser?.email || currentUser?.email || ''}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-3.5 sm:p-4 overflow-y-auto space-y-3 flex-1 text-xs">
          {/* LUỒNG DÀNH CHO USER ONLINE (GOOGLE DRIVE) */}
          {isOnlineUser ? (
            !sheetUrl || isChoosingDifferentFile ? (
              <div className="space-y-3">
                    {!canChangeDriveFile(settings.currentRole) && (
                      <div className="p-3 bg-sky-50 border border-sky-200 text-sky-900 rounded-xl text-[11px]">
                        Chọn một File liên kết đã được Admin chia sẻ với tài khoản Google này. Vai trò sẽ được xác định từ danh sách thành viên của Nhóm thành viên.
                      </div>
                    )}
                    {/* Nút tạo Google Sheet mới với tên tùy chọn */}
                    {canChangeDriveFile(settings.currentRole) && (
                      <button
                        onClick={() => {
                          setNewFileNameInput('So_Tiet_Kiem_Gia_Dinh');
                          setShowCreateFileDialog(true);
                        }}
                        disabled={isCreatingNewFile}
                        className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs transition-all flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-60 shadow-xs"
                      >
                        <Plus className="w-4 h-4 text-emerald-200" />
                        <span>Tạo Google Sheet mới trên Drive</span>
                      </button>
                    )}

                    {/* Danh sách file khả dụng trên Drive (drive.file) */}
                    <div className="space-y-2 bg-slate-50 p-2.5 sm:p-3 rounded-xl border border-slate-200">
                      <div className="flex items-center justify-between text-[11px] text-slate-700 font-bold px-0.5">
                        <span className="flex items-center gap-1.5">
                          <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Bảng tính trên Drive ({realFiles.length})</span>
                        </span>
                        <button
                          type="button"
                          disabled={isLoadingFiles || isAuthenticating}
                          onClick={handleRefreshDriveFiles}
                          className="text-slate-500 hover:text-emerald-700 p-1 rounded cursor-pointer transition-colors"
                          title="Tải lại danh sách"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingFiles ? 'animate-spin text-emerald-600' : ''}`} />
                        </button>
                      </div>

                      {/* File Items */}
                      {isLoadingFiles ? (
                        <div className="py-6 text-center text-slate-500 space-y-1.5 bg-white rounded-lg border border-slate-100">
                          <p className="text-[11px]">Đang tải danh sách file...</p>
                        </div>
                      ) : realFiles.length > 0 ? (
                        <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden bg-white max-h-52 overflow-y-auto">
                          {realFiles.map((file) => {
                            const isSelected = selectedFileId === file.id;
                            return (
                              <div
                                key={file.id}
                                onClick={() => handleSelectRealFile(file)}
                                className={`p-2.5 flex items-center justify-between cursor-pointer transition-colors ${
                                  isSelected ? 'bg-emerald-50/90 border-l-4 border-l-emerald-600' : 'hover:bg-slate-50'
                                }`}
                              >
                                <div className="flex items-center space-x-2 min-w-0 pr-2">
                                  <span className="p-1 bg-emerald-100 text-emerald-700 rounded-md shrink-0">
                                    <FileSpreadsheet className="w-3.5 h-3.5" />
                                  </span>
                                  <div className="min-w-0">
                                    <div className="font-semibold text-slate-900 text-xs truncate" title={file.name}>
                                      {file.name}
                                    </div>
                                    <div className="text-[10px] text-slate-500">
                                      {file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString('vi-VN') : ''}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center space-x-1.5 shrink-0">
                                  {canChangeDriveFile(settings.currentRole) && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleDeleteDriveFile(e, file)}
                                      disabled={deletingFileId === file.id}
                                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                                      title="Xóa file khỏi Google Drive"
                                    >
                                      {deletingFileId === file.id ? (
                                        <RefreshCw className="w-3.5 h-3.5 animate-spin text-rose-600" />
                                      ) : (
                                        <Trash2 className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                  )}
                                  <span className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-bold text-[10px] shrink-0 transition-colors">
                                    {isSelected ? 'Đang dùng' : 'Chọn'}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="py-4 px-2 text-center bg-white rounded-lg border border-dashed border-slate-200 space-y-1">
                          <p className="text-[11px] font-medium text-slate-600">Chưa có file bảng tính nào trên Drive</p>
                          <p className="text-[10px] text-slate-400">Bấm nút ở trên để tạo file mới</p>
                        </div>
                      )}
                    </div>

                    {/* Khu vực Chọn file từ máy & Xuất Excel */}
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800 text-xs flex items-center gap-1.5">
                          <HardDrive className="w-3.5 h-3.5 text-slate-600" />
                          <span>Dữ liệu trên máy</span>
                        </span>
                        <span className="text-[9px] font-bold text-slate-500 bg-slate-200 px-1.5 py-0.2 rounded">Thiết bị</span>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex items-center justify-center space-x-1.5 py-2 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs cursor-pointer shadow-2xs">
                          <Upload className="w-3.5 h-3.5 text-white" />
                          <span>Nhập file từ máy</span>
                          <input type="file" accept=".xlsx,.xls,.csv" onChange={handleSelectOfflineFile} className="hidden" />
                        </label>
                        <button
                          type="button"
                          onClick={handleExportBackup}
                          className="flex items-center justify-center space-x-1.5 py-2 px-2.5 rounded-lg bg-white hover:bg-slate-100 active:scale-[0.98] text-slate-700 border border-slate-300 font-semibold text-xs cursor-pointer shadow-2xs"
                        >
                          <Download className="w-3.5 h-3.5 text-slate-500" />
                          <span>Xuất file Excel</span>
                        </button>
                      </div>
                    </div>

              </div>
            ) : (
              /* KHI ĐÃ LIÊN KẾT VỚI FILE DRIVE */
              <div className="space-y-3">
                <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                  {fileIsDeleted ? (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-rose-900 text-xs space-y-2">
                      <div className="flex items-center gap-1.5 font-bold">
                        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        <span>File trên Drive đã bị xóa!</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setNewFileNameInput('So_Tiet_Kiem_Gia_Dinh');
                            setShowCreateFileDialog(true);
                          }}
                          disabled={isCreatingNewFile}
                          className="flex-1 py-1.5 px-2 bg-emerald-600 text-white rounded-lg font-bold text-xs"
                        >
                          Tạo file mới
                        </button>
                        <button
                          onClick={() => {
                            setIsChoosingDifferentFile(true);
                            setSelectedFileId('');
                            handleRefreshDriveFiles();
                          }}
                          className="flex-1 py-1.5 px-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-bold text-xs"
                        >
                          Chọn từ danh sách
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center space-x-2 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                            <FileSpreadsheet className="w-4 h-4" />
                          </div>
                          <h4 className="font-bold text-slate-900 text-xs truncate" title={selectedFileName || 'So_tiet_kiem'}>
                            {selectedFileName || 'So_tiet_kiem'}
                          </h4>
                        </div>
                        <div className="flex items-center space-x-1 shrink-0">
                          <button
                            type="button"
                            onClick={handleManualSyncClick}
                            disabled={isManualSyncing || isFetchingFileName}
                            className="inline-flex items-center space-x-1 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-white rounded border border-slate-200 cursor-pointer"
                          >
                            <RefreshCw className={`w-3 h-3 ${isManualSyncing || isFetchingFileName ? 'animate-spin text-emerald-600' : ''}`} />
                            <span>{!hasGoogleToken ? 'Cấp quyền' : 'Đồng bộ'}</span>
                          </button>
                          <a
                            href={sheetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center space-x-0.5 px-2 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded border border-emerald-200"
                          >
                            <span>Mở</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </div>
                      </div>

                      {!hasGoogleToken && (
                        <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-[11px] flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          <span>Phiên hết hạn. Bấm <strong>&quot;Cấp quyền&quot;</strong> để đồng bộ.</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5">
                        <span className="text-emerald-700 font-medium flex items-center gap-1">
                          <CheckCircle className="w-3 h-3 text-emerald-600" />
                          <span>Đồng bộ 2 chiều</span>
                        </span>
                        {lastSyncTime && <span>Cập nhật: <strong className="text-slate-700">{lastSyncTime}</strong></span>}
                      </div>

                      {canChangeDriveFile(settings.currentRole) ? (
                        <div className="grid grid-cols-2 gap-2 pt-1">
                          <button
                            id="btn-link-google-drive"
                            onClick={() => {
                              setIsChoosingDifferentFile(true);
                              setSelectedFileId(null);
                              setGoogleSyncMessage(null);
                              setSyncErrorMessage(null);
                            }}
                            className="w-full py-2 px-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1 border bg-white hover:bg-slate-100 text-slate-700 border-slate-200 cursor-pointer"
                          >
                            <Link2 className="w-3.5 h-3.5 text-slate-500" />
                            <span>Đổi file liên kết</span>
                          </button>

                          <button
                            id="btn-unlink-and-clear-data"
                            onClick={() => setShowClearConfirm(true)}
                            className="w-full py-2 px-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1 border bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200 cursor-pointer"
                          >
                            <Unlink className="w-3.5 h-3.5 text-rose-600" />
                            <span>Hủy liên kết</span>
                          </button>
                        </div>
                      ) : (
                        <p className="pt-1 text-[10px] text-slate-500">
                          Admin quản lý liên kết nhóm. Thành viên có thể rời nhóm trong mục Quản lý thành viên.
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* Khu vực Chọn file từ máy & Xuất Excel khi đã liên kết */}
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-800 text-xs flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5 text-slate-600" />
                      <span>Dữ liệu trên máy</span>
                    </span>
                    <span className="text-[9px] font-bold text-slate-500 bg-slate-200 px-1.5 py-0.2 rounded">Thiết bị</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center justify-center space-x-1.5 py-2 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs cursor-pointer shadow-2xs">
                      <Upload className="w-3.5 h-3.5 text-white" />
                      <span>Nhập file từ máy</span>
                      <input type="file" accept=".xlsx,.xls,.csv" onChange={handleSelectOfflineFile} className="hidden" />
                    </label>
                    <button
                      type="button"
                      onClick={handleExportBackup}
                      className="flex items-center justify-center space-x-1.5 py-2 px-2.5 rounded-lg bg-white hover:bg-slate-100 active:scale-[0.98] text-slate-700 border border-slate-300 font-semibold text-xs cursor-pointer shadow-2xs"
                    >
                      <Download className="w-3.5 h-3.5 text-slate-500" />
                      <span>Xuất file Excel</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            /* LUỒNG DÀNH CHO USER OFFLINE */
            <div className="space-y-2.5">
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-900 text-xs">Đồng bộ Online Google Drive</h4>
                  <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-600 text-white">Drive</span>
                </div>
                <button
                  onClick={handleSignInGoogle}
                  disabled={isAuthenticating}
                  className="w-full py-2.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-60"
                >
                  {isAuthenticating ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Đang đăng nhập...</span>
                    </>
                  ) : (
                    <>
                      <Globe className="w-3.5 h-3.5" />
                      <span>Đăng nhập Google</span>
                    </>
                  )}
                </button>
              </div>

              {/* Offline File Management */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-800 text-xs flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5 text-slate-600" />
                    Sao lưu trên máy
                  </span>
                  <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.2 rounded">Offline</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleExportBackup}
                    className="flex items-center justify-center space-x-1 py-2 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Tải file .xlsx</span>
                  </button>
                  <label className="flex items-center justify-center space-x-1 py-2 px-2.5 rounded-lg bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 font-semibold text-xs cursor-pointer">
                    <Upload className="w-3.5 h-3.5 text-slate-500" />
                    <span>Nạp file .xlsx</span>
                    <input type="file" accept=".xlsx,.xls" onChange={handleSelectOfflineFile} className="hidden" />
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Trạng thái xử lý hoặc thông báo */}
          {syncStatusStep && (
            <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg flex items-center space-x-2 text-[11px] animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />
              <span className="font-medium">{syncStatusStep}</span>
            </div>
          )}

          {googleSyncMessage && (
            <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-950 rounded-lg flex items-start space-x-2 text-[11px]">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
              <span className="font-medium leading-relaxed">{googleSyncMessage}</span>
            </div>
          )}

          {syncErrorMessage && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-950 rounded-xl space-y-1.5 text-[11px]">
              <div className="flex items-start space-x-2">
                <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                <span className="font-medium leading-relaxed flex-1">{syncErrorMessage}</span>
              </div>
              {(syncErrorMessage.toLowerCase().includes('popup') ||
                syncErrorMessage.toLowerCase().includes('chặn') ||
                syncErrorMessage.toLowerCase().includes('đăng nhập')) && (
                <div className="pt-1 flex flex-wrap gap-2 border-t border-rose-200/80">
                  <button
                    type="button"
                    onClick={() => window.open(window.location.href, '_blank')}
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-[10px] flex items-center space-x-1 cursor-pointer shadow-xs"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>Mở ở Tab mới</span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await signInWithGoogleRedirect();
                      } catch (e: any) {
                        setSyncErrorMessage(e?.message || 'Không thể đăng nhập chuyển hướng.');
                      }
                    }}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded-lg font-bold text-[10px] flex items-center space-x-1 cursor-pointer shadow-xs"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Đăng nhập Redirect</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-semibold cursor-pointer"
          >
            Đóng
          </button>
        </div>
      </div>

      {/* DIALOG TẠO FILE TRÊN DRIVE VỚI TÊN TÙY CHỌN */}
      {showCreateFileDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-xs">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center space-x-3">
              <span className="p-2.5 bg-emerald-100 text-emerald-700 rounded-xl">
                <FileSpreadsheet className="w-6 h-6" />
              </span>
              <div>
                <h3 className="font-bold text-slate-900 text-base">Tạo File Mới Trên Google Drive</h3>
                <p className="text-xs text-slate-500">Đặt tên tùy thích cho file bảng tính của bạn</p>
              </div>
            </div>

            <div className="space-y-2 text-xs">
              <label className="font-bold text-slate-800 block">Tên file muốn tạo:</label>
              <input
                type="text"
                value={newFileNameInput}
                onChange={(e) => setNewFileNameInput(e.target.value)}
                placeholder="So_tiet_kiem"
                className="w-full px-3 py-2.5 border border-slate-300 rounded-xl font-mono text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                disabled={isCreatingNewFile}
                onClick={() => setShowCreateFileDialog(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold cursor-pointer"
              >
                Hủy
              </button>
              <button
                disabled={isCreatingNewFile || !newFileNameInput.trim()}
                onClick={handleCreateNewDriveFile}
                className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold shadow-sm disabled:opacity-50 cursor-pointer"
              >
                {isCreatingNewFile ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Đang tạo trên Drive...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    <span>Tạo &amp; Liên kết</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Confirmation Modal */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 p-6 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center space-x-3">
              <span className="p-3 bg-rose-100 text-rose-600 rounded-xl">
                <Trash2 className="w-6 h-6" />
              </span>
              <div>
                <h3 className="font-bold text-slate-900 text-base">Hủy Liên Kết &amp; Dọn Sạch Dữ Liệu</h3>
                <p className="text-xs text-slate-500">Tự động sao lưu lên Google Drive trước khi dọn dẹp</p>
              </div>
            </div>

            <div className="space-y-3 text-xs leading-relaxed text-slate-700 bg-rose-50 p-4 rounded-xl border border-rose-200">
              <div className="flex items-start space-x-2 text-rose-950 font-bold">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>Cam kết bảo vệ dữ liệu Google Drive của bạn:</span>
              </div>
              <p className="text-slate-800">
                1. Hệ thống sẽ tự động cập nhật và sao lưu toàn bộ sổ tiết kiệm lên Google Drive của bạn trước.
              </p>
              <p className="text-slate-800">
                2. Sau khi đã đẩy dữ liệu an toàn lên Drive, ứng dụng mới làm sạch 100% dữ liệu nội bộ trên thiết bị của bạn.
              </p>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                disabled={isUnlinking}
                onClick={() => setShowClearConfirm(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                disabled={isUnlinking}
                onClick={handleSafeguardedDisconnectAndClear}
                className="flex items-center space-x-1.5 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-sm transition-all disabled:opacity-50"
              >
                {isUnlinking ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Đang sao lưu &amp; Dọn sạch...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    <span>Sao Lưu &amp; Dọn Sạch Dữ Liệu</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Offline Overwrite Confirmation Modal */}
      {showOverwriteWarning && pendingOfflineFile && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-xs">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-amber-300 p-5 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center space-x-3">
              <span className="p-2.5 bg-amber-100 text-amber-700 rounded-xl">
                <AlertTriangle className="w-6 h-6" />
              </span>
              <div>
                <h3 className="font-bold text-slate-900 text-base">Xác Nhận Nạp File Đè Dữ Liệu</h3>
                <p className="text-xs text-slate-500">Bảo vệ dữ liệu, tránh mất mát thông tin</p>
              </div>
            </div>

            <div className="p-3.5 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-900 space-y-2 leading-relaxed">
              <p className="font-bold">
                ⚠️ Ứng dụng hiện đang có sẵn {books.length} sổ tiết kiệm ({formatVND(totalPrincipal)}).
              </p>
              <p>
                Việc nạp file <strong>"{pendingOfflineFile.name}"</strong> từ máy tính/điện thoại sẽ <strong>THAY THẾ TOÀN BỘ</strong> danh sách sổ hiện tại trên app.
              </p>
              <p className="text-[11px] text-amber-800">
                Nếu bạn muốn giữ lại dữ liệu hiện tại, vui lòng bấm "Hủy bỏ" và bấm "Tải bản sao lưu về máy" trước khi tiếp tục.
              </p>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => {
                  setShowOverwriteWarning(false);
                  setPendingOfflineFile(null);
                }}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs"
              >
                Hủy bỏ
              </button>
              <button
                onClick={() => pendingOfflineFile && executeImportOfflineFile(pendingOfflineFile)}
                className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-xs"
              >
                Xác Nhận Nạp Đè
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
